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

/// Establish an SSH ControlMaster session and store it keyed by workspace_id.
/// Fields in `config` that are empty/default are omitted so `~/.ssh/config` takes precedence.
#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, Mutex<AppState>>,
    workspace_id: String,
    config: SshConfig,
) -> Result<(), String> {
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

    let session = builder
        .connect(&config.host)
        .await
        .map_err(|e| format!("SSH connect failed: {}", e))?;

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    guard.ssh_sessions.insert(workspace_id, Arc::new(session));
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
        let out = session
            .command("sh")
            .args(["-c", "echo $HOME"])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        let home = String::from_utf8_lossy(&out.stdout).trim().to_string();
        path.replacen('~', &home, 1)
    } else {
        path.clone()
    };

    // Get all entries (one per line)
    let all_out = session
        .command("find")
        .args([expanded.as_str(), "-maxdepth", "1", "-mindepth", "1"])
        .output()
        .await
        .map_err(|e| format!("sftp_list_dir find failed: {}", e))?;

    // Get only directories to classify entries
    let dir_out = session
        .command("find")
        .args([
            expanded.as_str(),
            "-maxdepth",
            "1",
            "-mindepth",
            "1",
            "-type",
            "d",
        ])
        .output()
        .await
        .map_err(|e| format!("sftp_list_dir find -type d failed: {}", e))?;

    let dirs: std::collections::HashSet<String> = String::from_utf8_lossy(&dir_out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let mut entries: Vec<FileEntry> = String::from_utf8_lossy(&all_out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
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

    let out = session
        .command("cat")
        .arg(path.as_str())
        .output()
        .await
        .map_err(|e| format!("sftp_read_file failed: {}", e))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Remote cat failed: {}", err.trim()));
    }

    String::from_utf8(out.stdout)
        .map_err(|_| "Remote file is not valid UTF-8".to_string())
}

/// Write content to a remote file via base64-encoded echo + decode pipeline.
/// Works for files up to ~1 MB; suitable for source code files.
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, Mutex<AppState>>,
    workspace_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let session = get_session(&state, &workspace_id)?;

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());

    // Shell-quote the path (single-quote escaping)
    let quoted_path = format!("'{}'", path.replace('\'', "'\\''"));

    // Use printf + base64 --decode to write the file; avoids stdin lifecycle complexity
    let cmd = format!("printf '%s' '{}' | base64 --decode > {}", encoded, quoted_path);

    let status = session
        .command("sh")
        .args(["-c", cmd.as_str()])
        .status()
        .await
        .map_err(|e| format!("sftp_write_file spawn failed: {}", e))?;

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
    match session.command("true").status().await {
        Ok(s) => Ok(s.success()),
        Err(_) => Ok(false),
    }
}
