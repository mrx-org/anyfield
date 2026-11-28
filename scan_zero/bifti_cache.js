import {
  DEFAULT_SIM_BACKEND_ID,
  resolveHttpSimBaseUrl,
  SIM_BACKENDS,
  TOOL_MR0SIM_HTTP_MODAL,
} from "./sim_backends.js";

/**
 * BIfTI cache client — list phantoms on the sim gateway, download from cache admin.
 *
 * Scan-ready id format: `{collection}/{phantom-name}`
 *   e.g. `brainweb-20-v2/subj04-3T-1mm-tra`
 *
 * List scan-ready ids (sim gateway):
 *   GET {simGateway}/v1/cache  →  { "phantoms": ["brainweb-20-v2/subj04-3T-1mm-tra", …] }
 *
 * Full registry + cached flags (cache admin):
 *   GET {cacheAdmin}/v1/phantoms
 *
 * Download cached phantom (cache admin, `.tar.gz`):
 *   GET {cacheAdmin}/v1/phantoms/{collection}/{phantom-name}/download
 *   e.g. https://mzaiss--bifti-cache-admin.modal.run/v1/phantoms/brainweb-20-v2/subj04-3T-1mm-tra/download
 *
 * The same id string is sent to Modal sim as `options.phantom.id`.
 */

/** Fixed default phantom id — loaded on startup and by the "Default phantom" button. */
export const DEFAULT_CACHE_PHANTOM_ID = "brainweb-20-v2/subj04-3T-1mm-tra";

const BIFTI_CACHE_ADMIN_DEFAULT = "https://mzaiss--bifti-cache-admin.modal.run";

/**
 * Cache admin (download + upload UI). Override via `window.ANYFIELD_BIFTI_CACHE_ADMIN_URL`.
 * Read lazily so the override can be set after this module is evaluated.
 */
export function biftiCacheAdminBase() {
  const override = typeof window !== "undefined" ? window.ANYFIELD_BIFTI_CACHE_ADMIN_URL : null;
  return String(override || BIFTI_CACHE_ADMIN_DEFAULT).replace(/\/$/, "");
}

/**
 * Sim gateway (phantom list + HTTP sim jobs) of `backendId`, else of the default
 * SCAN ▶ backend. Override via `window.ANYFIELD_HTTP_SIM_URL`.
 * @param {string|null} [backendId] — e.g. `ctx.scan.getSelectedSimBackendId()`
 */
export function simGatewayBase(backendId = null) {
  const spec = (backendId && SIM_BACKENDS[backendId]) || SIM_BACKENDS[DEFAULT_SIM_BACKEND_ID];
  return resolveHttpSimBaseUrl(spec?.httpBaseUrl || TOOL_MR0SIM_HTTP_MODAL);
}

/** Normalize id: strip leading/trailing slashes. */
export function normalizeCacheId(id) {
  return String(id || "").trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Split a scan-ready id into its parts. Ids are either two-segment folders
 * (`collection/name`, e.g. `brainweb-20-v2/subj04-3T-1mm-tra`) or three-segment
 * config variants (`collection/name/config`, e.g. `user/my-phantom/single-slice`).
 * The folder is always the first two segments; the optional third segment selects
 * an alternate JSON config sharing the folder's NIfTIs.
 * @returns {{ collection: string, name: string, config: string|null, folderId: string, id: string }}
 */
export function splitCacheId(id) {
  const cid = normalizeCacheId(id);
  const parts = cid.split("/").filter(Boolean);
  const [collection, name, config] = parts;
  if (!collection || !name) {
    throw new Error(`Invalid phantom id (expected collection/name[/config]): ${cid || "(empty)"}`);
  }
  return { collection, name, config: config || null, folderId: `${collection}/${name}`, id: cid };
}

/** Two-segment cached folder id for a scan id (drops any config segment). Used for downloads. */
export function phantomFolderId(id) {
  return splitCacheId(id).folderId;
}

/** Alternate-config stem for a scan id (third segment), or null for a default/folder id. */
export function phantomConfigStem(id) {
  return splitCacheId(id).config;
}

/** `GET {simGateway}/v1/cache` → scan-ready phantom ids, on `backendId`'s gateway. */
export async function fetchCachedPhantomIds(backendId = null) {
  const url = `${simGatewayBase(backendId)}/v1/cache`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Cache list failed (${res.status} ${res.statusText})`);
  }
  const data = await res.json();
  const ids = Array.isArray(data?.phantoms) ? data.phantoms : [];
  return ids.map((s) => String(s)).filter(Boolean);
}

/**
 * Direct download URL for a cached phantom archive (JSON + NIfTIs as `.tar.gz`).
 * @param {string} id — `{collection}/{phantom-name}`, e.g. `brainweb-20-v2/subj04-3T-1mm-tra`
 */
export function cacheDownloadUrl(id) {
  const { collection, name } = splitCacheId(id);
  return `${biftiCacheAdminBase()}/v1/phantoms/${collection}/${name}/download`;
}

/**
 * Download phantom archive bytes via browser `fetch` (HTTPS).
 * Pyodide stdlib `urllib` cannot open https URLs in the browser.
 * @param {string} id — scan-ready id
 * @param {(progress: { received: number, total: number }) => void} [onProgress]
 *   `total` is the Content-Length, or 0 when the server omits it.
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadPhantomTarGz(id, onProgress) {
  const cid = splitCacheId(id).id;
  const url = cacheDownloadUrl(cid);
  const res = await fetch(url);
  if (res.status === 404) {
    throw new Error(
      `Phantom "${cid}" is not on the cache (404). Add it via the cache admin (${biftiCacheAdminBase()}) first.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Phantom download failed (${res.status} ${res.statusText}) for "${cid}".`);
  }
  const report = typeof onProgress === "function" ? onProgress : null;
  const total = Number(res.headers.get("content-length")) || 0;
  if (!report || !res.body) {
    const buf = await res.arrayBuffer();
    report?.({ received: buf.byteLength, total: total || buf.byteLength });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    report({ received, total });
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  report({ received, total: total || received });
  return out.buffer;
}

/**
 * Unpack a phantom archive (`.tar.gz`, or a plain `.tar`) in the page, no Pyodide needed.
 * Keeps `.json` / `.nii` / `.nii.gz` members under their base names and skips dotfiles and
 * `__MACOSX` -- the same filter as the worker's `extractAndPopulatePhantom`. JSON files come
 * shallowest first, so a top-level config wins over nested ones.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ jsonFiles: Array<{ name: string, bytes: Uint8Array }>, niftiFiles: Array<{ name: string, bytes: Uint8Array }> }>}
 */
export async function unpackPhantomArchive(bytes) {
  const tar = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
  const jsonEntries = [];
  const niftiFiles = [];
  for (const { path, data } of tarMembers(tar)) {
    const base = path.split("/").pop();
    if (!base || base.startsWith(".") || path.includes("__MACOSX")) continue;
    const low = base.toLowerCase();
    if (low.endsWith(".json")) {
      jsonEntries.push({ rec: { name: base, bytes: data }, depth: path.split("/").length - 1 });
    } else if (low.endsWith(".nii") || low.endsWith(".nii.gz")) {
      niftiFiles.push({ name: base, bytes: data });
    }
  }
  jsonEntries.sort((a, b) => a.depth - b.depth);
  return { jsonFiles: jsonEntries.map((e) => e.rec), niftiFiles };
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Regular-file members of a tar (ustar, GNU long names, pax `path`), as views into `tar`.
 * @param {Uint8Array} tar
 * @returns {Generator<{ path: string, data: Uint8Array }>}
 */
function* tarMembers(tar) {
  const utf8 = new TextDecoder();
  const str = (start, len) => {
    const field = tar.subarray(start, start + len);
    const end = field.indexOf(0);
    return utf8.decode(end < 0 ? field : field.subarray(0, end));
  };
  const size = (start) => {
    if (tar[start] & 0x80) {
      let n = tar[start] & 0x7f;
      for (let i = 1; i < 12; i++) n = n * 256 + tar[start + i];
      return n;
    }
    return parseInt(str(start, 12).trim() || "0", 8);
  };
  let nextPath = null;
  for (let off = 0; off + 512 <= tar.length && tar[off] !== 0;) {
    const header = off;
    const len = size(header + 124);
    const type = String.fromCharCode(tar[header + 156] || 0x30);
    const data = tar.subarray(header + 512, header + 512 + len);
    off = header + 512 + Math.ceil(len / 512) * 512;
    if (type === "L") {
      nextPath = utf8.decode(data).replace(/\0+$/, "");
      continue;
    }
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(utf8.decode(data));
      if (m) nextPath = m[1];
      continue;
    }
    const name = str(header, 100);
    const prefix = str(header + 257, 6) === "ustar" ? str(header + 345, 155) : "";
    const path = nextPath ?? (prefix ? `${prefix}/${name}` : name);
    nextPath = null;
    if (type === "0" || type === "7") yield { path, data };
  }
}
