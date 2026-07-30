use crate::state::{validate_path, AppState};
use notify::{EventKind, RecursiveMode, Watcher, RecommendedWatcher};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tracing::info;

#[tauri::command]
pub fn watch_path(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    // Validate before creating the watcher
    let allowed_roots = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;
    // Doubles as the watchers map key and the emitted event payload, so it uses the
    // frontend path form — unwatch_path normalizes the same way to stay in sync.
    let canonical_str = crate::state::to_ui_path(&canonical);

    // Deduplicate: skip if we're already watching this path
    {
        let s = state.lock().map_err(|e| e.to_string())?;
        if s.watchers.contains_key(&canonical_str) {
            return Ok(());
        }
    }

    let is_dir = canonical.is_dir();
    let event_name: &'static str = if is_dir { "tree:changed" } else { "file:changed" };
    let watch_mode = if is_dir { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };

    let emit_path = canonical_str.clone();
    // Trailing-edge debounce: when an event arrives, schedule an emit 150ms later
    // unless one is already pending. The pending guard coalesces subsequent events
    // in the burst into the same delayed emit, so the refresh reads the filesystem
    // AFTER the burst has settled rather than mid-write. Crucially, every burst
    // produces exactly one emit — no events are silently dropped (which is what the
    // old leading-edge throttle did, and what made the file tree appear stale after
    // multi-file LLM edits).
    let pending = std::sync::Arc::new(std::sync::Mutex::new(false));

    // Use a 100ms FSEvents latency (macOS) so external changes appear quickly.
    // On Linux/Windows the Config has no effect — inotify/ReadDirectoryChanges
    // are already near-instant.
    let config = notify::Config::default()
        .with_poll_interval(std::time::Duration::from_millis(100));
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            let Ok(event) = res else { return };
            if !matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            ) {
                return;
            }
            // Claim the slot for this burst.
            {
                let mut p = pending.lock().unwrap_or_else(|e| e.into_inner());
                if *p { return; }
                *p = true;
            }
            let app = app.clone();
            let emit_path = emit_path.clone();
            let pending = pending.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let _ = app.emit(event_name, emit_path);
                if let Ok(mut p) = pending.lock() {
                    *p = false;
                }
            });
        },
        config,
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(canonical.as_path(), watch_mode)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    info!(path = %canonical_str, is_dir, "Watching path");
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.watchers.insert(canonical_str, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_path(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    // Must canonicalise the same way watch_path does.
    // Use std::fs::canonicalize (not validate_path) — the file may no longer exist.
    let key = std::fs::canonicalize(&path)
        .map(|p| crate::state::to_ui_path(&p))
        .unwrap_or_else(|_| path.clone());
    let mut state = state.lock().map_err(|e| e.to_string())?;
    // Try canonical key first; fall back to raw path for pre-fix watchers still in map.
    if state.watchers.remove(&key).is_none() {
        state.watchers.remove(&path);
    }
    info!(path = %key, "Unwatched file");
    Ok(())
}
