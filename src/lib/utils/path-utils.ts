/**
 * Path manipulation utilities with security-aware boundary checks.
 *
 * {@link isUnderRoot} prevents path traversal outside a workspace root by
 * using a trailing-slash comparison, avoiding false positives on sibling
 * directories that share a common prefix.
 *
 * The frontend works in forward-slash paths on every platform: it splits on "/" to
 * derive basenames and breadcrumbs, and compares paths as plain strings. Rust
 * normalizes everything it sends over IPC (`state::to_ui_path`), so {@link toUiPath}
 * is only needed for paths that arrive from somewhere else — namely the native file
 * dialog, which returns `C:\Users\me\proj` verbatim.
 */

/** Normalize an OS path to the forward-slash form the UI works in. */
export function toUiPath(path: string): string {
  // Windows extended-length prefix (\\?\C:\x, \\?\UNC\server\share) — strip before
  // converting so the result matches what Rust hands us for the same file.
  const unprefixed = path.startsWith("\\\\?\\UNC\\")
    ? "\\\\" + path.slice(8)
    : path.startsWith("\\\\?\\")
      ? path.slice(4)
      : path;
  return unprefixed.replace(/\\/g, "/");
}

/**
 * Returns true if filePath is equal to rootPath or is a descendant of it.
 * Uses a trailing-slash check to avoid matching sibling directories that
 * share a common prefix (e.g. rootPath="/a/b" must NOT match "/a/bc/file").
 *
 * Both sides are normalized first: a backslash path reaching here (from a dialog, or
 * from state persisted by an older build) would otherwise never match its own root.
 */
export function isUnderRoot(filePath: string, rootPath: string): boolean {
  const file = toUiPath(filePath);
  const root = toUiPath(rootPath);
  if (file === root) return true;
  const prefix = root.endsWith("/") ? root : root + "/";
  return file.startsWith(prefix);
}
