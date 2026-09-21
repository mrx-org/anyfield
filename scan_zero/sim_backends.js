/** toolapi-wasm WebSocket URLs (same path `/tool`, different host). */
export const TOOL_CONSEQ = 'wss://tool-conseq.fly.dev/tool';
export const TOOL_TRAJEX = 'wss://tool-trajex.fly.dev/tool';
export const TOOL_RAPISIM = 'wss://tool-rapisim.fly.dev/tool';
export const TOOL_MR0SIM = 'wss://tool-mr0sim.fly.dev/tool';
export const TOOL_MR0SIM_T4 = 'wss://mzaiss--tool-mr0sim-modal-serve-t4.modal.run/tool';
/** Modal HTTP gateway (tool-mr0sim-modal_http); worker chosen per job (`cpu` / `t4` / `a10g` / `a100`). */
export const TOOL_MR0SIM_HTTP_MODAL =
    'https://mzaiss--tool-mr0sim-modal-http-gateway.modal.run';
/** PDGv2 HTTP gateway — same `/v1` contract as `TOOL_MR0SIM_HTTP_MODAL`. */
export const TOOL_PDGV2_HTTP = 'https://mzaiss--pdgv2-gateway.modal.run';
/** Local dev only — set `window.ANYFIELD_HTTP_SIM_URL` to this to use local server. */
export const TOOL_MR0SIM_HTTP = 'http://127.0.0.1:8080';

/** Default sim backend for the single SCAN button (reference HTTP gateway, T4). */
export const DEFAULT_SIM_BACKEND_ID = 'modal_http_t4';
/** Default backend for the pro SCAN ▶▶ button. */
export const DEFAULT_SIM_BACKEND_COMPARE_ID = 'pdgv2_t4';
export const SIM_BACKEND_STORAGE_KEY = 'anyfield.simBackend';
export const SIM_BACKEND_COMPARE_STORAGE_KEY = 'anyfield.simBackendCompare';

/** Pro settings dialog order. */
const SIM_BACKEND_OPTION_IDS = [
    'mr0sim',
    'rapisim',
    'modal_http_cpu',
    'modal_http_t4',
    'modal_http_a10g',
    'modal_http',
    'pdgv2_t4',
    'pdgv2_a10g',
];

/** Sim backend registry — stable ids for TOML `[simulation].backend`. */
export const SIM_BACKENDS = {
    mr0sim: {
        id: 'mr0sim',
        label: 'mr0 CPU (f)',
        toolUrl: TOOL_MR0SIM,
        proOnly: false,
    },
    rapisim: {
        id: 'rapisim',
        label: 'mr0r CPU (f)',
        toolUrl: TOOL_RAPISIM,
        useGpu: false,
        proOnly: true,
    },
    modal_http_cpu: {
        id: 'modal_http_cpu',
        label: 'mr0 CPU (m)',
        transport: 'http',
        httpBaseUrl: TOOL_MR0SIM_HTTP_MODAL,
        worker: 'cpu',
        forwardBackend: 'mrzero',
        recon: false,
        useGpu: false,
        exactTrajectories: true,
        proOnly: false,
    },
    modal_http_t4: {
        id: 'modal_http_t4',
        label: 'mr0 T4 (m)',
        transport: 'http',
        httpBaseUrl: TOOL_MR0SIM_HTTP_MODAL,
        worker: 't4',
        forwardBackend: 'mrzero',
        recon: false,
        useGpu: true,
        exactTrajectories: true,
        proOnly: false,
    },
    modal_http_a10g: {
        id: 'modal_http_a10g',
        label: 'mr0 A10 (m)',
        transport: 'http',
        httpBaseUrl: TOOL_MR0SIM_HTTP_MODAL,
        worker: 'a10g',
        forwardBackend: 'mrzero',
        recon: false,
        useGpu: true,
        exactTrajectories: true,
        proOnly: true,
    },
    modal_http: {
        id: 'modal_http',
        label: 'mr0 A100 (m)',
        transport: 'http',
        httpBaseUrl: TOOL_MR0SIM_HTTP_MODAL,
        worker: 'a100',
        forwardBackend: 'mrzero',
        recon: false,
        useGpu: true,
        exactTrajectories: true,
        proOnly: true,
    },
    pdgv2_t4: {
        id: 'pdgv2_t4',
        label: 'PDGv2 T4 (m)',
        transport: 'http',
        httpBaseUrl: TOOL_PDGV2_HTTP,
        worker: 't4',
        forwardBackend: 'pdgv2',
        accuracy: 1e-5,
        recon: false,
        useGpu: true,
        exactTrajectories: true,
        proOnly: true,
    },
    pdgv2_a10g: {
        id: 'pdgv2_a10g',
        label: 'PDGv2 A10 (m)',
        transport: 'http',
        httpBaseUrl: TOOL_PDGV2_HTTP,
        worker: 'a10g',
        forwardBackend: 'pdgv2',
        accuracy: 1e-5,
        recon: false,
        useGpu: true,
        exactTrajectories: true,
        proOnly: true,
    },
};

/** Pro settings dialog options (display label → backend id). */
export const SIM_BACKEND_OPTIONS = SIM_BACKEND_OPTION_IDS.map((id) => ({
    id,
    label: SIM_BACKENDS[id].label,
}));

/** Human-readable backend label for queue meta, tooltips, scan button title, etc. */
export function formatSimBackendLabel(backendId) {
    const id = String(backendId || '').trim();
    if (SIM_BACKENDS[id]) return SIM_BACKENDS[id].label;
    return id || 'SIM';
}

/**
 * HTTP sim base URL. `window.ANYFIELD_HTTP_SIM_URL` always wins (local / custom gateway).
 * Otherwise use the backend's own URL (reference vs PDGv2).
 */
export function resolveHttpSimBaseUrl(httpBaseUrl) {
    if (typeof window !== 'undefined' && window.ANYFIELD_HTTP_SIM_URL) {
        return String(window.ANYFIELD_HTTP_SIM_URL).replace(/\/$/, '');
    }
    return String(httpBaseUrl || TOOL_MR0SIM_HTTP_MODAL).replace(/\/$/, '');
}

export function resolveSimBackendId(backendId, fallback = DEFAULT_SIM_BACKEND_ID) {
    const id = String(backendId || '').trim();
    if (SIM_BACKENDS[id]) return id;
    if (id === 'pdgv2') return 'pdgv2_t4';
    if (id === 'mrzero') return DEFAULT_SIM_BACKEND_ID;
    return fallback;
}

export function readStoredSimBackendId() {
    try {
        const raw = localStorage.getItem(SIM_BACKEND_STORAGE_KEY)
            ?? localStorage.getItem('anyfield.simGateway');
        return resolveSimBackendId(raw, DEFAULT_SIM_BACKEND_ID);
    } catch (_) { /* private mode / blocked storage */ }
    return DEFAULT_SIM_BACKEND_ID;
}

export function persistSimBackendId(backendId) {
    const id = SIM_BACKENDS[backendId] ? backendId : DEFAULT_SIM_BACKEND_ID;
    try {
        localStorage.setItem(SIM_BACKEND_STORAGE_KEY, id);
    } catch (_) { /* private mode / blocked storage */ }
}

export function readStoredSimBackendCompareId() {
    try {
        const raw = localStorage.getItem(SIM_BACKEND_COMPARE_STORAGE_KEY)
            ?? localStorage.getItem('anyfield.simGatewayCompare');
        return resolveSimBackendId(raw, DEFAULT_SIM_BACKEND_COMPARE_ID);
    } catch (_) { /* private mode / blocked storage */ }
    return DEFAULT_SIM_BACKEND_COMPARE_ID;
}

export function persistSimBackendCompareId(backendId) {
    const id = SIM_BACKENDS[backendId] ? backendId : DEFAULT_SIM_BACKEND_COMPARE_ID;
    try {
        localStorage.setItem(SIM_BACKEND_COMPARE_STORAGE_KEY, id);
    } catch (_) { /* private mode / blocked storage */ }
}

let _simBackendMatrixUid = 0;

/** One row per backend; radios assign SCAN ▶ and SCAN ▶▶. */
export function simBackendRadioMatrixHtml() {
    const uid = ++_simBackendMatrixUid;
    const head = `
        <div class="sim-backend-matrix-head">
            <span class="sim-backend-matrix-label">Backend</span>
            <span title="SCAN ▶">SCAN ▶</span>
            <span class="sim-backend-col-alt" title="SCAN ▶▶">SCAN ▶▶</span>
        </div>`;
    const rows = SIM_BACKEND_OPTIONS.map((opt) => `
        <div class="sim-backend-matrix-row">
            <span class="sim-backend-matrix-label">${opt.label}</span>
            <input type="radio" class="sim-backend-radio" data-slot="scan" name="sim-be-scan-${uid}" value="${opt.id}" aria-label="SCAN ▶: ${opt.label}">
            <input type="radio" class="sim-backend-radio sim-backend-col-alt" data-slot="compare" name="sim-be-compare-${uid}" value="${opt.id}" aria-label="SCAN ▶▶: ${opt.label}">
        </div>`).join('');
    return `<div class="sim-backend-matrix" role="group" aria-label="Simulation backend">${head}${rows}</div>`;
}

/** HTTP job options for graph prune (both Modal backends). Omit → server defaults. */
export const HTTP_SIM_PRUNE_DEFAULTS = {
    min_state_mag: 1e-4,
    max_state_count: 2000,
    min_emitted_signal: 1e-2,
    min_latent_signal: 1e-2,
};

export const HTTP_SIM_PRUNE_STORAGE_KEY = 'anyfield.httpSimPrune';

const HTTP_SIM_PRUNE_FIELDS = [
    { key: 'min_state_mag', hint: 'prepass prune' },
    { key: 'max_state_count', hint: 'prepass state cap', integer: true },
    { key: 'min_emitted_signal', hint: 'execute prune' },
    { key: 'min_latent_signal', hint: 'execute prune' },
];

export function normalizeHttpSimPruneOptions(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const mag = Number(src.min_state_mag);
    const emitted = Number(src.min_emitted_signal);
    const latent = Number(src.min_latent_signal);
    const count = Math.round(Number(src.max_state_count));
    return {
        min_state_mag: Number.isFinite(mag) ? mag : HTTP_SIM_PRUNE_DEFAULTS.min_state_mag,
        max_state_count: Number.isFinite(count) && count >= 1 ? count : HTTP_SIM_PRUNE_DEFAULTS.max_state_count,
        min_emitted_signal: Number.isFinite(emitted) ? emitted : HTTP_SIM_PRUNE_DEFAULTS.min_emitted_signal,
        min_latent_signal: Number.isFinite(latent) ? latent : HTTP_SIM_PRUNE_DEFAULTS.min_latent_signal,
    };
}

export function readStoredHttpSimPruneOptions() {
    try {
        const raw = localStorage.getItem(HTTP_SIM_PRUNE_STORAGE_KEY);
        if (raw) return normalizeHttpSimPruneOptions(JSON.parse(raw));
    } catch (_) { /* private mode / blocked storage */ }
    return { ...HTTP_SIM_PRUNE_DEFAULTS };
}

export function persistHttpSimPruneOptions(opts) {
    const normalized = normalizeHttpSimPruneOptions(opts);
    try {
        localStorage.setItem(HTTP_SIM_PRUNE_STORAGE_KEY, JSON.stringify(normalized));
    } catch (_) { /* private mode / blocked storage */ }
    return normalized;
}

export function formatHttpSimPruneInput(key, value) {
    if (key === 'max_state_count') return String(Math.round(Number(value)) || HTTP_SIM_PRUNE_DEFAULTS.max_state_count);
    const n = Number(value);
    if (!Number.isFinite(n)) return String(HTTP_SIM_PRUNE_DEFAULTS[key]);
    const abs = Math.abs(n);
    if (n !== 0 && (abs < 1e-2 || abs >= 1e4)) return n.toExponential();
    return String(n);
}

/** Settings-card fields for HTTP graph-prune job options. */
export function httpSimPruneFieldsHtml(opts = readStoredHttpSimPruneOptions()) {
    const v = normalizeHttpSimPruneOptions(opts);
    const rows = HTTP_SIM_PRUNE_FIELDS.map(({ key, hint, integer }) => `
        <label class="sim-prune-row">
            <span class="sim-prune-key">${key}</span>
            <input class="sim-prune-input" type="text" inputmode="${integer ? 'numeric' : 'decimal'}"
                data-prune-key="${key}" value="${formatHttpSimPruneInput(key, v[key])}" spellcheck="false"
                title="${hint}. Negative min-signal values keep the graph unpruned.">
            <span class="sim-prune-hint">${hint}</span>
        </label>`).join('');
    return `
        <div class="sim-prune-fields" role="group" aria-label="PDG settings (m)">
            <div class="sim-prune-head">PDG settings (m)</div>
            ${rows}
        </div>`;
}
