//! Filesystem watchers behind the explorer and open-file reloads.
//!
//! One `notify` watcher per watched path, shared process-wide and reference
//! counted: two workspaces (or two windows) on the same folder share a watcher,
//! and closing one of them must not take the other's watcher away. The previous
//! "skip if already watching / remove on unwatch" pair did exactly that, which
//! left the surviving workspace's explorer frozen until the app restarted.
//!
//! Events are debounced on the trailing edge (150 ms) so a burst of writes
//! produces one refresh after the burst settles. FSEvents' "events were dropped,
//! rescan" signal is treated as a change as well, since a full tree reload is
//! exactly the right response to it.

use crate::state::{validate_path, AppState};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tracing::info;

/// A live watcher plus the number of `watch_path` calls currently relying on it.
pub struct WatchEntry {
    _watcher: RecommendedWatcher,
    refs: usize,
}

/// Key under which a path is tracked. Canonical when the path exists; otherwise the
/// canonical parent joined with the verbatim file name, so an `unwatch_path` for a
/// file that has just been deleted still finds the entry created when it existed.
pub(crate) fn watch_key(path: &str) -> String {
    if let Ok(c) = std::fs::canonicalize(path) {
        return c.to_string_lossy().to_string();
    }
    let p = Path::new(path);
    match (p.parent().and_then(|d| std::fs::canonicalize(d).ok()), p.file_name()) {
        (Some(parent), Some(name)) => parent.join(name).to_string_lossy().to_string(),
        _ => path.to_string(),
    }
}

/// Does this event warrant a refresh? Everything except pure access events,
/// including the "rescan" marker FSEvents sends when it dropped events.
pub(crate) fn is_relevant(event: &notify::Event) -> bool {
    event.need_rescan() || !matches!(event.kind, EventKind::Access(_))
}

/// Could this event change what the explorer shows under `root`? The tree hides
/// dot-entries, so a change whose every path sits inside a hidden directory
/// (`.git/index`, `.cache/...`) cannot alter it, and refreshing for one only
/// costs a tree reload plus a `git status`. Hidden components are judged
/// relative to `root`, so a workspace that itself lives under `~/.config` is
/// not silenced. Rescan markers and paths outside `root` always count.
pub(crate) fn touches_visible_path(event: &notify::Event, root: &Path) -> bool {
    if event.need_rescan() || event.paths.is_empty() {
        return true;
    }
    event.paths.iter().any(|p| match p.strip_prefix(root) {
        Ok(rel) => !rel
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.')),
        Err(_) => true,
    })
}

/// Register `watcher` under `key`, or bump the reference count of the existing
/// entry (in which case `watcher` is dropped). Returns the resulting count.
pub(crate) fn acquire(
    watchers: &mut HashMap<String, WatchEntry>,
    key: &str,
    watcher: RecommendedWatcher,
) -> usize {
    if let Some(entry) = watchers.get_mut(key) {
        entry.refs += 1;
        return entry.refs;
    }
    watchers.insert(key.to_string(), WatchEntry { _watcher: watcher, refs: 1 });
    1
}

/// Drop one reference to `key`. The watcher itself goes away only with the last
/// reference. Returns true when it was removed.
pub(crate) fn release(watchers: &mut HashMap<String, WatchEntry>, key: &str) -> bool {
    match watchers.get_mut(key) {
        Some(entry) if entry.refs > 1 => {
            entry.refs -= 1;
            false
        }
        Some(_) => {
            watchers.remove(key);
            true
        }
        None => false,
    }
}

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
    let canonical_str = canonical.to_string_lossy().to_string();

    let is_dir = canonical.is_dir();
    let event_name: &'static str = if is_dir { "tree:changed" } else { "file:changed" };
    let watch_mode = if is_dir { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };

    let emit_path = canonical_str.clone();
    // Trailing-edge debounce: when an event arrives, schedule an emit 150ms later
    // unless one is already pending. The pending guard coalesces subsequent events
    // in the burst into the same delayed emit, so the refresh reads the filesystem
    // AFTER the burst has settled rather than mid-write. Every burst produces at
    // least one emit — no events are silently dropped.
    let pending = std::sync::Arc::new(std::sync::Mutex::new(false));
    let root = canonical.clone();

    let config = notify::Config::default();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            let Ok(event) = res else { return };
            if !is_relevant(&event) || (is_dir && !touches_visible_path(&event, &root)) {
                return;
            }
            // Claim the slot for this burst.
            {
                let mut p = pending.lock().unwrap_or_else(|e| e.into_inner());
                if *p {
                    return;
                }
                *p = true;
            }
            let app = app.clone();
            let emit_path = emit_path.clone();
            let pending = pending.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                // Release the slot *before* emitting: an event that lands while the
                // frontend is already re-reading must schedule its own refresh, or
                // the change it reports is never picked up.
                if let Ok(mut p) = pending.lock() {
                    *p = false;
                }
                let _ = app.emit(event_name, emit_path);
            });
        },
        config,
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(canonical.as_path(), watch_mode)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    let mut state = state.lock().map_err(|e| e.to_string())?;
    let refs = acquire(&mut state.watchers, &canonical_str, watcher);
    info!(path = %canonical_str, is_dir, refs, "Watching path");
    Ok(())
}

#[tauri::command]
pub fn unwatch_path(state: State<'_, Mutex<AppState>>, path: String) -> Result<(), String> {
    let key = watch_key(&path);
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let removed = release(&mut state.watchers, &key);
    // Fall back to the raw path for watchers registered before keys were canonical.
    if !removed && !state.watchers.contains_key(&key) {
        release(&mut state.watchers, &path);
    }
    info!(path = %key, removed, "Unwatched path");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::{Config, Event, EventKind};

    fn dummy_watcher() -> RecommendedWatcher {
        RecommendedWatcher::new(|_res| {}, Config::default()).unwrap()
    }

    #[test]
    fn second_watch_on_same_key_shares_the_entry_and_first_unwatch_keeps_it() {
        let mut map = HashMap::new();
        assert_eq!(acquire(&mut map, "/p", dummy_watcher()), 1);
        assert_eq!(acquire(&mut map, "/p", dummy_watcher()), 2);
        assert_eq!(map.len(), 1);

        // Closing one of two workspaces on the folder must leave the watcher alive.
        assert!(!release(&mut map, "/p"));
        assert!(map.contains_key("/p"));

        assert!(release(&mut map, "/p"));
        assert!(map.is_empty());
    }

    #[test]
    fn release_of_unknown_key_is_a_noop() {
        let mut map: HashMap<String, WatchEntry> = HashMap::new();
        assert!(!release(&mut map, "/nope"));
    }

    #[test]
    fn watch_key_for_a_deleted_file_matches_the_key_it_had_while_alive() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("gone.txt");
        std::fs::write(&file, "x").unwrap();
        let alive = watch_key(&file.to_string_lossy());
        std::fs::remove_file(&file).unwrap();
        let dead = watch_key(&file.to_string_lossy());
        assert_eq!(alive, dead);
        // and it is canonical (e.g. /tmp → /private/tmp on macOS)
        assert_eq!(alive, dir.path().canonicalize().unwrap().join("gone.txt").to_string_lossy());
    }

    #[test]
    fn changes_inside_hidden_directories_do_not_touch_the_tree() {
        let root = Path::new("/ws/app");
        let ev = |p: &str| Event::new(EventKind::Modify(notify::event::ModifyKind::Any)).add_path(p.into());

        assert!(!touches_visible_path(&ev("/ws/app/.git/index.lock"), root));
        assert!(!touches_visible_path(&ev("/ws/app/src/.cache/x"), root));
        assert!(touches_visible_path(&ev("/ws/app/src/main.rs"), root));
        // A top-level dot-file is hidden too; the explorer never lists it.
        assert!(!touches_visible_path(&ev("/ws/app/.env"), root));
        // One visible path in a multi-path event is enough.
        let multi = ev("/ws/app/.git/HEAD").add_path("/ws/app/README.md".into());
        assert!(touches_visible_path(&multi, root));
    }

    #[test]
    fn hidden_components_are_judged_relative_to_the_watched_root() {
        let root = Path::new("/home/u/.config/app");
        let ev = |p: &str| Event::new(EventKind::Create(notify::event::CreateKind::File)).add_path(p.into());
        assert!(touches_visible_path(&ev("/home/u/.config/app/settings.json"), root));
        assert!(!touches_visible_path(&ev("/home/u/.config/app/.git/index"), root));
    }

    #[test]
    fn rescans_paths_outside_root_and_pathless_events_always_count() {
        let root = Path::new("/ws/app");
        let rescan = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan).add_path("/ws/app/.git/x".into());
        assert!(touches_visible_path(&rescan, root));
        let outside = Event::new(EventKind::Any).add_path("/elsewhere/.hidden".into());
        assert!(touches_visible_path(&outside, root));
        assert!(touches_visible_path(&Event::new(EventKind::Any), root));
    }

    #[test]
    fn rescan_and_mutations_are_relevant_access_is_not() {
        assert!(is_relevant(&Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan)));
        assert!(is_relevant(&Event::new(EventKind::Create(notify::event::CreateKind::File))));
        assert!(is_relevant(&Event::new(EventKind::Modify(notify::event::ModifyKind::Any))));
        assert!(is_relevant(&Event::new(EventKind::Remove(notify::event::RemoveKind::Any))));
        assert!(is_relevant(&Event::new(EventKind::Any)));
        assert!(!is_relevant(&Event::new(EventKind::Access(notify::event::AccessKind::Any))));
    }
}
