import { type Options } from "@wdio/types";
import { ChildProcess, spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const APP_BINARY = resolve(__dirname, "src-tauri/target/debug/splice");
const DRIVER_PORT = 4445;
const STARTUP_TIMEOUT_MS = 10_000;

let appProcess: ChildProcess | null = null;
/** Scratch config dir handed to the app via SPLICE_CONFIG_DIR, so the suite never
 *  reads or writes the developer's real settings, workspaces, or attention port. */
let configDir: string | null = null;

/** Poll until the WebDriver server is accepting connections or timeout. */
async function waitForDriver(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/status`);
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `WebDriver server on port ${port} did not become ready within ${timeoutMs}ms.\n` +
      `Make sure the app was built with debug_assertions (cargo build) ` +
      `and tauri-plugin-webdriver is registered.`
  );
}

export const config: Options.Testrunner = {
  // ── Connection ────────────────────────────────────────────────────────────
  hostname: "127.0.0.1",
  port: DRIVER_PORT,
  path: "/",
  protocol: "http",

  // ── Specs ─────────────────────────────────────────────────────────────────
  // Run as a single suite so all specs share one worker (and one Tauri window).
  specs: ["./tests/e2e/suite.ts"],
  exclude: [],

  // ── Capabilities ──────────────────────────────────────────────────────────
  maxInstances: 1,
  capabilities: [{}],

  // ── Runner ────────────────────────────────────────────────────────────────
  runner: "local",
  tsConfigPath: "./tsconfig.e2e.json",

  // ── Framework ─────────────────────────────────────────────────────────────
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 30_000,
  },

  // ── Reporters ─────────────────────────────────────────────────────────────
  reporters: ["spec"],

  // ── Log level ─────────────────────────────────────────────────────────────
  logLevel: "warn",

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  async onPrepare() {
    configDir = mkdtempSync(join(tmpdir(), "splice-e2e-config-"));
    // wdio runs under tsx, which injects itself into every Node child through
    // NODE_OPTIONS / TSX_*; a language server spawned by the app would inherit that
    // and crash on a tsconfig path that only exists in this repo. Give the app a
    // clean Node environment, as a Finder launch would.
    const appEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "NODE_OPTIONS" || k.startsWith("TSX_") || k.startsWith("TS_NODE_")) continue;
      appEnv[k] = v;
    }
    console.log(`\n[e2e] Launching Splice: ${APP_BINARY}`);
    console.log(`[e2e] SPLICE_CONFIG_DIR=${configDir}`);
    appProcess = spawn(APP_BINARY, [], {
      // RUST_LOG from the caller wins, e.g. RUST_LOG=warn,splice_lib::lsp=debug npm run test:e2e
      env: { ...appEnv, RUST_LOG: process.env.RUST_LOG ?? "warn", SPLICE_CONFIG_DIR: configDir },
      stdio: "inherit",
      detached: false,
    });

    appProcess.on("error", (err) => {
      console.error("[e2e] Failed to start app:", err.message);
    });
    appProcess.on("exit", (code, signal) => {
      // An unexpected exit here is the real failure behind a cascade of
      // ECONNREFUSED / "fetch failed" errors in the specs that follow.
      console.error(`[e2e] Splice exited (code=${code}, signal=${signal})`);
    });

    console.log(`[e2e] Waiting for WebDriver server on port ${DRIVER_PORT}…`);
    await waitForDriver(DRIVER_PORT, STARTUP_TIMEOUT_MS);
    console.log("[e2e] WebDriver server ready.\n");
  },

  async onComplete() {
    if (appProcess) {
      console.log("\n[e2e] Killing Splice…");
      appProcess.kill("SIGTERM");
      appProcess = null;
    }
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true });
      configDir = null;
    }
  },
};
