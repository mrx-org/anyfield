import { describe, expect, it } from "vitest";
import { applyPatch, DEFAULT_STATE } from "./state/patch";
import { casSequence, sameSequence, sequencePatch } from "./sequence";
import type { SourceSequence } from "./types";

const source: SourceSequence = { source: "anyseq", type: "py", url: "https://x.invalid/a.py", name: "a.py", func: "seq_a" };

describe("sequencePatch", () => {
  it("switches between the kinds of sequence", () => {
    const withSource = applyPatch(DEFAULT_STATE, { sequence: sequencePatch(source) });
    expect(withSource.sequence).toEqual(source);
    const cas = casSequence({ sha256: "a".repeat(64), name: "my.seq" })!;
    const withCas = applyPatch(withSource, { sequence: sequencePatch(cas) });
    expect(withCas.sequence).toEqual({ sha256: "a".repeat(64), type: "seq", name: "my.seq" });
  });
});

describe("casSequence", () => {
  it("takes only sequence files", () => {
    expect(casSequence({ sha256: "b", name: "x.ipynb" })?.type).toBe("ipynb");
    expect(casSequence({ sha256: "b", name: "x.zip" })).toBeNull();
  });
});

describe("sameSequence", () => {
  it("compares file and function", () => {
    expect(sameSequence(source, { ...source })).toBe(true);
    expect(sameSequence(source, { ...source, func: "seq_b" })).toBe(false);
    expect(sameSequence(null, undefined)).toBe(true);
  });
});
