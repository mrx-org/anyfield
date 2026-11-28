import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCALES, matchLocale, pickLocale } from "./i18n.svelte";

describe("locale", () => {
  it("matches language tags to the supported languages", () => {
    expect(matchLocale("de-AT")).toBe("de");
    expect(matchLocale("FR")).toBe("fr");
    expect(matchLocale("pt-BR")).toBeNull();
    expect(matchLocale(null)).toBeNull();
  });

  it("takes the first supported candidate, else English", () => {
    expect(pickLocale(null, "pt", "it-IT", "de")).toBe("it");
    expect(pickLocale("xx")).toMatch(/^(en|de|es|fr|it)$/); // node: the system's or English
  });
});

describe("messages", () => {
  it("every language has every message", () => {
    const keys = (l: string) =>
      Object.keys(JSON.parse(readFileSync(new URL(`../../messages/${l}.json`, import.meta.url), "utf8"))).sort();
    for (const l of LOCALES) expect(keys(l)).toEqual(keys("en"));
  });
});
