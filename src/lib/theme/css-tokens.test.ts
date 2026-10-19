import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every `var(--token)` used by a component must be a token some theme or
// stylesheet defines. All colours come from `applyTheme()` (ThemeColors keys)
// or `app.css`; a misspelled token silently falls back to `inherit`/nothing,
// which is how the SSH connect form shipped with no background.

// vitest runs from the project root; import.meta.url is not a file: URL under happy-dom.
const SRC = join(process.cwd(), "src") + "/";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|svelte|css)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("CSS custom property tokens", () => {
  it("every var(--x) used in src is defined somewhere", () => {
    const defined = new Set<string>();
    const used = new Map<string, Set<string>>();

    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
      for (const m of text.matchAll(/setProperty\(\s*[`"'](--[a-zA-Z0-9-]+)/g)) defined.add(m[1]);
      for (const m of text.matchAll(/style:(--[a-zA-Z0-9-]+)/g)) defined.add(m[1]);
      for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1])!.add(file.slice(SRC.length));
      }
    }

    // ThemeColors keys are applied as `--${key}` by applyTheme().
    const themes = readFileSync(join(SRC, "lib/theme/themes.ts"), "utf8");
    const iface = themes.match(/export interface ThemeColors \{([\s\S]*?)\n\}/);
    expect(iface, "ThemeColors interface not found").not.toBeNull();
    for (const m of iface![1].matchAll(/^\s*"?([a-zA-Z0-9-]+)"?\??:/gm)) defined.add("--" + m[1]);

    const undefinedTokens = [...used.entries()]
      .filter(([token]) => !defined.has(token))
      .map(([token, files]) => `${token} <- ${[...files].join(", ")}`)
      .sort();
    expect(undefinedTokens).toEqual([]);
  });
});
