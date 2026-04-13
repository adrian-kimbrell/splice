export function getFileIcon(name: string): { icon: string; cls: string } {
  if (name.endsWith(".rs")) return { icon: "bi-file-earmark-code", cls: "rs" };
  if (name.endsWith(".toml"))
    return { icon: "bi-file-earmark-text", cls: "toml" };
  if (name.endsWith(".md"))
    return { icon: "bi-file-earmark-richtext", cls: "md" };
  if (name.endsWith(".ts") || name.endsWith(".tsx"))
    return { icon: "bi-file-earmark-code", cls: "rs" };
  if (name.endsWith(".js") || name.endsWith(".jsx"))
    return { icon: "bi-file-earmark-code", cls: "rs" };
  if (name.endsWith(".svelte"))
    return { icon: "bi-file-earmark-code", cls: "rs" };
  if (name.endsWith(".css")) return { icon: "bi-filetype-css", cls: "md" };
  if (name.endsWith(".json"))
    return { icon: "bi-file-earmark-text", cls: "toml" };
  if (name === ".gitignore") return { icon: "bi-git", cls: "git" };
  if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") ||
      name.endsWith(".gif") || name.endsWith(".webp") || name.endsWith(".svg") ||
      name.endsWith(".ico") || name.endsWith(".bmp"))
    return { icon: "bi-file-earmark-image", cls: "img" };
  return { icon: "bi-file-earmark", cls: "default" };
}
