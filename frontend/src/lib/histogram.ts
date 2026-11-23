/** Histogram of `values` between `min` and `max` in `bins` bins, as log10(count + 1)
 * scaled to 0..1 (the highest bin is 1). Values outside the range count in the first or
 * last bin; values that are not finite are skipped. Of more than `maxSamples` values,
 * every n-th is counted. `scale` turns a stored value into the shown one (NIfTI slope). */
export function logHistogram(
  values: ArrayLike<number>,
  min: number,
  max: number,
  bins = 256,
  maxSamples = 2_000_000,
  scale: (v: number) => number = (v) => v,
): Float32Array {
  const counts = new Float32Array(bins);
  if (!bins) return counts;
  const perBin = bins / (max - min || 1);
  const step = Math.max(1, Math.ceil(values.length / maxSamples));
  for (let i = 0; i < values.length; i += step) {
    const v = scale(values[i]);
    if (!Number.isFinite(v)) continue;
    const b = Math.floor((v - min) * perBin);
    counts[b < 0 ? 0 : b >= bins ? bins - 1 : b]++;
  }
  let top = 0;
  for (let i = 0; i < bins; i++) {
    counts[i] = Math.log10(counts[i] + 1);
    if (counts[i] > top) top = counts[i];
  }
  if (top) for (let i = 0; i < bins; i++) counts[i] /= top;
  return counts;
}
