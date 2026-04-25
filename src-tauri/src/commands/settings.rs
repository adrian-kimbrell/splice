//! Tauri commands for reading and writing application settings.
//!
//! Settings are persisted to `~/.config/Splice/settings.json` (or the platform
//! equivalent via `dirs::config_dir`). The file is loaded lazily on the first
//! `get_settings` call and cached in [`AppState`] for subsequent reads.
//! `update_settings` writes through to disk using atomic rename to prevent
//! corruption on crash.
//!
//! Also exposes `set_traffic_light_position` for repositioning the macOS
//! window-control buttons (close/minimize/zoom) to match the editor's custom
//! title bar layout. This is a no-op on non-macOS platforms.

use crate::state::AppState;
use crate::workspace::layout::Settings;
use std::sync::Mutex;
use tauri::State;
use tracing::{error, info};

/// Repositions the macOS traffic-light buttons to match the current UI scale.
/// Mirrors the logic in wry's `inset_traffic_lights`.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn set_traffic_light_position(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
) -> Result<(), String> {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
    window
        .with_webview(move |webview| unsafe {
            let ns_window: &NSWindow = &*webview.ns_window().cast();
            let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else { return; };
            let Some(miniaturize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton) else { return; };
            let zoom = ns_window.standardWindowButton(NSWindowButton::ZoomButton);

            let Some(container) = close.superview().and_then(|v| v.superview()) else { return; };
            let close_rect = NSView::frame(&close);
            let bar_height = close_rect.size.height + y;
            let mut bar_rect = NSView::frame(&container);
            bar_rect.size.height = bar_height;
            bar_rect.origin.y = ns_window.frame().size.height - bar_height;
            container.setFrame(bar_rect);

            let spacing = NSView::frame(&miniaturize).origin.x - close_rect.origin.x;
            let mut buttons = vec![close, miniaturize];
            if let Some(z) = zoom { buttons.push(z); }
            for (i, btn) in buttons.into_iter().enumerate() {
                let mut r = NSView::frame(&btn);
                r.origin.x = x + i as f64 * spacing;
                btn.setFrameOrigin(r.origin);
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn set_traffic_light_position(_window: tauri::WebviewWindow, _x: f64, _y: f64) -> Result<(), String> {
    Ok(())
}

fn settings_path() -> std::path::PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Splice");
    std::fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

fn load_settings_from_disk() -> Option<Settings> {
    let path = settings_path();
    if !path.exists() {
        return None;
    }
    match std::fs::read_to_string(&path) {
        Ok(data) => match serde_json::from_str(&data) {
            Ok(settings) => Some(settings),
            Err(e) => {
                error!("Failed to parse settings: {}", e);
                None
            }
        },
        Err(e) => {
            error!("Failed to read settings file: {}", e);
            None
        }
    }
}

fn save_settings_to_disk(settings: &Settings) -> Result<(), String> {
    let path = settings_path();
    let data = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Atomic write: write to a temp file then rename to avoid corruption on crash
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, Mutex<AppState>>) -> Result<Settings, String> {
    // Fast path: already loaded — return without touching disk
    {
        let s = state.lock().map_err(|e| e.to_string())?;
        if s.settings_loaded {
            return Ok(s.settings.clone());
        }
    }

    // Slow path: read from disk WITHOUT holding the lock
    let disk_settings = load_settings_from_disk();

    let mut s = state.lock().map_err(|e| e.to_string())?;
    if !s.settings_loaded {          // re-check under lock
        if let Some(ds) = disk_settings {
            s.settings = ds;
            info!("Loaded settings from disk");
        }
        s.settings_loaded = true;
    }
    Ok(s.settings.clone())
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, Mutex<AppState>>,
    settings: Settings,
) -> Result<(), String> {
    let settings_clone = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.settings = settings;
        state.settings_loaded = true;
        state.settings.clone()
    };

    // Persist outside of lock
    save_settings_to_disk(&settings_clone)?;
    info!("Settings saved to disk");
    Ok(())
}
