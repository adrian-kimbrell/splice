import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../stores/files.svelte";

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
  data: number[],
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

export async function killTerminal(id: number): Promise<void> {
  return invoke("kill_terminal", { id });
}

export async function getTerminalBuffer(id: number): Promise<Uint8Array> {
  const data: number[] = await invoke("get_terminal_buffer", { id });
  return new Uint8Array(data);
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

export interface Settings {
  editor: {
    font_family: string;
    font_size: number;
    tab_size: number;
    word_wrap: boolean;
    line_numbers: boolean;
    minimap: boolean;
  };
  appearance: {
    theme: string;
    ui_scale: number;
    show_status_bar: boolean;
  };
  terminal: {
    default_shell: string;
    font_size: number;
    cursor_style: string;
    cursor_blink: boolean;
    scrollback_lines: number;
  };
}

export async function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export async function updateSettings(settings: Settings): Promise<void> {
  return invoke("update_settings", { settings });
}
