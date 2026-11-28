// The user's settings for the UI: language, colour theme, light/dark, and whether an
// MCP App takes the chat's colours. With a login they are stored per user on the
// server (get_user_settings, set_user_settings) and apply on the website and in every
// MCP App; the website also keeps them in this browser (localStorage), so that they
// stay without a login too. null: not set, the default applies (language: the chat's
// or browser's; theme: cerberus; light/dark: the chat's or system's; chat colours: on).
import { m } from "../paraglide/messages.js";
import type { AnyfieldClient } from "./client/anyfield";
import { pickLocale, useLocale, type Locale } from "./i18n.svelte";
import { setDark } from "./theme.svelte";
import { toaster } from "./toast";

export const THEMES = [
  "catppuccin", "cerberus", "concord", "crimson", "dracula", "fennec", "hamlindigo", "legacy",
  "mint", "modern", "mona", "nosh", "nouveau", "pine", "reign", "rocket", "rose", "rosepine",
  "sahara", "seafoam", "terminus", "vintage", "vox", "wintry",
] as const; // prettier-ignore
export type ThemeName = (typeof THEMES)[number];
export type Mode = "light" | "dark" | "auto";
export const DEFAULT_THEME: ThemeName = "cerberus";

export interface UserSettings {
  locale: Locale | null;
  theme: ThemeName | null;
  mode: Mode | null;
  chat_theme: boolean | null;
}
const KEYS = ["locale", "theme", "mode", "chat_theme"] as const;
const EMPTY: UserSettings = { locale: null, theme: null, mode: null, chat_theme: null };

class Prefs {
  settings = $state<UserSettings>({ ...EMPTY });
  /** What the chat says (MCP App): its language and light/dark; null on the website. */
  host = $state<{ locale: string | null; dark: boolean | null }>({ locale: null, dark: null });
  /** Stored for a logged-in user. */
  saved = $state(false);
  client: AnyfieldClient | null = null;
  /** Keep them in this browser (website). */
  local = false;
}
export const prefs = new Prefs();

export const mode = (): Mode => prefs.settings.mode ?? "auto";
export const chatTheme = (): boolean => prefs.settings.chat_theme ?? true;

/** Show the UI as the settings say (language, theme, light/dark, chat colours). */
export function applyPrefs() {
  const s = prefs.settings;
  useLocale(pickLocale(s.locale, prefs.host.locale));
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  html.dataset.theme = s.theme ?? DEFAULT_THEME;
  const m = mode();
  const systemDark = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
  setDark(m === "dark" || (m === "auto" && (prefs.host.dark ?? systemDark)));
  html.classList.toggle("chat-theme", chatTheme());
}

const STORAGE_KEY = "anyfield.settings";
const OLD_LOCALE_KEY = "anyfield.locale";

function readLocal(): Partial<UserSettings> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<UserSettings>;
    const oldLocale = localStorage.getItem(OLD_LOCALE_KEY);
    return oldLocale && !raw.locale ? { ...raw, locale: oldLocale as Locale } : raw;
  } catch {
    return {};
  }
}

function writeLocal(s: UserSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // not kept
  }
}

const clean = (s: Partial<UserSettings>): UserSettings => ({
  locale: s.locale ?? null,
  theme: s.theme && (THEMES as readonly string[]).includes(s.theme) ? s.theme : null,
  mode: s.mode ?? null,
  chat_theme: s.chat_theme ?? null,
});

/** Load the settings: from this browser (`local`), then the user's from the server
 * (they win where set). Applies them right away and again once the server answered. */
export async function loadPrefs(client: AnyfieldClient, local: boolean) {
  prefs.client = client;
  prefs.local = local;
  if (local) prefs.settings = clean(readLocal());
  applyPrefs();
  try {
    const r = await client.getUserSettings();
    prefs.saved = r.saved;
    if (r.saved) {
      const merged = { ...prefs.settings };
      for (const k of KEYS) if (r[k] !== null) (merged as Record<string, unknown>)[k] = r[k];
      prefs.settings = clean(merged);
      if (local) writeLocal(prefs.settings);
      applyPrefs();
    }
  } catch {
    // no server settings: the local (or default) ones stay
  }
}

/** Change settings (null: back to the default): shown at once, kept in this browser
 * (website) and for the user (with a login; without one, a notice in an MCP App). */
export async function changePrefs(patch: Partial<UserSettings>) {
  prefs.settings = clean({ ...prefs.settings, ...patch });
  applyPrefs();
  if (prefs.local) writeLocal(prefs.settings);
  const args: Record<string, unknown> = {};
  const reset: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) reset.push(k);
    else args[k] = v;
  }
  try {
    const r = await prefs.client?.setUserSettings({ ...args, ...(reset.length ? { reset } : {}) });
    prefs.saved = !!r?.saved;
    if (r && !r.saved && !prefs.local) toaster.info({ title: m.settings_not_saved() });
  } catch {
    // shown here, kept where possible
  }
}
