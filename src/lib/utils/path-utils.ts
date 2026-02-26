/**
 * Returns true if filePath is equal to rootPath or is a descendant of it.
 * Uses a trailing-slash check to avoid matching sibling directories that
 * share a common prefix (e.g. rootPath="/a/b" must NOT match "/a/bc/file").
 */
export function isUnderRoot(filePath: string, rootPath: string): boolean {
  if (filePath === rootPath) return true;
  const prefix = rootPath.endsWith("/") ? rootPath : rootPath + "/";
  return filePath.startsWith(prefix);
}
