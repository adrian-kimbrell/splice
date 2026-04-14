import { describe, it, expect } from "vitest";
import { getFileIcon } from "./file-icons";

describe("getFileIcon", () => {
  it("returns code icon for .rs", () => {
    const r = getFileIcon("main.rs");
    expect(r.icon).toBe("bi-file-earmark-code");
    expect(r.cls).toBe("rs");
  });

  it("returns text icon for .toml", () => {
    const r = getFileIcon("Cargo.toml");
    expect(r.icon).toBe("bi-file-earmark-text");
    expect(r.cls).toBe("toml");
  });

  it("returns richtext icon for .md", () => {
    const r = getFileIcon("README.md");
    expect(r.icon).toBe("bi-file-earmark-richtext");
    expect(r.cls).toBe("md");
  });

  it("returns code icon for .ts", () => {
    const r = getFileIcon("app.ts");
    expect(r.icon).toBe("bi-file-earmark-code");
  });

  it("returns code icon for .tsx", () => {
    expect(getFileIcon("Component.tsx").icon).toBe("bi-file-earmark-code");
  });

  it("returns code icon for .js", () => {
    expect(getFileIcon("index.js").icon).toBe("bi-file-earmark-code");
  });

  it("returns code icon for .jsx", () => {
    expect(getFileIcon("App.jsx").icon).toBe("bi-file-earmark-code");
  });

  it("returns code icon for .svelte", () => {
    expect(getFileIcon("App.svelte").icon).toBe("bi-file-earmark-code");
  });

  it("returns css icon for .css", () => {
    const r = getFileIcon("styles.css");
    expect(r.icon).toBe("bi-filetype-css");
    expect(r.cls).toBe("md");
  });

  it("returns text icon for .json", () => {
    const r = getFileIcon("package.json");
    expect(r.icon).toBe("bi-file-earmark-text");
    expect(r.cls).toBe("toml");
  });

  it("returns git icon for .gitignore", () => {
    const r = getFileIcon(".gitignore");
    expect(r.icon).toBe("bi-git");
    expect(r.cls).toBe("git");
  });

  it("returns image icon for .png", () => {
    expect(getFileIcon("screenshot.png").icon).toBe("bi-file-earmark-image");
  });

  it("returns image icon for .jpg", () => {
    expect(getFileIcon("photo.jpg").icon).toBe("bi-file-earmark-image");
  });

  it("returns image icon for .svg", () => {
    expect(getFileIcon("logo.svg").icon).toBe("bi-file-earmark-image");
  });

  it("returns image icon for .ico", () => {
    expect(getFileIcon("favicon.ico").icon).toBe("bi-file-earmark-image");
  });

  it("returns default icon for unknown extension", () => {
    const r = getFileIcon("data.xyz");
    expect(r.icon).toBe("bi-file-earmark");
    expect(r.cls).toBe("default");
  });

  it("returns default icon for no extension", () => {
    expect(getFileIcon("Makefile").icon).toBe("bi-file-earmark");
  });

  it("does NOT match .gitignore for other dotfiles", () => {
    // .eslintrc is not .gitignore — should fall through to default
    expect(getFileIcon(".eslintrc").icon).toBe("bi-file-earmark");
  });
});
