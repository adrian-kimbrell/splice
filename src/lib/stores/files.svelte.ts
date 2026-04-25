/**
 * Core file and directory type definitions used throughout the editor.
 *
 * `FileEntry` represents a node in the workspace directory tree (explorer sidebar).
 * Directories have `is_dir: true` and lazily-populated `children`. The `expanded`
 * flag tracks whether a directory node is open in the tree view.
 *
 * `OpenFile` represents a file buffer open in an editor tab:
 * - `dirty` -- true when `content` differs from `originalContent` (unsaved changes)
 * - `preview` -- single-click opens in preview mode; editing or double-click pins it
 * - `pinned` -- user explicitly pinned the tab (immune to preview replacement)
 * - `readOnly` -- buffer is non-editable (e.g., image viewer, binary preview)
 *
 * These types are consumed by the file explorer, tab bar, editor panes, and
 * the session persistence layer.
 */

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
  expanded?: boolean;
}

export interface OpenFile {
  name: string;
  path: string;
  content: string;
  dirty?: boolean;
  originalContent?: string;
  preview?: boolean;
  pinned?: boolean;
  readOnly?: boolean;
}
