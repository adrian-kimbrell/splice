import { listen } from "@tauri-apps/api/event";

export function onTerminalGrid(
  id: number,
  callback: (data: Uint8Array) => void,
) {
  return listen<string>(`terminal:grid:${id}`, (event) => {
    const bin = atob(event.payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    callback(bytes);
  });
}

export function onTerminalExit(id: number, callback: (code: number) => void) {
  return listen<number>(`terminal:exit:${id}`, (event) => {
    callback(event.payload);
  });
}

export function onTerminalTitle(
  id: number,
  callback: (title: string) => void,
) {
  return listen<string>(`terminal:title:${id}`, (event) => {
    callback(event.payload);
  });
}

export function onTerminalBell(id: number, callback: () => void) {
  return listen<void>(`terminal:bell:${id}`, () => {
    callback();
  });
}
