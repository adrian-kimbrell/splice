/**
 * Maps file extensions to human-readable language names for the status bar.
 *
 * Falls back to "Plain Text" for unrecognised or missing extensions.
 */
const EXT_MAP: Record<string, string> = {
  ".rs": "Rust",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".html": "HTML",
  ".svelte": "Svelte",
  ".css": "CSS",
  ".json": "JSON",
  ".py": "Python",
  ".md": "Markdown",
  ".toml": "TOML",
  ".yaml": "YAML",
  ".yml": "YAML",
};

export function getLanguageName(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "Plain Text";
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_MAP[ext] ?? "Plain Text";
}
