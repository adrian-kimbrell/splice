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
    std::process::Command::new("open")
        .args(["-R", &canonical.to_string_lossy()])
        .spawn()
        .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
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
    Ok(path.to_string_lossy().into_owned())
}

/// Write text to the system clipboard via `pbcopy`.
/// Using the OS-level tool bypasses WKWebView's user-gesture requirement that
/// prevents `navigator.clipboard.writeText` from working after an async IPC call.
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
