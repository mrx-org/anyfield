import { describe, expect, it } from "vitest";
import { fileLine, filterFiles, formatSize, sortFiles } from "./files";
import type { UserFile } from "./types";

const f = (name: string, size: number | null, uploaded_at: string | null, type: string | null = null): UserFile => ({
  sha256: name,
  name,
  type,
  size,
  uploaded_at,
  url: "",
});

describe("files", () => {
  it("formats sizes", () => {
    expect(formatSize(null)).toBe("–");
    expect(formatSize(999)).toBe("999 B");
    expect(formatSize(1500)).toBe("1,5 kB");
    expect(formatSize(250_000_000)).toBe("250,0 MB");
  });

  it("hands over name and hash", () => {
    expect(fileLine("a.zip", "ab12")).toBe('"a.zip": ab12');
  });

  it("sorts by any column, missing values last", () => {
    const files = [f("b", 2, null), f("a", null, "2026-01-02"), f("c", 1, "2026-01-01")];
    expect(sortFiles(files, "name", true).map((x) => x.name)).toEqual(["a", "b", "c"]);
    expect(sortFiles(files, "size", true).map((x) => x.name)).toEqual(["c", "b", "a"]);
    expect(sortFiles(files, "size", false).map((x) => x.name)).toEqual(["b", "c", "a"]);
    expect(sortFiles(files, "uploaded_at", false).map((x) => x.name)).toEqual(["a", "c", "b"]);
  });

  it("filters by name and type", () => {
    const files = [f("brain.zip", 1, null, "application/zip"), f("gre.seq", 1, null, "text/plain")];
    expect(filterFiles(files, "ZIP").map((x) => x.name)).toEqual(["brain.zip"]);
    expect(filterFiles(files, " ")).toHaveLength(2);
  });
});
