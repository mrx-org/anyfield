import { TOOL_MR0SIM_HTTP_MODAL } from "./sim_backends.js";

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

/** Cache admin (download + upload UI). Override via `window.ANYFIELD_BIFTI_CACHE_ADMIN_URL`. */
export const BIFTI_CACHE_ADMIN_BASE =
  (typeof window !== "undefined" && window.ANYFIELD_BIFTI_CACHE_ADMIN_URL
    ? String(window.ANYFIELD_BIFTI_CACHE_ADMIN_URL)
    : "https://mzaiss--bifti-cache-admin.modal.run").replace(/\/$/, "");

/** Sim gateway (phantom list + HTTP sim jobs). Override via `window.ANYFIELD_HTTP_SIM_URL`. */
export function simGatewayBase() {
  const override = typeof window !== "undefined" ? window.ANYFIELD_HTTP_SIM_URL : null;
  return String(override || TOOL_MR0SIM_HTTP_MODAL).replace(/\/$/, "");
}

/** Normalize id: strip leading/trailing slashes. */
export function normalizeCacheId(id) {
  return String(id || "").trim().replace(/^\/+|\/+$/g, "");
}

/** Split scan-ready id into `{ collection, name }`. */
export function splitCacheId(id) {
  const cid = normalizeCacheId(id);
  const [collection, name] = cid.split("/", 2);
  if (!collection || !name) {
    throw new Error(`Invalid phantom id (expected collection/name): ${cid || "(empty)"}`);
  }
  return { collection, name, id: cid };
}

/** `GET {simGateway}/v1/cache` → scan-ready phantom ids. */
export async function fetchCachedPhantomIds() {
  const url = `${simGatewayBase()}/v1/cache`;
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
  return `${BIFTI_CACHE_ADMIN_BASE}/v1/phantoms/${collection}/${name}/download`;
}

/** Alias for clarity at call sites. */
export const phantomDownloadUrl = cacheDownloadUrl;

/**
 * Download phantom archive bytes via browser `fetch` (HTTPS).
 * Pyodide stdlib `urllib` cannot open https URLs in the browser.
 * @param {string} id — scan-ready id
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadPhantomTarGz(id) {
  const cid = splitCacheId(id).id;
  const url = cacheDownloadUrl(cid);
  const res = await fetch(url);
  if (res.status === 404) {
    throw new Error(
      `Phantom "${cid}" is not on the cache (404). Add it via the cache admin (${BIFTI_CACHE_ADMIN_BASE}) first.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Phantom download failed (${res.status} ${res.statusText}) for "${cid}".`);
  }
  return await res.arrayBuffer();
}
