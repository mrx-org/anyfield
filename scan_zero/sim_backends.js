/** toolapi-wasm WebSocket URLs (same path `/tool`, different host). */
export const TOOL_CONSEQ = 'wss://tool-conseq.fly.dev/tool';
export const TOOL_TRAJEX = 'wss://tool-trajex.fly.dev/tool';
export const TOOL_RAPISIM = 'wss://tool-rapisim.fly.dev/tool';
export const TOOL_MR0SIM = 'wss://tool-mr0sim.fly.dev/tool';
export const TOOL_MR0SIM_T4 = 'wss://mzaiss--tool-mr0sim-modal-serve-t4.modal.run/tool';
/** Modal HTTP gateway (tool-mr0sim-modal_http); worker chosen per job (`cpu` / `t4` / `a10g` / `a100`). */
export const TOOL_MR0SIM_HTTP_MODAL =
    'https://mzaiss--tool-mr0sim-modal-http-gateway.modal.run';
/** Local dev only — set `window.ANYFIELD_HTTP_SIM_URL` to this to use local server. */
export const TOOL_MR0SIM_HTTP = 'http://127.0.0.1:8080';

/** Default sim backend for the single SCAN button. */
export const DEFAULT_SIM_BACKEND_ID = 'modal_http_t4';

/** Pro settings dialog order. */
const SIM_BACKEND_OPTION_IDS = [
    'mr0sim',
    'rapisim',
    'modal_http_cpu',
    'modal_http_t4',
    'modal_http_a10g',
    'modal_http',
];

/** Sim backend registry — stable ids for TOML `[simulation].backend`. */
export const SIM_BACKENDS = {
    mr0sim: {
        id: 'mr0sim',
        label: 'mr0 CPU (f)',
        toolUrl: TOOL_MR0SIM,
        reconBackend: 'mr0',
        proOnly: false,
    },
    rapisim: {
        id: 'rapisim',
        label: 'mr0r CPU (f)',
        toolUrl: TOOL_RAPISIM,
        reconBackend: 'mr0',
        useGpu: false,
        proOnly: true,
    },
    modal_http_cpu: {
        id: 'modal_http_cpu',
        label: 'mr0 CPU (m)',
        transport: 'http',
        httpBaseUrl: TOOL_MR0SIM_HTTP_MODAL,
        worker: 'cpu',
        reconBackend: 'mr0',
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
        reconBackend: 'mr0',
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
        reconBackend: 'mr0',
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
        reconBackend: 'mr0',
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
