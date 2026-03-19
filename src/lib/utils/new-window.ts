/** Opens a fresh, independent app window with its own workspace file. */
export async function openNewWindow(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const label = `main-${Math.random().toString(16).slice(2, 8)}`;
    const { registerWindow } = await import("../ipc/commands");
    await registerWindow(label);
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    new WebviewWindow(label, {
      url: "/",
      title: "Splice",
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      decorations: true,
      resizable: true,
      backgroundColor: { red: 30, green: 30, blue: 30, alpha: 255 },
    });
  } catch (e) {
    console.error("Failed to open new window:", e);
  }
}
