import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../stores/files.svelte";
import type { Settings } from "../stores/settings.svelte";

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
): Promise<number> {
  return invoke("spawn_terminal", { shell, cwd, cols, rows });
}

export async function writeToTerminal(
  id: number,
  data: number[] | Uint8Array,
): Promise<void> {
  return invoke("write_to_terminal", { id, data: Array.from(data) });
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

export async function killTerminal(id: number): Promise<void> {
  return invoke("kill_terminal", { id });
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

export interface RustWorkspace {
  id: string;
  name: string;
  root_path: string;
  layout: unknown;
  panes: unknown[];
  terminal_ids: number[];
  open_file_paths: string[];
  active_file_path: string | null;
}

export async function getWorkspaces(): Promise<RustWorkspace[]> {
  return invoke("get_workspaces");
}

export async function saveWorkspace(workspace: RustWorkspace): Promise<void> {
  return invoke("save_workspace", { workspace });
}

export async function deleteWorkspace(id: string): Promise<void> {
  return invoke("delete_workspace", { id });
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

export async function readFileBase64(path: string): Promise<string> {
  return invoke("read_file_base64", { path });
}

export async function getRecentFiles(): Promise<string[]> {
  return invoke("get_recent_files");
}

export async function addRecentFile(path: string): Promise<void> {
  return invoke("add_recent_file", { path });
}

export async function watchPath(path: string): Promise<void> {
  return invoke("watch_path", { path });
}

export async function unwatchPath(path: string): Promise<void> {
  return invoke("unwatch_path", { path });
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
