/** Opens the settings window (singleton — focuses if already open). */
export async function openSettingsWindow(): Promise<void> {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return;

  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

    // Check if the window already exists → focus it
    const existing = await WebviewWindow.getByLabel("settings");
    if (existing) {
      await existing.setFocus();
      return;
    }

    // Create new settings window
    new WebviewWindow("settings", {
      url: "/settings.html",
      title: "Settings",
      width: 680,
      height: 520,
      minWidth: 480,
      minHeight: 360,
      resizable: true,
      center: true,
    });
  } catch (e) {
    console.error("Failed to open settings window:", e);
  }
}
