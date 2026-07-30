//! One SSH connection to a remote workspace, in the two forms the platforms allow.
//!
//! Despite the `sftp_*` command names, nothing here speaks the SFTP protocol — every
//! remote operation is a command run over the connection (`find`, `cat`,
//! `printf | base64 -d`, `true`) whose stdout is parsed. That means the platform
//! difference is narrow enough to hide behind two methods:
//!
//! - **Unix** keeps the `openssh` crate, which multiplexes over an ssh ControlMaster:
//!   one authentication, then every later command rides the existing connection.
//! - **Windows** runs its bundled OpenSSH client per command. Win32-OpenSSH has no
//!   ControlMaster (it needs Unix domain sockets), so each call reconnects — slower,
//!   and it wants key auth or a running ssh-agent to stay non-interactive, but it
//!   needs no third-party SSH stack.
//!
//! `run` is deliberately the only way to reach the remote: both platforms take an
//! argv, and both shell-quote it, so a path with a space behaves the same either way.

use crate::workspace::layout::SshConfig;

/// Result of a remote command. Mirrors the parts of `std::process::Output` used here.
pub struct RemoteOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub success: bool,
}

/// Quote one argument for a POSIX remote shell.
///
/// Both transports hand the remote sshd a single command string that the login shell
/// re-parses, so an unquoted path containing a space arrives as two arguments.
pub fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

/// Expand a leading `~` to the home directory (the ssh binary doesn't do this for -i).
pub fn expand_tilde(path: &str) -> std::path::PathBuf {
    if path.starts_with('~') {
        if let Some(home) = dirs::home_dir() {
            let rest = path.trim_start_matches('~').trim_start_matches('/');
            return if rest.is_empty() { home } else { home.join(rest) };
        }
    }
    std::path::PathBuf::from(path)
}

// ─── Unix: multiplexed openssh session ────────────────────────────────────────

#[cfg(not(windows))]
pub struct RemoteSession {
    session: openssh::Session,
}

#[cfg(not(windows))]
impl RemoteSession {
    /// Establish a ControlMaster session. Fields left empty/default in `config` are
    /// omitted so `~/.ssh/config` keeps precedence.
    pub async fn connect(config: &SshConfig) -> Result<Self, String> {
        use openssh::{KnownHosts, SessionBuilder};

        let mut builder = SessionBuilder::default();
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
        Ok(Self { session })
    }

    /// Run `argv` on the remote host and collect its output.
    pub async fn run(&self, argv: &[&str]) -> Result<RemoteOutput, String> {
        let script = argv
            .iter()
            .map(|a| shell_quote(a))
            .collect::<Vec<_>>()
            .join(" ");
        self.run_script(&script).await
    }

    /// Run a shell script verbatim on the remote host (already-quoted pipelines).
    pub async fn run_script(&self, script: &str) -> Result<RemoteOutput, String> {
        let out = self
            .session
            .command("sh")
            .args(["-c", script])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        Ok(RemoteOutput {
            stdout: out.stdout,
            stderr: out.stderr,
            success: out.status.success(),
        })
    }
}

// ─── Windows: one ssh.exe invocation per command ──────────────────────────────

#[cfg(windows)]
pub struct RemoteSession {
    args: Vec<String>,
}

#[cfg(windows)]
impl RemoteSession {
    /// Build the ssh.exe argument list once and verify the host is reachable.
    ///
    /// There is no persistent connection to hold: without ControlMaster each command
    /// authenticates again, so "connect" means "prove this config works", which keeps
    /// the failure visible at connect time instead of on the first directory listing.
    pub async fn connect(config: &SshConfig) -> Result<Self, String> {
        let mut args: Vec<String> = Vec::new();
        if config.port != 22 {
            args.push("-p".into());
            args.push(config.port.to_string());
        }
        if !config.key_path.is_empty() {
            args.push("-i".into());
            args.push(expand_tilde(&config.key_path).to_string_lossy().into_owned());
        }
        // Matches KnownHosts::Accept on the Unix path: trust on first use, but still
        // refuse a host whose key has changed.
        args.push("-o".into());
        args.push("StrictHostKeyChecking=accept-new".into());
        // Never stop at an interactive password prompt — there is no terminal attached
        // to answer it, so the command would hang instead of failing.
        args.push("-o".into());
        args.push("BatchMode=yes".into());
        args.push("-o".into());
        args.push("ConnectTimeout=20".into());
        args.push(if config.user.is_empty() {
            config.host.clone()
        } else {
            format!("{}@{}", config.user, config.host)
        });

        let session = Self { args };
        let probe = session.run_script("true").await?;
        if !probe.success {
            let err = String::from_utf8_lossy(&probe.stderr);
            return Err(format!("SSH connect failed: {}", err.trim()));
        }
        Ok(session)
    }

    pub async fn run(&self, argv: &[&str]) -> Result<RemoteOutput, String> {
        let script = argv
            .iter()
            .map(|a| shell_quote(a))
            .collect::<Vec<_>>()
            .join(" ");
        self.run_script(&script).await
    }

    pub async fn run_script(&self, script: &str) -> Result<RemoteOutput, String> {
        use crate::process_ext::NoWindow;

        let mut cmd = tokio::process::Command::new("ssh.exe");
        cmd.args(&self.args);
        cmd.arg(script);
        cmd.no_window();

        let out = cmd
            .output()
            .await
            .map_err(|e| format!("ssh.exe failed to run (is OpenSSH installed?): {}", e))?;
        Ok(RemoteOutput {
            stdout: out.stdout,
            stderr: out.stderr,
            success: out.status.success(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths_with_spaces() {
        assert_eq!(shell_quote("/home/me/My Code"), "'/home/me/My Code'");
    }

    #[test]
    fn quotes_embedded_single_quotes() {
        // The classic '\'' dance — closing the quote, escaping one, reopening.
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn quoting_blocks_command_injection() {
        // A path is data, never a place to smuggle a second command.
        let quoted = shell_quote("/tmp/x; rm -rf ~");
        assert_eq!(quoted, "'/tmp/x; rm -rf ~'");
        assert!(!quoted.contains("; rm") || quoted.starts_with('\''));
    }

    #[test]
    fn expands_leading_tilde() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_tilde("~/.ssh/id_ed25519"), home.join(".ssh/id_ed25519"));
        assert_eq!(expand_tilde("~"), home);
        // An absolute path is left exactly as given.
        assert_eq!(expand_tilde("/etc/ssh/key"), std::path::PathBuf::from("/etc/ssh/key"));
    }
}
