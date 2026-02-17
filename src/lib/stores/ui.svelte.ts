export const ui = $state({
  leftSidebarVisible: true,
  rightSidebarVisible: true,
  leftSidebarWidth: 240,
  rightSidebarWidth: 220,
  commandPaletteOpen: false,
  settingsOpen: false,
  settingsPanel: "editor" as "editor" | "appearance" | "terminal",
  zoomedPaneId: null as string | null,
});
