/**
 * Global setup for API integration tests.
 * Verifies the dev server is reachable before the suite runs.
 */
import { readFileSync } from "fs";

function getPort(): number {
  try {
    return parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);
  } catch {
    return 19990;
  }
}

export async function setup() {
  const port = getPort();
  const url = `http://127.0.0.1:${port}/dev/ping`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ping returned ${res.status}`);
    console.log(`\n[api-tests] Dev server reachable on port ${port}`);
  } catch (e) {
    throw new Error(
      `[api-tests] Dev server not reachable at ${url}.\n` +
      `Make sure the app is running with: npm run tauri dev\n` +
      `Error: ${e}`
    );
  }
}
