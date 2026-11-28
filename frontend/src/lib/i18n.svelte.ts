// The UI's language: which one, and numbers and dates in it (Intl). Texts are
// Paraglide messages (messages/<locale>.json, compiled to src/paraglide by
// `pnpm i18n`); a message reads the locale when it is called, so a change of
// language re-renders the UI under `{#key i18n.locale}` (web app, MCP App shell).
// Tool names, error messages and what goes to the AI stay English.
import { baseLocale, isLocale, locales, setLocale, type Locale } from "../paraglide/runtime.js";

export type { Locale };
export const LOCALES = locales;
/** Each language in itself, for the language switcher. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", de: "Deutsch", es: "Español", fr: "Français", it: "Italiano" };

/** The supported language a tag like "de-AT" or "fr" stands for, or null. */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lang = tag.toLowerCase().split(/[-_]/)[0];
  return isLocale(lang) ? lang : null;
}

/** The first of `candidates` that is supported, else the browser's (system's), else English. */
export function pickLocale(...candidates: (string | null | undefined)[]): Locale {
  const browser = typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  for (const c of [...candidates, ...browser]) {
    const l = matchLocale(c);
    if (l) return l;
  }
  return baseLocale;
}

class I18n {
  locale = $state<Locale>(baseLocale);
}
export const i18n = new I18n();

/** Show the UI in `locale` (messages, numbers, dates, <html lang>). */
export function useLocale(locale: Locale) {
  setLocale(locale, { reload: false });
  i18n.locale = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

// The web app keeps the language chosen in the switcher per device. Storage may be
// unavailable (a sandboxed iframe, private mode): then nothing is kept.
const STORAGE_KEY = "anyfield.locale";

export function savedLocale(): Locale | null {
  try {
    return matchLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveLocale(locale: Locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // not kept
  }
}

/** What the language switcher does: set by the shell (web app: save and use; MCP App: use for this app only). */
export const switcher: { choose: (locale: Locale) => void } = {
  choose: (locale) => {
    saveLocale(locale);
    useLocale(locale);
  },
};

// --- numbers and dates in the UI's language ---------------------------------------

/** A number with exactly `digits` decimals (default: as needed, up to 3). */
export function formatNumber(v: number, digits?: number): string {
  const opts = digits === undefined ? { maximumFractionDigits: 3 } : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  return new Intl.NumberFormat(i18n.locale, opts).format(v);
}

/** A number with `significant` significant digits. */
export const formatSignificant = (v: number, significant: number) =>
  new Intl.NumberFormat(i18n.locale, { maximumSignificantDigits: significant }).format(v);

/** Date and time, short (e.g. "23.11.26, 14:05" or "11/23/26, 2:05 PM"). */
export const formatDateTime = (d: Date) =>
  d.toLocaleString(i18n.locale, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Compare two strings as the UI's language sorts them. */
export const compareText = (a: string, b: string) => a.localeCompare(b, i18n.locale);
