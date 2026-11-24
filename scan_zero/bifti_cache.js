import {
  readStoredSimBackendId,
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
 * Sim gateway (phantom list + HTTP sim jobs) of `backendId`, else of the stored backend
 * choice. Override via `window.ANYFIELD_HTTP_SIM_URL`.
 * @param {string|null} [backendId] — e.g. `ctx.scan.getSelectedSimBackendId()`
 */
export function simGatewayBase(backendId = null) {
  const spec = (backendId && SIM_BACKENDS[backendId]) || SIM_BACKENDS[readStoredSimBackendId()];
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
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadPhantomTarGz(id) {
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
  return await res.arrayBuffer();
}
