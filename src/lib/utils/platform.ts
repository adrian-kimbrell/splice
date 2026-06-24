// Lightweight OS detection from the webview user agent. Avoids pulling in
// @tauri-apps/plugin-os just to branch window chrome (Windows controls on the
// right vs. macOS native traffic lights on the left).
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

export const isWindows = ua.includes("Windows");
export const isMac = /Macintosh|Mac OS X/.test(ua);
