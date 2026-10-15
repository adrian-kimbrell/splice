//! Rename / delete / duplicate / copy of directory entries.
//!
//! These commands address *entries*, not the files behind them: a symlink inside a
//! workspace is renamed, deleted or duplicated as the link itself, never as its
//! target. Every entry path therefore goes through `validate_entry_path` (parent
//! canonicalised and checked against the allowed roots, leaf kept verbatim) rather
//! than `validate_path`, which would resolve the link and hand us the target.
//!
//! No command here silently replaces an existing entry; the caller gets an
//! "already exists" error and can decide.

use crate::state::{validate_entry_path, validate_path, AppState};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

fn allowed_roots(state: &State<'_, Mutex<AppState>>) -> Result<Vec<PathBuf>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.allowed_roots.clone())
}

/// True when an entry (file, dir or symlink, dangling or not) exists at `p`.
fn entry_exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

#[tauri::command]
pub fn rename_path(
    state: State<'_, Mutex<AppState>>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    rename_path_impl(&old_path, &new_path, &allowed_roots(&state)?)
}

pub(crate) fn rename_path_impl(old_path: &str, new_path: &str, roots: &[PathBuf]) -> Result<(), String> {
    let from = validate_entry_path(old_path, roots)?;
    let from_meta =
        fs::symlink_metadata(&from).map_err(|e| format!("Invalid path '{}': {}", old_path, e))?;
    let to = validate_entry_path(new_path, roots)?;

    if entry_exists(&to) {
        // `fs::rename` replaces an existing target without asking. Only allow it when
        // the target *is* the source: a no-op rename, or a case-only rename on a
        // case-insensitive filesystem (a.ts → A.ts).
        let same_entry = !from_meta.file_type().is_symlink()
            && fs::canonicalize(&to).ok() == fs::canonicalize(&from).ok();
        if !same_entry {
            return Err(format!("Cannot rename '{}': '{}' already exists", old_path, new_path));
        }
    }

    fs::rename(&from, &to)
        .map_err(|e| format!("Failed to rename '{}' to '{}': {}", old_path, new_path, e))
}

#[tauri::command(async)]
pub fn delete_path(state: State<'_, Mutex<AppState>>, path: String) -> Result<(), String> {
    delete_path_impl(&path, &allowed_roots(&state)?)
}

pub(crate) fn delete_path_impl(path: &str, roots: &[PathBuf]) -> Result<(), String> {
    let target = validate_entry_path(path, roots)?;
    let meta = fs::symlink_metadata(&target).map_err(|e| format!("Invalid path '{}': {}", path, e))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        // A symlink is removed as a link; whatever it points at is untouched.
        fs::remove_file(&target).map_err(|e| format!("Failed to delete file '{}': {}", path, e))
    } else {
        // remove_dir_all does not follow symlinks found inside the tree either.
        fs::remove_dir_all(&target)
            .map_err(|e| format!("Failed to delete directory '{}': {}", path, e))
    }
}

#[tauri::command(async)]
pub fn duplicate_path(state: State<'_, Mutex<AppState>>, path: String) -> Result<String, String> {
    duplicate_path_impl(&path, &allowed_roots(&state)?)
}

pub(crate) fn duplicate_path_impl(path: &str, roots: &[PathBuf]) -> Result<String, String> {
    let entry = validate_entry_path(path, roots)?;
    let meta = fs::symlink_metadata(&entry).map_err(|e| format!("Invalid path '{}': {}", path, e))?;
    let parent = entry.parent().ok_or("No parent directory")?;
    let stem = entry
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = entry
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut new_path = parent.join(format!("{} copy{}", stem, ext));
    // If "copy" already exists, try "copy 2", "copy 3", etc.
    let mut counter = 2u32;
    while entry_exists(&new_path) {
        if counter > 10_000 {
            return Err(format!("Could not find a unique copy name for '{}'", path));
        }
        new_path = parent.join(format!("{} copy {}{}", stem, counter, ext));
        counter += 1;
    }
    if meta.file_type().is_symlink() {
        // Duplicate the link, not what it points at.
        let link_target = fs::read_link(&entry).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&link_target, &new_path)
            .map_err(|e| format!("Failed to duplicate link '{}': {}", path, e))?;
        #[cfg(not(unix))]
        return Err(format!("Cannot duplicate symlink '{}' on this platform", path));
    } else if meta.is_dir() {
        copy_dir_recursive(&entry, &new_path)?;
    } else {
        fs::copy(&entry, &new_path).map_err(|e| format!("Failed to duplicate '{}': {}", path, e))?;
    }
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn copy_path(
    state: State<'_, Mutex<AppState>>,
    src: String,
    dest: String,
) -> Result<(), String> {
    copy_path_impl(&src, &dest, &allowed_roots(&state)?)
}

pub(crate) fn copy_path_impl(src: &str, dest: &str, roots: &[PathBuf]) -> Result<(), String> {
    // The source is read through, so it is resolved and must land inside a root.
    let src_path = validate_path(src, roots)?;
    // The destination is a new entry: validated parent + verbatim leaf, never an
    // existing entry (fs::copy would follow a symlink leaf and overwrite its target).
    let dest_path = validate_entry_path(dest, roots)?;
    if entry_exists(&dest_path) {
        return Err(format!("Cannot copy to '{}': already exists", dest));
    }
    if src_path.is_dir() {
        copy_dir_recursive(&src_path, &dest_path)
    } else {
        fs::copy(&src_path, &dest_path)
            .map(|_| ())
            .map_err(|e| format!("Failed to copy '{}' to '{}': {}", src, dest, e))
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("Failed to create dir '{}': {}", dst.display(), e))?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        // Skip symlinks to prevent following them outside the source tree
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy '{}': {}", src_path.display(), e))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    /// An allowed root plus a directory *outside* it holding a file, so symlink
    /// tests can prove the outside target survives.
    fn fixture() -> (TempDir, TempDir, Vec<PathBuf>) {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), "keep me").unwrap();
        let roots = vec![root.path().to_path_buf()];
        (root, outside, roots)
    }

    #[test]
    #[cfg(unix)]
    fn delete_dir_symlink_removes_link_and_keeps_target() {
        let (root, outside, roots) = fixture();
        let link = root.path().join("docs");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();

        delete_path_impl(&s(&link), &roots).unwrap();

        assert!(!entry_exists(&link), "link should be gone");
        assert!(outside.path().join("secret.txt").exists(), "target dir must survive");
    }

    #[test]
    #[cfg(unix)]
    fn delete_file_symlink_removes_link_and_keeps_target() {
        let (root, outside, roots) = fixture();
        let link = root.path().join("secret-link.txt");
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), &link).unwrap();

        delete_path_impl(&s(&link), &roots).unwrap();

        assert!(!entry_exists(&link));
        assert_eq!(fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "keep me");
    }

    #[test]
    fn delete_real_dir_and_file_still_work() {
        let (root, _outside, roots) = fixture();
        let dir = root.path().join("d");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("f.txt"), "x").unwrap();
        let file = root.path().join("g.txt");
        fs::write(&file, "y").unwrap();

        delete_path_impl(&s(&dir), &roots).unwrap();
        delete_path_impl(&s(&file), &roots).unwrap();
        assert!(!dir.exists() && !file.exists());
    }

    #[test]
    fn delete_rejects_entries_outside_roots_and_dot_segments() {
        let (root, outside, roots) = fixture();
        assert!(delete_path_impl(&s(&outside.path().join("secret.txt")), &roots).is_err());
        assert!(delete_path_impl(&s(&root.path().join("..")), &roots).is_err());
        assert!(delete_path_impl(&s(&root.path().join(".")), &roots).is_err());
        assert!(outside.path().join("secret.txt").exists());
    }

    #[test]
    fn rename_refuses_to_replace_an_existing_entry() {
        let (root, _outside, roots) = fixture();
        let a = root.path().join("a.txt");
        let b = root.path().join("b.txt");
        fs::write(&a, "A").unwrap();
        fs::write(&b, "B").unwrap();

        let err = rename_path_impl(&s(&b), &s(&a), &roots).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read_to_string(&a).unwrap(), "A", "a.txt must be untouched");
        assert!(b.exists());
    }

    #[test]
    fn rename_to_a_fresh_name_and_case_only_rename_work() {
        let (root, _outside, roots) = fixture();
        let a = root.path().join("a.txt");
        fs::write(&a, "A").unwrap();

        let b = root.path().join("b.txt");
        rename_path_impl(&s(&a), &s(&b), &roots).unwrap();
        assert!(!a.exists() && b.exists());

        // Case-only rename: on a case-insensitive FS the target "exists" already and
        // must still be allowed; on a case-sensitive FS it is a plain rename.
        let upper = root.path().join("B.txt");
        rename_path_impl(&s(&b), &s(&upper), &roots).unwrap();
        let names: Vec<_> = fs::read_dir(root.path()).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["B.txt".to_string()]);
    }

    #[test]
    #[cfg(unix)]
    fn rename_moves_the_symlink_not_its_target() {
        let (root, outside, roots) = fixture();
        let link = root.path().join("link.txt");
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), &link).unwrap();
        let moved = root.path().join("moved.txt");

        rename_path_impl(&s(&link), &s(&moved), &roots).unwrap();

        assert!(fs::symlink_metadata(&moved).unwrap().file_type().is_symlink());
        assert!(!entry_exists(&link));
        assert_eq!(fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "keep me");
    }

    #[test]
    fn copy_rejects_parent_dir_leaf_and_existing_destination() {
        let (root, _outside, roots) = fixture();
        let src = root.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("f.txt"), "x").unwrap();

        // `<root>/..` would have copied the tree into the directory above the root.
        let err = copy_path_impl(&s(&src), &s(&root.path().join("..")), &roots).unwrap_err();
        assert!(err.contains("Invalid path"), "{err}");

        let existing = root.path().join("existing.txt");
        fs::write(&existing, "keep").unwrap();
        let err = copy_path_impl(&s(&src.join("f.txt")), &s(&existing), &roots).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read_to_string(&existing).unwrap(), "keep");
    }

    #[test]
    #[cfg(unix)]
    fn copy_does_not_write_through_a_symlink_leaf() {
        let (root, outside, roots) = fixture();
        let src = root.path().join("src.txt");
        fs::write(&src, "payload").unwrap();
        let link = root.path().join("out-link.txt");
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), &link).unwrap();

        assert!(copy_path_impl(&s(&src), &s(&link), &roots).is_err());
        assert_eq!(fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "keep me");
    }

    #[test]
    fn copy_file_and_dir_to_fresh_destination() {
        let (root, _outside, roots) = fixture();
        let src = root.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("f.txt"), "x").unwrap();

        copy_path_impl(&s(&src), &s(&root.path().join("dst")), &roots).unwrap();
        assert_eq!(fs::read_to_string(root.path().join("dst/f.txt")).unwrap(), "x");

        copy_path_impl(&s(&src.join("f.txt")), &s(&root.path().join("g.txt")), &roots).unwrap();
        assert_eq!(fs::read_to_string(root.path().join("g.txt")).unwrap(), "x");
    }

    #[test]
    fn duplicate_picks_free_copy_names() {
        let (root, _outside, roots) = fixture();
        let f = root.path().join("note.md");
        fs::write(&f, "n").unwrap();
        let first = duplicate_path_impl(&s(&f), &roots).unwrap();
        let second = duplicate_path_impl(&s(&f), &roots).unwrap();
        assert!(first.ends_with("note copy.md"), "{first}");
        assert!(second.ends_with("note copy 2.md"), "{second}");
        assert_eq!(fs::read_to_string(&second).unwrap(), "n");
    }

    #[test]
    #[cfg(unix)]
    fn duplicate_of_symlink_creates_a_link_not_a_copy_of_the_target() {
        let (root, outside, roots) = fixture();
        let link = root.path().join("link.txt");
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), &link).unwrap();

        let dup = PathBuf::from(duplicate_path_impl(&s(&link), &roots).unwrap());
        assert!(fs::symlink_metadata(&dup).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(&dup).unwrap(), outside.path().join("secret.txt"));
    }
}
