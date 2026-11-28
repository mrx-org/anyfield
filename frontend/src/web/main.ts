import { mount } from "svelte";
import "../app.css";
import { pickLocale, savedLocale, useLocale } from "../lib/i18n.svelte";
import App from "./App.svelte";

// The language chosen on this device, else the browser's, else English
useLocale(pickLocale(savedLocale()));

mount(App, { target: document.getElementById("app")! });
