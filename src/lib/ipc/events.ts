import { listen } from "@tauri-apps/api/event";

export function onTerminalOutput(
  id: number,
  callback: (data: Uint8Array) => void,
) {
  return listen<number[]>(`terminal:output:${id}`, (event) => {
    callback(new Uint8Array(event.payload));
  });
}

export function onTerminalExit(id: number, callback: (code: number) => void) {
  return listen<number>(`terminal:exit:${id}`, (event) => {
    callback(event.payload);
  });
}
