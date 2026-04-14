import { describe, it, expect } from "vitest";
import { getLanguageName } from "./language";

describe("getLanguageName", () => {
  it("returns Rust for .rs", () => expect(getLanguageName("main.rs")).toBe("Rust"));
  it("returns TypeScript for .ts", () => expect(getLanguageName("app.ts")).toBe("TypeScript"));
  it("returns TypeScript for .tsx", () => expect(getLanguageName("Component.tsx")).toBe("TypeScript"));
  it("returns JavaScript for .js", () => expect(getLanguageName("index.js")).toBe("JavaScript"));
  it("returns JavaScript for .jsx", () => expect(getLanguageName("App.jsx")).toBe("JavaScript"));
  it("returns HTML for .html", () => expect(getLanguageName("index.html")).toBe("HTML"));
  it("returns Svelte for .svelte", () => expect(getLanguageName("App.svelte")).toBe("Svelte"));
  it("returns CSS for .css", () => expect(getLanguageName("styles.css")).toBe("CSS"));
  it("returns JSON for .json", () => expect(getLanguageName("package.json")).toBe("JSON"));
  it("returns Python for .py", () => expect(getLanguageName("main.py")).toBe("Python"));
  it("returns Markdown for .md", () => expect(getLanguageName("README.md")).toBe("Markdown"));
  it("returns TOML for .toml", () => expect(getLanguageName("Cargo.toml")).toBe("TOML"));
  it("returns YAML for .yaml", () => expect(getLanguageName("config.yaml")).toBe("YAML"));
  it("returns YAML for .yml", () => expect(getLanguageName(".github/ci.yml")).toBe("YAML"));

  it("returns Plain Text for unknown extension", () => expect(getLanguageName("file.xyz")).toBe("Plain Text"));
  it("returns Plain Text for no extension", () => expect(getLanguageName("Makefile")).toBe("Plain Text"));
  it("returns Plain Text for empty string", () => expect(getLanguageName("")).toBe("Plain Text"));
  it("returns Plain Text for file with trailing dot", () => expect(getLanguageName("file.")).toBe("Plain Text"));

  it("is case-insensitive for extensions", () => {
    expect(getLanguageName("main.RS")).toBe("Rust");
    expect(getLanguageName("app.TS")).toBe("TypeScript");
  });

  it("uses last dot for files with multiple dots", () => {
    expect(getLanguageName("foo.test.ts")).toBe("TypeScript");
    expect(getLanguageName("package.lock.json")).toBe("JSON");
  });

  it("handles dotfiles with known extension", () => {
    // .ts would only match if it parses the dot correctly
    expect(getLanguageName(".eslintrc.js")).toBe("JavaScript");
  });
});
