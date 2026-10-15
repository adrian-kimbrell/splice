/**
 * file:// URI <-> path conversion for the LSP bridge.
 *
 * Servers percent-encode paths (`My Project` -> `My%20Project`). Building URIs by
 * plain concatenation and stripping the scheme on the way back meant that files
 * in folders with spaces got no diagnostics (keys never matched) and go-to-
 * definition opened a path with a literal `%20` in it.
 */

export function pathToFileUri(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  const encoded = uri.slice("file://".length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded; // malformed escape: better a raw path than an exception
  }
}
