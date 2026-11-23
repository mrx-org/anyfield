import { describe, expect, it } from "vitest";
import { logHistogram } from "./histogram";

describe("logHistogram", () => {
  it("counts values into their bins, log-scaled to 0..1", () => {
    const h = logHistogram([0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.99], 0, 1, 4);
    expect(h[0]).toBe(1); // 9 values: the highest bin
    expect(h[1]).toBe(0);
    expect(h[2]).toBeCloseTo(Math.log10(2) / Math.log10(10));
    expect(h[3]).toBeCloseTo(Math.log10(2) / Math.log10(10));
  });

  it("puts values outside the range into the first or last bin", () => {
    const h = logHistogram([-5, 7, 1], 0, 1, 2);
    expect(h[0]).toBeCloseTo(Math.log10(2) / Math.log10(3));
    expect(h[1]).toBe(1); // 7 and the maximum itself
  });

  it("skips values that are not finite", () => {
    const h = logHistogram([NaN, Infinity, 0.1], 0, 1, 2);
    expect(Array.from(h)).toEqual([1, 0]);
  });

  it("is all zero without values", () => {
    expect(Array.from(logHistogram([], 0, 1, 3))).toEqual([0, 0, 0]);
  });

  it("applies the scale and samples large inputs", () => {
    const h = logHistogram(new Float32Array([1, 3, 1, 3]), 0, 10, 2, 2, (v) => v * 2);
    // every 2nd value: 1, 1 → 2, 2: all in the first bin
    expect(Array.from(h)).toEqual([1, 0]);
  });

  it("handles an empty range", () => {
    expect(Array.from(logHistogram([2, 2], 2, 2, 2))).toEqual([1, 0]);
  });
});
