use crate::state::{validate_path, AppState};
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn reveal_in_file_manager(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.args(["-R", &canonical.to_string_lossy()]);
        c
    };
    // explorer.exe wants a native path and the odd `/select,<path>` comma syntax.
    // It also returns exit code 1 on success, so the status is deliberately ignored.
    #[cfg(windows)]
    let mut cmd = {
        use crate::process_ext::NoWindow;
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(format!("/select,{}", canonical.to_string_lossy().replace('/', "\\")));
        c.no_window();
        c
    };
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let mut cmd = {
        // Linux: no "select the file" equivalent that's portable across file managers,
        // so open the containing directory instead.
        let dir = if canonical.is_dir() { canonical.as_path() } else {
            canonical.parent().unwrap_or(canonical.as_path())
        };
        let mut c = std::process::Command::new("xdg-open");
        c.arg(dir);
        c
    };

    cmd.spawn()
        .map_err(|e| format!("Failed to reveal in file manager: {}", e))?;
    Ok(())
}

/// Save raw bytes to a timestamped file in the system temp directory and return
/// the absolute path. Used for clipboard image paste: the frontend reads image
/// data from the ClipboardEvent, sends it here, and types the returned path
/// into the terminal so the user can reference it in a Claude prompt.
///
/// The extension is sanitised to alphanumeric only (max 10 chars) so the caller
/// cannot inject a malicious filename component.
#[tauri::command]
pub fn save_temp_image(data: Vec<u8>, ext: String) -> Result<String, String> {
    let clean_ext: String = ext.chars().filter(|c| c.is_alphanumeric()).take(10).collect();
    let ext_str = if clean_ext.is_empty() { "png".to_string() } else { clean_ext };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = std::env::temp_dir().join(format!("clipboard-{}.{}", ts, ext_str));
    std::fs::write(&path, &data)
        .map_err(|e| format!("Failed to save clipboard image: {}", e))?;
    Ok(crate::state::to_ui_path(&path))
}

/// Save a screenshot PNG to docs/screenshots/ in the project directory.
/// Filename is timestamp-based to avoid collisions.
#[tauri::command]
pub fn save_screenshot(data: Vec<u8>) -> Result<String, String> {
    let project_dir = std::env::current_dir()
        .map_err(|e| format!("Failed to get current dir: {}", e))?;
    let screenshots_dir = project_dir.join("docs").join("screenshots");
    std::fs::create_dir_all(&screenshots_dir)
        .map_err(|e| format!("Failed to create screenshots dir: {}", e))?;
    let ts = chrono_timestamp();
    let path = screenshots_dir.join(format!("screenshot-{}.png", ts));
    std::fs::write(&path, &data)
        .map_err(|e| format!("Failed to save screenshot: {}", e))?;
    Ok(crate::state::to_ui_path(&path))
}

fn chrono_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    // Simple ISO-ish timestamp from epoch seconds
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    // Approximate date (good enough for filenames)
    let y = 1970 + days / 365;
    let d = days % 365;
    let mo = d / 30 + 1;
    let day = d % 30 + 1;
    format!("{:04}-{:02}-{:02}_{:02}-{:02}-{:02}", y, mo, day, h, m, s)
}

/// Write text to the system clipboard via an OS-level tool.
/// Going through the OS bypasses WKWebView's user-gesture requirement that
/// prevents `navigator.clipboard.writeText` from working after an async IPC call.
///
/// This is what terminal copy calls, so it has to work everywhere the terminal does.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn write_to_clipboard(text: String) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("pbcopy")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("pbcopy spawn failed: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("pbcopy write failed: {e}"))?;
    }
    child.wait().map_err(|e| format!("pbcopy wait failed: {e}"))?;
    Ok(())
}

/// Windows/Linux clipboard via `arboard` — a direct API call, so no console window
/// flashes and no subprocess is spawned per copy.
///
/// `clip.exe` was the subprocess equivalent of pbcopy here, but it reads stdin in the
/// console codepage and mangles any non-ASCII text, which a terminal selection will
/// have. On Linux, arboard keeps X11 selection ownership alive on its own thread.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn write_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("Clipboard write failed: {e}"))
}
