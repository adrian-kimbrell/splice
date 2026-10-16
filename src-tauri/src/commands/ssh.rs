//! Tauri commands for SSH remote workspace access.
//!
//! Uses the `openssh` crate (ControlMaster multiplexing) to maintain one persistent SSH
//! connection per workspace, stored in `AppState::ssh_sessions` as `Arc<openssh::Session>`.
//!
//! Commands: ssh_connect, ssh_disconnect, sftp_list_dir, sftp_read_file, sftp_write_file,
//! ssh_ping.
//!
//! `ssh_connect` respects `~/.ssh/config` — user/port/keyfile are only overridden when
//! explicitly set in `SshConfig` (non-empty / non-default). `get_session` clones the
//! `Arc<Session>` out of the state lock so SFTP commands can await without holding the mutex.
//!
//! SSH terminals use a different path: `spawn_terminal` is called with `extra_args` built
//! from `SshConfig` (ssh binary is in ALLOWED_SHELLS). SFTP is used only for the file tree
//! and editor read/write in remote workspaces.

use crate::commands::fs::FileEntry;
use crate::state::AppState;
use crate::workspace::layout::SshConfig;
use openssh::{KnownHosts, Session, SessionBuilder};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::State;

/// Extract an Arc-cloned session from state without holding the lock.
fn get_session(
    state: &Mutex<AppState>,
    workspace_id: &str,
) -> Result<Arc<Session>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    guard
        .ssh_sessions
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| format!("No SSH session for workspace '{}'", workspace_id))
}

/// Expand a leading `~` to the home directory (ssh binary doesn't do this for -i).
fn expand_tilde(path: &str) -> std::path::PathBuf {
    if path.starts_with('~') {
        if let Some(home) = dirs::home_dir() {
            let rest = path.trim_start_matches('~').trim_start_matches('/');
            return if rest.is_empty() { home } else { home.join(rest) };
        }
    }
    std::path::PathBuf::from(path)
}

/// Upper bound for a single remote command (listing, cat, write, ping). The UI
/// awaits these; without a bound a stalled connection hung it indefinitely.
const REMOTE_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

async fn bounded<T, E: std::fmt::Display>(
    what: &str,
    fut: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, String> {
    match tokio::time::timeout(REMOTE_CMD_TIMEOUT, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("{} failed: {}", what, e)),
        Err(_) => Err(format!("{} timed out after {}s", what, REMOTE_CMD_TIMEOUT.as_secs())),
    }
}

/// Establish an SSH ControlMaster session and store it keyed by workspace_id.
/// Fields in `config` that are empty/default are omitted so `~/.ssh/config` takes precedence.
#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, Mutex<AppState>>,
    workspace_id: String,
    config: SshConfig,
) -> Result<(), String> {
    // A host or user beginning with "-" would be parsed by ssh as an option
    // (-oProxyCommand=… runs a local command). Only reachable from the user's own
    // form or workspace file, but refuse it anyway.
    if config.host.starts_with('-') || config.user.starts_with('-') || config.host.is_empty() {
        return Err("Invalid SSH host or user".to_string());
    }

    let mut builder = SessionBuilder::default();

    // Only override user/port/keyfile if explicitly provided — otherwise let ~/.ssh/config handle them.
    if !config.user.is_empty() {
        builder.user(config.user.clone());
    }
    if config.port != 22 {
        builder.port(config.port);
    }
    if !config.key_path.is_empty() {
        builder.keyfile(expand_tilde(&config.key_path));
    }

    builder.known_hosts_check(KnownHosts::Accept);
    builder.connect_timeout(std::time::Duration::from_secs(20));
    // Detect a dead network path: without keepalives a dropped connection left the
    // ControlMaster "alive" and every remote command blocked until TCP gave up.
    builder.server_alive_interval(std::time::Duration::from_secs(15));

    let session = Arc::new(
        builder
            .connect(&config.host)
            .await
            .map_err(|e| format!("SSH connect failed: {}", e))?,
    );

    // Best-effort: install the remote attention hook so a Claude run on this host
    // can signal Splice in-band (OSC 7379). Non-blocking so it never delays connect;
    // failures (no python3, read-only home) are logged and ignored.
    {
        let sess = Arc::clone(&session);
        tauri::async_runtime::spawn(async move {
            match crate::attention::ssh_hook::install_on_session(sess.as_ref()).await {
                Ok(msg) => tracing::info!("SSH attention hook: {}", msg),
                Err(e) => tracing::warn!("SSH attention hook not installed: {}", e),
            }
        });
    }

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.ssh_sessions.insert(workspace_id, session);
    Ok(())
}

/// Remove and close the SSH session for the given workspace.
#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, Mutex<AppState>>,
    workspace_id: String,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.ssh_sessions.remove(&workspace_id);
    Ok(())
}

/// List a remote directory. Returns the same FileEntry shape as read_dir_tree.
/// Directories get `children: Some([])` (lazy-load sentinel); files get `children: None`.
#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, Mutex<AppState>>,
    workspace_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let session = get_session(&state, &workspace_id)?;

    // Expand ~ via remote shell
    let expanded = if path.starts_with('~') {
        let out = bounded("sftp_list_dir home lookup", session.command("sh").args(["-c", "echo $HOME"]).output()).await?;
        let home = String::from_utf8_lossy(&out.stdout).trim().to_string();
        path.replacen('~', &home, 1)
    } else {
        path.clone()
    };

    // Get all entries (one per line)
    let all_out = bounded(
        "sftp_list_dir find",
        session.command("find").args([expanded.as_str(), "-maxdepth", "1", "-mindepth", "1"]).output(),
    )
    .await?;

    // Get only directories to classify entries
    let dir_out = bounded(
        "sftp_list_dir find -type d",
        session
            .command("find")
            .args([expanded.as_str(), "-maxdepth", "1", "-mindepth", "1", "-type", "d"])
            .output(),
    )
    .await?;

    // `lines()` already strips the newline; trimming further would mangle names
    // with leading/trailing whitespace and misclassify them.
    let dirs: std::collections::HashSet<String> = String::from_utf8_lossy(&dir_out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();

    let mut entries: Vec<FileEntry> = String::from_utf8_lossy(&all_out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .map(|entry_path| {
            let name = Path::new(&entry_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&entry_path)
                .to_string();
            let is_dir = dirs.contains(&entry_path);
            FileEntry {
                name,
                path: entry_path,
                is_dir,
                children: if is_dir { Some(vec![]) } else { None },
            }
        })
        .collect();

    // Directories first, then files; alphabetical within each group
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Read a remote file's content as a UTF-8 string.
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, Mutex<AppState>>,
    workspace_id: String,
    path: String,
) -> Result<String, String> {
    let session = get_session(&state, &workspace_id)?;

    let out = bounded("sftp_read_file", session.command("cat").arg("--").arg(path.as_str()).output()).await?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Remote cat failed: {}", err.trim()));
    }

    String::from_utf8(out.stdout)
        .map_err(|_| "Remote file is not valid UTF-8".to_string())
}

/// Write content to a remote file by streaming it over the command's stdin.
///
/// The previous approach embedded the whole file as a base64 literal in the
/// command line; sshd runs that as a single `sh -c` argument, which Linux caps at
/// 128 KiB, so saves above ~96 KB of text failed on every Linux host.
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, Mutex<AppState>>,
    workspace_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let session = get_session(&state, &workspace_id)?;

    // Shell-quote the path (single-quote escaping)
    let quoted_path = format!("'{}'", path.replace('\'', "'\\''"));
    let cmd = format!("cat > {}", quoted_path);

    let mut child = bounded(
        "sftp_write_file spawn",
        session.command("sh").args(["-c", cmd.as_str()]).stdin(openssh::Stdio::piped()).spawn(),
    )
    .await?;

    {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin().take().ok_or("sftp_write_file: no stdin pipe")?;
        bounded("sftp_write_file write", stdin.write_all(content.as_bytes())).await?;
        bounded("sftp_write_file flush", stdin.shutdown()).await?;
        // Dropping stdin sends EOF so `cat` finishes.
    }

    let status = bounded("sftp_write_file", child.wait()).await?;
    if !status.success() {
        return Err("Remote write failed (non-zero exit from sh)".to_string());
    }

    Ok(())
}

/// Return true if the SSH session is still alive.
#[tauri::command]
pub async fn ssh_ping(
    state: State<'_, Mutex<AppState>>,
    workspace_id: String,
) -> Result<bool, String> {
    let session = get_session(&state, &workspace_id)?;
    match bounded("ssh_ping", session.command("true").status()).await {
        Ok(s) => Ok(s.success()),
        Err(_) => Ok(false),
    }
}
