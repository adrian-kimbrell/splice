interface FileClipboard {
  op: "cut" | "copy";
  path: string;
}

let _clipboard = $state<FileClipboard | null>(null);

export const fileClipboard = {
  get value() { return _clipboard; },
  set(v: FileClipboard) { _clipboard = v; },
  clear() { _clipboard = null; },
};
