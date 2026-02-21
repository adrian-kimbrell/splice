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
}
