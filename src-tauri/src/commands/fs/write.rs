use crate::state::{validate_entry_path, validate_path, AppState};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn write_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
    content: String,
) -> Result<(), String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    write_file_impl(&path, &content, &allowed_roots)
}

pub(crate) fn write_file_impl(path: &str, content: &str, allowed_roots: &[PathBuf]) -> Result<(), String> {
    let p = Path::new(path);
    // Build a canonical write target so we always write to the validated path,
    // not the original (potentially symlink-escaped) string. An existing file is
    // resolved (a symlinked file is written through to its in-root target); a new
    // file is <canonical parent>/<name>.
    let canonical_write_target = if p.exists() {
        validate_path(path, allowed_roots)?
    } else {
        if let Some(parent) = p.parent() {
            if parent.as_os_str().is_empty() || !parent.exists() {
                return Err(format!("Parent directory does not exist for path '{}'", path));
            }
        }
        validate_entry_path(path, allowed_roots)?
    };
    let target = &canonical_write_target;
    let fail = |e: std::io::Error| format!("Failed to write '{}': {}", target.display(), e);

    let existing = fs::metadata(target).ok();

    // A file with other hard links must keep its inode, otherwise the other links
    // silently stop seeing updates. Write in place for that (rare) case.
    #[cfg(unix)]
    if let Some(meta) = &existing {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return fs::write(target, content).map_err(fail);
        }
    }

    // Atomic write: write to a sibling tmp file then rename so a crash or disk-full
    // leaves the original intact rather than truncated/empty.
    let tmp_name = format!(
        "{}.splicetmp",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    );
    let tmp = target.with_file_name(&tmp_name);
    fs::write(&tmp, content).map_err(fail)?;
    // The temp file was created with the default mode; carry the original's
    // permissions over so a 0755 script does not come back as 0644.
    if let Some(meta) = &existing {
        if let Err(e) = fs::set_permissions(&tmp, meta.permissions()) {
            let _ = fs::remove_file(&tmp);
            return Err(fail(e));
        }
    }
    fs::rename(&tmp, target).map_err(fail)
}

#[tauri::command]
pub fn create_file_at(
    state: State<'_, Mutex<AppState>>,
    dir_path: String,
    name: String,
) -> Result<String, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    // Reject names that could escape the directory via path traversal
    if name.contains('/') || name.contains('\0') || name == ".." || name == "." {
        return Err(format!("Invalid file name: '{}'", name));
    }
    let canonical_dir = validate_path(&dir_path, &allowed_roots)?;
    if !canonical_dir.is_dir() {
        return Err(format!("Not a directory: {}", dir_path));
    }
    let file_path = canonical_dir.join(&name);
    // symlink_metadata so a dangling symlink counts as "exists" (fs::write would
    // otherwise follow it and create a file at its target), and create_new so the
    // check and the create cannot race.
    if fs::symlink_metadata(&file_path).is_ok() {
        return Err(format!("Already exists: {}", file_path.display()));
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_directory_at(
    state: State<'_, Mutex<AppState>>,
    dir_path: String,
    name: String,
) -> Result<String, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    // Reject names that could escape the directory via path traversal
    if name.contains('/') || name.contains('\0') || name == ".." || name == "." {
        return Err(format!("Invalid directory name: '{}'", name));
    }
    let canonical_dir = validate_path(&dir_path, &allowed_roots)?;
    if !canonical_dir.is_dir() {
        return Err(format!("Not a directory: {}", dir_path));
    }
    let new_dir = canonical_dir.join(&name);
    if fs::symlink_metadata(&new_dir).is_ok() {
        return Err(format!("Already exists: {}", new_dir.display()));
    }
    fs::create_dir(&new_dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    Ok(new_dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    #[cfg(unix)]
    fn write_preserves_the_original_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = TempDir::new().unwrap();
        let roots = vec![root.path().to_path_buf()];
        let script = root.path().join("deploy.sh");
        fs::write(&script, "#!/bin/sh\necho old\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        write_file_impl(&s(&script), "#!/bin/sh\necho new\n", &roots).unwrap();

        assert_eq!(fs::read_to_string(&script).unwrap(), "#!/bin/sh\necho new\n");
        assert_eq!(fs::metadata(&script).unwrap().permissions().mode() & 0o777, 0o755);
        assert!(!root.path().join("deploy.sh.splicetmp").exists());
    }

    #[test]
    #[cfg(unix)]
    fn write_keeps_hard_linked_files_on_the_same_inode() {
        use std::os::unix::fs::MetadataExt;
        let root = TempDir::new().unwrap();
        let roots = vec![root.path().to_path_buf()];
        let a = root.path().join("a.txt");
        let b = root.path().join("b.txt");
        fs::write(&a, "one").unwrap();
        fs::hard_link(&a, &b).unwrap();

        write_file_impl(&s(&a), "two", &roots).unwrap();

        assert_eq!(fs::read_to_string(&b).unwrap(), "two", "other link must see the write");
        assert_eq!(fs::metadata(&a).unwrap().nlink(), 2);
    }

    #[test]
    fn write_creates_new_files_and_rejects_dot_dot_leaves() {
        let root = TempDir::new().unwrap();
        let roots = vec![root.path().to_path_buf()];
        let f = root.path().join("new.txt");
        write_file_impl(&s(&f), "hi", &roots).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "hi");

        let sub = root.path().join("sub");
        fs::create_dir(&sub).unwrap();
        assert!(write_file_impl(&s(&sub.join("..")), "x", &roots).is_err());
        assert!(write_file_impl(&s(&root.path().join("missing/new.txt")), "x", &roots).is_err());
    }

    #[test]
    fn write_rejects_targets_outside_roots() {
        let root = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let roots = vec![root.path().to_path_buf()];
        let f = other.path().join("x.txt");
        assert!(write_file_impl(&s(&f), "x", &roots).is_err());
        assert!(!f.exists());
    }
}
