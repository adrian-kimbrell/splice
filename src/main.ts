import App from "./components/App.svelte";
import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import "./app.css";

// macOS 26+ gets a taller top strip (see `--chrome-bar-height`). Asked before the
// first render so the layout does not jump; a failure just keeps the default.
async function start() {
  try {
    if (await invoke<boolean>("chrome_tall")) document.documentElement.dataset.chrome = "tall";
  } catch {
    // not in Tauri, or the command is missing
  }
  mount(App, { target: document.getElementById("app")! });
}

void start();
