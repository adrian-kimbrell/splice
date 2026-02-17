import App from "./components/App.svelte";
import { mount } from "svelte";
import "./app.css";

const app = mount(App, { target: document.getElementById("app")! });

export default app;
