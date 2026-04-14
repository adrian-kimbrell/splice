/**
 * Lazy language-extension loader for CodeMirror 6.
 *
 * Extensions are cached by file extension so repeated tab switches don't
 * re-import the same language package on every render.
 */

export function getExtForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

const langCache = new Map<string, any>();

export async function getLanguageExtension(path: string) {
  const ext = getExtForPath(path);
  const cached = langCache.get(ext);
  if (cached) return cached;

  let lang: any;
  switch (ext) {
    case ".js":
    case ".jsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      lang = javascript({ jsx: true });
      break;
    }
    case ".ts":
    case ".tsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      lang = javascript({ jsx: true, typescript: true });
      break;
    }
    case ".html":
    case ".svelte": {
      const { html } = await import("@codemirror/lang-html");
      lang = html();
      break;
    }
    case ".css": {
      const { css } = await import("@codemirror/lang-css");
      lang = css();
      break;
    }
    case ".json": {
      const { json } = await import("@codemirror/lang-json");
      lang = json();
      break;
    }
    case ".rs": {
      const { rust } = await import("@codemirror/lang-rust");
      lang = rust();
      break;
    }
    case ".py": {
      const { python } = await import("@codemirror/lang-python");
      lang = python();
      break;
    }
    case ".md": {
      const { markdown } = await import("@codemirror/lang-markdown");
      lang = markdown();
      break;
    }
    default:
      return [];
  }
  langCache.set(ext, lang);
  return lang;
}
