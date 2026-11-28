import { mount } from "svelte";
import "../app.css";
import { applyPrefs } from "../lib/settings.svelte";
import App from "./App.svelte";

// Until App has loaded the settings: the browser's language, the system's light/dark
applyPrefs();

mount(App, { target: document.getElementById("app")! });
