/**
 * Typed wrappers around Tauri's invoke() for all backend commands.
 *
 * Single source of truth for command names and argument shapes. All Rust-side commands
 * are registered in `src-tauri/src/lib.rs` via `generate_handler!`.
 *
 * Naming: camelCase here maps to snake_case in Rust (e.g. `spawnTerminal` → `spawn_terminal`).
 * Tauri serializes JS objects to Rust structs automatically via serde.
 */
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../stores/files.svelte";
import type { Settings } from "../stores/settings.svelte";
import type { SshConfig } from "../stores/workspace-types"; // used by sshConnect

export async function readDirTree(path: string): Promise<FileEntry[]> {
  return invoke("read_dir_tree", { path });
}

export async function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

export async function spawnTerminal(
  shell: string,
  cwd: string,
  cols: number,
  rows: number,
  extraArgs?: string[],
  terminalId?: number,
): Promise<number> {
  return invoke("spawn_terminal", {
    shell,
    cwd,
    cols,
    rows,
    extraArgs: extraArgs ?? [],
    terminalId: terminalId ?? null,
  });
}

export async function writeToTerminal(
  id: number,
  data: Uint8Array,
): Promise<void> {
  return invoke("write_to_terminal", { id, data });
}

export async function resizeTerminal(
  id: number,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_terminal", { id, cols, rows });
}

export async function scrollTerminal(
  id: number,
  delta: number,
): Promise<void> {
  return invoke("scroll_terminal", { id, delta });
}

export async function setTerminalScrollOffset(
  id: number,
  offset: number,
): Promise<void> {
  return invoke("set_terminal_scroll_offset", { id, offset });
}

export async function killTerminal(id: number): Promise<void> {
  return invoke("kill_terminal", { id });
}

export async function getTerminalCwd(id: number): Promise<string | null> {
  return invoke<string | null>("get_terminal_cwd", { id });
}

/** Dev-only: returns the last n non-blank lines from the terminal's scrollback+live buffer. */
export async function getTerminalLastLines(id: number, n: number): Promise<string[]> {
  return invoke("get_terminal_last_lines", { id, n });
}

/** Returns terminal lines for a history row range.
 *  historyStart = top/older (smaller index), historyEnd = bottom/newer (larger index).
 *  Both are direct indices into the combined [scrollback, live] array:
 *    0 = oldest scrollback, scrollback_len + rows - 1 = newest live row.
 *  Result is ordered top-to-bottom (oldest first, index 0 = historyStart row). */
export async function getTerminalTextRange(
  id: number,
  historyStart: number,
  historyEnd: number,
): Promise<string[]> {
  return invoke("get_terminal_text_range", { id, historyStart, historyEnd });
}

export interface TerminalSearchMatch {
  row: number;
  col_start: number;
  col_end: number;
}

export async function searchTerminal(
  id: number,
  query: string,
  caseSensitive: boolean,
): Promise<TerminalSearchMatch[]> {
  return invoke("search_terminal", { id, query, caseSensitive });
}

export interface RustPaneInfo {
  id: string;
  pane_type: unknown;
  title: string;
  file_paths: string[];
  active_file_path: string | null;
  claude_session_id: string | null;
  claude_pid: number | null;
  terminal_id: number | null;
}

export interface RustSshConfig {
  host: string;
  port: number;
  user: string;
  key_path: string;
  remote_path: string;
}

export interface RustWorkspace {
  id: string;
  name: string;
  root_path: string;
  layout: unknown;
  panes: RustPaneInfo[];
  terminal_ids: number[];
  open_file_paths: string[];
  active_file_path: string | null;
  active_pane_id: string | null;
  explorer_visible: boolean;
  expanded_paths?: string[];
  ssh_config?: RustSshConfig | null;
}

export interface WorkspacesResponse {
  active_workspace_id: string | null;
  workspaces: RustWorkspace[];
}

export async function getWorkspaces(): Promise<WorkspacesResponse> {
  return invoke("get_workspaces");
}

export async function saveWorkspace(workspace: RustWorkspace): Promise<void> {
  return invoke("save_workspace", { workspace });
}

export async function setActiveWorkspaceId(id: string | null): Promise<void> {
  return invoke("set_active_workspace_id", { id });
}

export async function reorderWorkspaces(ids: string[]): Promise<void> {
  return invoke("reorder_workspaces", { ids });
}


export async function deleteWorkspace(id: string): Promise<void> {
  return invoke("delete_workspace", { id });
}

export async function addAllowedRoot(path: string): Promise<void> {
  return invoke("add_allowed_root", { path });
}

export async function closeWorkspace(id: string): Promise<number[]> {
  return invoke("close_workspace", { id });
}

export async function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export async function updateSettings(settings: Settings): Promise<void> {
  return invoke("update_settings", { settings });
}

/** Reads the JSON contents of `<workspaceRoot>/.splice/settings.json`.
 * Returns an empty string if the file doesn't exist. Caller parses + merges. */
export async function readProjectSettings(workspaceRoot: string): Promise<string> {
  return invoke("read_project_settings", { workspaceRoot });
}

/** Writes the given JSON string to `<workspaceRoot>/.splice/settings.json`,
 * creating `.splice/` if needed. */
export async function writeProjectSettings(workspaceRoot: string, json: string): Promise<void> {
  return invoke("write_project_settings", { workspaceRoot, json });
}

export interface CustomTheme {
  name: string;
  colors: Record<string, string>;
}

export async function listCustomThemes(): Promise<CustomTheme[]> {
  return invoke<CustomTheme[]>("list_custom_themes");
}

export async function importTheme(filePath: string): Promise<CustomTheme> {
  return invoke<CustomTheme>("import_theme", { filePath });
}

export async function deleteCustomTheme(name: string): Promise<void> {
  return invoke<void>("delete_custom_theme", { name });
}

export async function installClaudeHook(): Promise<void> {
  return invoke("install_claude_hook");
}

export interface SearchMatch {
  path: string;
  line_number: number;
  line_content: string;
  col_start: number;
  col_end: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  total_files_searched: number;
}

export async function getGitBranch(path: string): Promise<string> {
  return invoke("get_git_branch", { path });
}

// --- Git commands ---

export interface GitFileStatus {
  path: string;
  index_status: string;
  worktree_status: string;
}

export interface GitDiffContents {
  old_content: string;
  new_content: string;
  is_new: boolean;
  is_deleted: boolean;
}

export interface GitLogEntry {
  hash: string;
  short_hash: string;
  author: string;
  timestamp: number;
  message: string;
  parents: string[];
  refs: string;
}

export async function gitStatus(path: string): Promise<GitFileStatus[]> {
  return invoke("git_status", { path });
}

export async function gitStage(path: string, filePaths: string[]): Promise<void> {
  return invoke("git_stage", { path, filePaths });
}

export async function gitUnstage(path: string, filePaths: string[]): Promise<void> {
  return invoke("git_unstage", { path, filePaths });
}

export async function gitCommit(path: string, message: string): Promise<string> {
  return invoke("git_commit", { path, message });
}

export async function gitDiscard(path: string, filePaths: string[]): Promise<void> {
  return invoke("git_discard", { path, filePaths });
}

export async function gitDiffFile(path: string, filePath: string, staged: boolean): Promise<GitDiffContents> {
  return invoke("git_diff_file", { path, filePath, staged });
}

export async function gitLog(path: string, maxCount?: number): Promise<GitLogEntry[]> {
  return invoke("git_log", { path, maxCount: maxCount ?? null });
}

export async function readFileBase64(path: string): Promise<string> {
  return invoke("read_file_base64", { path });
}

export async function getRecentFiles(): Promise<string[]> {
  return invoke("get_recent_files");
}

export async function addRecentFile(path: string): Promise<void> {
  return invoke("add_recent_file", { path });
}

export async function getRecentProjects(): Promise<string[]> {
  return invoke("get_recent_projects");
}

export async function addRecentProject(path: string): Promise<void> {
  return invoke("add_recent_project", { path });
}

export async function watchPath(path: string): Promise<void> {
  return invoke("watch_path", { path });
}

export async function unwatchPath(path: string): Promise<void> {
  return invoke("unwatch_path", { path });
}

export async function createFileAt(
  dirPath: string,
  name: string,
): Promise<string> {
  return invoke("create_file_at", { dirPath, name });
}

export async function createDirectoryAt(
  dirPath: string,
  name: string,
): Promise<string> {
  return invoke("create_directory_at", { dirPath, name });
}

export async function renamePath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke("rename_path", { oldPath, newPath });
}

export async function deletePath(path: string): Promise<void> {
  return invoke("delete_path", { path });
}

export async function duplicatePath(path: string): Promise<string> {
  return invoke("duplicate_path", { path });
}

export async function copyPath(src: string, dest: string): Promise<void> {
  return invoke("copy_path", { src, dest });
}

export async function checkPidAlive(pid: number): Promise<boolean> {
  return invoke("check_pid_alive", { pid });
}

export async function revealInFileManager(path: string): Promise<void> {
  return invoke("reveal_in_file_manager", { path });
}

export async function searchFiles(
  rootPath: string,
  query: string,
  caseSensitive: boolean,
  maxResults?: number,
): Promise<SearchResult> {
  return invoke("search_files", {
    rootPath,
    query,
    caseSensitive,
    maxResults: maxResults ?? null,
  });
}

export async function lspCheck(languageId: string): Promise<boolean> {
  return invoke("lsp_check", { languageId });
}

export async function lspInstall(languageId: string): Promise<void> {
  return invoke("lsp_install", { languageId });
}

export async function lspStart(languageId: string, workspaceRoot: string): Promise<void> {
  return invoke("lsp_start", { languageId, workspaceRoot });
}

export async function lspNotify(languageId: string, method: string, params: unknown): Promise<void> {
  return invoke("lsp_notify", { languageId, method, params });
}

export async function lspRequest(languageId: string, method: string, params: unknown): Promise<unknown> {
  return invoke("lsp_request", { languageId, method, params });
}

export async function registerWindow(label: string): Promise<void> {
  return invoke("register_window", { label });
}

export async function unregisterWindow(label: string): Promise<void> {
  return invoke("unregister_window", { label });
}

export async function getSecondaryWindowLabels(): Promise<string[]> {
  return invoke("get_secondary_window_labels");
}

export async function getAllWorkspaceLabels(): Promise<string[]> {
  return invoke<string[]>("get_all_workspace_labels");
}

export async function saveTempImage(data: Uint8Array, ext: string): Promise<string> {
  return invoke("save_temp_image", { data, ext });
}

/** Save a screenshot PNG to docs/screenshots/ in the project directory. */
export async function saveScreenshot(data: number[]): Promise<string> {
  return invoke("save_screenshot", { data });
}

export async function writeToClipboard(text: string): Promise<void> {
  return invoke("write_to_clipboard", { text });
}

// --- SSH / SFTP commands ---

export async function sshConnect(workspaceId: string, config: SshConfig): Promise<void> {
  return invoke("ssh_connect", {
    workspaceId,
    config: {
      host: config.host,
      port: config.port,
      user: config.user,
      key_path: config.keyPath,
      remote_path: config.remotePath,
    },
  });
}

export async function sshDisconnect(workspaceId: string): Promise<void> {
  return invoke("ssh_disconnect", { workspaceId });
}

export async function sftpListDir(workspaceId: string, path: string): Promise<FileEntry[]> {
  return invoke("sftp_list_dir", { workspaceId, path });
}

export async function sftpReadFile(workspaceId: string, path: string): Promise<string> {
  return invoke("sftp_read_file", { workspaceId, path });
}

export async function sftpWriteFile(workspaceId: string, path: string, content: string): Promise<void> {
  return invoke("sftp_write_file", { workspaceId, path, content });
}

export async function sshPing(workspaceId: string): Promise<boolean> {
  return invoke("ssh_ping", { workspaceId });
}
