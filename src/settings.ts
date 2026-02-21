import SettingsApp from "./components/SettingsApp.svelte";
import { mount } from "svelte";
import "./app.css";

const app = mount(SettingsApp, { target: document.getElementById("app")! });

export default app;
