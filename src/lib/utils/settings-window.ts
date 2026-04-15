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
      width: 960,
      height: 680,
      minWidth: 560,
      minHeight: 400,
      resizable: true,
      center: true,
      backgroundColor: { red: 30, green: 30, blue: 30, alpha: 255 },
    });
  } catch (e) {
    console.error("Failed to open settings window:", e);
  }
}
