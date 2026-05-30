/**
 * Scan / diff expression parsing and volume resolution for paper plot panels.
 */
import { NVImage } from "https://unpkg.com/@niivue/niivue@0.65.0/dist/index.js";
import { getNVox3D, voxelBufferForDisplayedLayer } from "./paper_plot_figure.js";

/** @typedef {{ type: 'scan', scanNum: number, phase: boolean }} ScanParsed */
/** @typedef {{ type: 'diff', left: number, right: number, abs: boolean, reverse: boolean }} DiffParsed */

/**
 * @param {string} raw
 * @returns {ScanParsed | DiffParsed | null}
 */
export function parsePanelExpr(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  let abs = false;
  let inner = s;
  if (inner.startsWith("|") && inner.endsWith("|") && inner.length > 2) {
    abs = true;
    inner = inner.slice(1, -1).trim();
  }

  const diffMatch = inner.match(/^(\d+)\s*-\s*(\d+)$/);
  if (diffMatch) {
    return {
      type: "diff",
      left: parseInt(diffMatch[1], 10),
      right: parseInt(diffMatch[2], 10),
      abs,
      reverse: false,
    };
  }

  const scanPhase = inner.match(/^(\d+)\.phase$/i);
  if (scanPhase) {
    return { type: "scan", scanNum: parseInt(scanPhase[1], 10), phase: true };
  }

  const scanPlain = inner.match(/^(\d+)$/);
  if (scanPlain) {
    return { type: "scan", scanNum: parseInt(scanPlain[1], 10), phase: false };
  }

  return null;
}

/**
 * @param {number} scanNum
 * @returns {{ vol: object | null, url: string | null, name: string }}
 */
export function resolveScanSource(scanNum) {
  const nv = window.nvModule?.nv;
  if (nv?.volumes?.length) {
    for (const v of nv.volumes) {
      const m = String(v?.name ?? "").match(/^scan_(\d+)/i);
      if (m && parseInt(m[1], 10) === scanNum) {
        return {
          vol: v,
          url: v.sourceUrl || null,
          name: v.name || `scan_${scanNum}.nii.gz`,
        };
      }
    }
  }

  const queue = window.scanModule?.queue ?? [];
  const job = queue.find((j) => j.status === "done" && j.scanNumber === scanNum);
  if (job?.niftiUrl) {
    const name = `${job.baseName || "scan_" + scanNum}.nii.gz`;
    return { vol: null, url: job.niftiUrl, name };
  }

  return { vol: null, url: null, name: `scan_${scanNum}` };
}

function volumeFrameSlice(vol, frame4D) {
  const nVox = getNVox3D(vol);
  if (!nVox || !vol?.img) return null;
  const nFr =
    vol.nFrame4D ??
    (vol.hdr?.dims?.[4] > 1 ? vol.hdr.dims[4] : Math.max(1, Math.floor(vol.img.length / nVox)));
  if (nFr <= 1) return vol.img;
  const fi = Math.min(Math.max(0, frame4D ?? 0), nFr - 1);
  const prev = vol.frame4D;
  vol.frame4D = fi;
  const buf = voxelBufferForDisplayedLayer(vol);
  vol.frame4D = prev;
  return buf;
}

function dimsMatch(a, b) {
  const da = spatialDims3(a);
  const db = spatialDims3(b);
  for (let i = 0; i < 3; i++) {
    if (da[i] !== db[i]) return false;
  }
  return true;
}

function affineFromVolume(vol) {
  const hdr = vol.hdr ?? vol.header;
  if (hdr?.affine) {
    const a = hdr.affine;
    if (Array.isArray(a) && a.length === 16) return [...a];
    if (Array.isArray(a) && a.length >= 3) {
      return [
        a[0][0], a[0][1], a[0][2], a[0][3],
        a[1][0], a[1][1], a[1][2], a[1][3],
        a[2][0], a[2][1], a[2][2], a[2][3],
        0, 0, 0, 1,
      ];
    }
  }
  if (vol.matRAS) {
    const m = vol.matRAS;
    return [
      m[0][0], m[0][1], m[0][2], m[0][3],
      m[1][0], m[1][1], m[1][2], m[1][3],
      m[2][0], m[2][1], m[2][2], m[2][3],
      0, 0, 0, 1,
    ];
  }
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function spatialDims3(vol) {
  const dims = vol.hdr?.dims ?? vol.dims ?? [3, 1, 1, 1];
  return [dims[1] ?? 1, dims[2] ?? 1, dims[3] ?? 1];
}

function niftiDimsFromVolume(vol) {
  return spatialDims3(vol);
}

function pixDimsFromVolume(vol, niftiDims) {
  const hdr = vol.hdr ?? vol.header;
  const pixDims = hdr?.pixDims ?? hdr?.pixDim ?? vol.pixDims ?? [1, 1, 1, 1];
  const affine = affineFromVolume(vol);
  const sx = Math.hypot(affine[0], affine[4], affine[8]) || 1;
  const sy = Math.hypot(affine[1], affine[5], affine[9]) || 1;
  const sz = Math.hypot(affine[2], affine[6], affine[10]) || 1;
  const out = [sx, sy, sz];
  for (let i = 3; i < niftiDims.length; i++) out.push(pixDims[i + 1] ?? 1);
  return out;
}

/** Physical width/height ratio for axial slice (Niivue SLICE_TYPE.AXIAL). */
export function getAxialAspectRatio(vol) {
  if (!vol) return 1;
  const dims = spatialDims3(vol);
  const pix = pixDimsFromVolume(vol, dims);
  const w = dims[0] * pix[0];
  const h = dims[1] * pix[1];
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return 1;
  return w / h;
}

function symmetricClim(data) {
  let maxAbs = 0;
  const stride = Math.max(1, Math.floor(data.length / 200_000));
  for (let i = 0; i < data.length; i += stride) {
    const a = Math.abs(data[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs <= 0) maxAbs = 1;
  return [-maxAbs, maxAbs];
}

/**
 * Build a diff NIfTI blob URL from two loaded volumes.
 * @param {object} volA
 * @param {object} volB
 * @param {{ abs?: boolean, reverse?: boolean, frame4D?: number }} opts
 * @returns {{ url: string, name: string, calMin: number, calMax: number }}
 */
export function buildDiffVolumeUrl(volA, volB, opts = {}) {
  if (!volA?.img || !volB?.img) {
    throw new Error("Scan volumes must be loaded in memory (view them in the main viewer first).");
  }
  if (!dimsMatch(volA, volB)) {
    throw new Error("Scans must have matching matrix dimensions for a difference plot.");
  }

  const frame4D = opts.frame4D ?? 0;
  const bufA = volumeFrameSlice(volA, frame4D);
  const bufB = volumeFrameSlice(volB, frame4D);
  if (!bufA || !bufB || bufA.length !== bufB.length) {
    throw new Error("Could not read voxel buffers for difference.");
  }

  const diff = new Float32Array(bufA.length);
  for (let i = 0; i < bufA.length; i++) {
    let d = opts.reverse ? bufB[i] - bufA[i] : bufA[i] - bufB[i];
    if (opts.abs) d = Math.abs(d);
    diff[i] = d;
  }

  const niftiDims = niftiDimsFromVolume(volA);
  const pixDims = pixDimsFromVolume(volA, niftiDims);
  const affine = affineFromVolume(volA);
  const [calMin, calMax] = symmetricClim(diff);

  const bytes = NVImage.createNiftiArray(niftiDims, pixDims, affine, 16, diff);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const left = opts.left ?? "A";
  const right = opts.right ?? "B";
  const name = opts.abs
    ? `diff_|${left}-${right}|.nii`
    : opts.reverse
      ? `diff_${right}-${left}.nii`
      : `diff_${left}-${right}.nii`;

  return { url, name, calMin, calMax };
}

/**
 * Resolve expression to load parameters for a panel.
 * @param {string} expr
 * @param {number} frame4D
 * @returns {Promise<{ url: string, name: string, isDiff: boolean, frame4D: number, calMin?: number, calMax?: number, colormap: string, error?: string }>}
 */
export async function resolvePanelLoad(expr, frame4D = 0) {
  const parsed = parsePanelExpr(expr);
  if (!parsed) {
    return { error: "Invalid expression (e.g. 1, 2, 1-2, |1-2|)", url: "", name: "", isDiff: false, frame4D: 0, colormap: "gray" };
  }

  if (parsed.type === "scan") {
    const src = resolveScanSource(parsed.scanNum);
    if (!src.url) {
      return {
        error: `Scan ${parsed.scanNum} not found`,
        url: "",
        name: "",
        isDiff: false,
        frame4D: 0,
        colormap: "gray",
      };
    }
    return {
      url: src.url,
      name: src.name,
      isDiff: false,
      frame4D: parsed.phase ? 1 : 0,
      colormap: "gray",
    };
  }

  const srcA = resolveScanSource(parsed.left);
  const srcB = resolveScanSource(parsed.right);
  if (!srcA.vol || !srcB.vol) {
    return {
      error: "Diff requires both scans loaded in the main viewer",
      url: "",
      name: "",
      isDiff: true,
      frame4D,
      colormap: "bkr",
    };
  }

  try {
    const built = buildDiffVolumeUrl(srcA.vol, srcB.vol, {
      abs: parsed.abs,
      reverse: false,
      frame4D,
      left: parsed.left,
      right: parsed.right,
    });
    return {
      url: built.url,
      name: built.name,
      isDiff: true,
      frame4D: 0,
      calMin: built.calMin,
      calMax: built.calMax,
      colormap: "bkr",
    };
  } catch (e) {
    return {
      error: e.message || String(e),
      url: "",
      name: "",
      isDiff: true,
      frame4D,
      colormap: "bkr",
    };
  }
}

export function revokeBlobUrl(url) {
  if (url && String(url).startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }
}

export function formatPanelLabel(index) {
  return `${String.fromCharCode(97 + (index % 26))})`;
}

export function findVolumeByScanNumber(scanNum) {
  const nv = window.nvModule?.nv;
  if (!nv?.volumes?.length) return null;
  for (const v of nv.volumes) {
    const m = String(v?.name ?? "").match(/^scan_(\d+)/i);
    if (m && parseInt(m[1], 10) === scanNum) return v;
  }
  return null;
}

export function getProtocolTooltipForScanNumber(scanNum) {
  const vol = findVolumeByScanNumber(scanNum);
  if (vol && window.scanModule?.getProtocolTooltipForVolume) {
    return window.scanModule.getProtocolTooltipForVolume(vol) || "";
  }
  return "";
}

/** Turn multi-line protocol tooltip into one semicolon-separated caption line. */
export function formatProtocolTooltipForCaption(rawTooltip) {
  const lines = String(rawTooltip ?? "").split(/\r?\n/);
  const segments = [];
  let seqLine = "";
  let seqFile = "";
  let protocolLine = "";
  let protName = "";
  const protParams = [];
  let inParams = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("Sequence:")) {
      seqLine = trimmed.replace(/\s+/g, " ");
      inParams = false;
      continue;
    }
    if (trimmed.startsWith("Protocol:")) {
      protocolLine = trimmed.replace(/\s+/g, " ");
      inParams = false;
      continue;
    }
    if (/^prot_\w+:$/.test(trimmed)) {
      protName = trimmed.slice(0, -1);
      inParams = true;
      continue;
    }
    if (inParams) {
      protParams.push(trimmed.replace(/\s+/g, " "));
      continue;
    }
    if (seqLine && !protocolLine && !seqFile) {
      seqFile = trimmed.replace(/\s+/g, " ");
    }
  }

  if (seqLine) segments.push(seqLine);
  if (seqFile) segments.push(seqFile);
  if (protocolLine) segments.push(protocolLine);
  if (protName) {
    segments.push(protParams.length ? `${protName}: ${protParams.join("; ")}` : `${protName}:`);
  }

  return segments.join("; ");
}

function formatScanProtocolCaptionBody(rawTooltip) {
  const full = formatProtocolTooltipForCaption(rawTooltip);
  return full.replace(/^Sequence:\s*/, "");
}

const DIFF_CAPTION_INDENT = "   ";

/**
 * Map scan numbers to panel labels from other scan-only panels in the figure.
 * @param {Array<{ expr?: string, label?: string }>} panels
 * @param {number} excludeIndex
 */
export function buildScanLabelRefs(panels, excludeIndex = -1) {
  const refs = new Map();
  panels.forEach((panel, index) => {
    if (index === excludeIndex) return;
    const expr = String(panel?.expr ?? "").trim();
    if (!expr) return;
    const parsed = parsePanelExpr(expr);
    if (parsed?.type !== "scan") return;
    if (!refs.has(parsed.scanNum)) refs.set(parsed.scanNum, panel.label || formatPanelLabel(index));
  });
  return refs;
}

/** Caption detail for figure legend (scan / diff panels). */
export function getPanelCaptionDetail(expr, opts = {}) {
  const parsed = parsePanelExpr(expr);
  if (!parsed) return "";

  if (parsed.type === "scan") {
    const tip = getProtocolTooltipForScanNumber(parsed.scanNum);
    if (tip) {
      const formatted = formatProtocolTooltipForCaption(tip);
      return parsed.phase ? `${formatted} (phase frame)` : formatted;
    }
    return parsed.phase ? `scan ${parsed.scanNum} (phase)` : `scan ${parsed.scanNum}`;
  }

  if (parsed.type === "diff") {
    const refs = opts.scanLabelRefs;
    const tipL = getProtocolTooltipForScanNumber(parsed.left);
    const tipR = getProtocolTooltipForScanNumber(parsed.right);
    const leftRef = refs?.get(parsed.left);
    const rightRef = refs?.get(parsed.right);
    const bodyL = leftRef ?? (tipL ? formatScanProtocolCaptionBody(tipL) : `scan ${parsed.left}`);
    const bodyR = rightRef ?? (tipR ? formatScanProtocolCaptionBody(tipR) : `scan ${parsed.right}`);
    return [
      "Difference of Sequence and Reference;",
      `${DIFF_CAPTION_INDENT}Sequence: ${bodyL}`,
      `${DIFF_CAPTION_INDENT}Reference: ${bodyR}`,
    ].join("\n");
  }

  return String(expr).trim();
}
