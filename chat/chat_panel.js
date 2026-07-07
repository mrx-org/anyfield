/**
 * Anyfield sequence assistant chat panel.
 * Talks to chat/backend FastAPI; applies actions via seqExplorer.
 */

const DEFAULT_CHAT_API = 'http://127.0.0.1:8765';
const CHAT_ACTION_TYPES = new Set(['select_sequence', 'set_param']);
const CONTEXT_UPDATE_PREFIX = '[Anyfield context update]';
const CONTEXT_WAIT_MS = 20000;
const CONTEXT_REFRESH_WAIT_MS = 5000;
const MAX_AGENT_LOOPS = 3;
const FAT_WATER_PPM = 3.5;
const DEFAULT_GYRO_MHZ_T = 42.5764;
const DEFAULT_AGENT_PROMPTS = {
    after_select: (
        'You just selected a new sequence (see the context update above).\n'
        + 'User request: {user_request}\n\n'
        + 'Do any parameters on this sequence need adjustment to fulfill that request? '
        + 'Use selected.params and scanner.physics. Emit set_param actions if needed.'
    ),
    final_answer: (
        'The client applied these protocol changes: {applied_actions}\n'
        + 'Original user request: {user_request}\n\n'
        + 'Write one concise final reply summarizing what you changed and answering the user. '
        + 'You performed these changes yourself — do not ask the user to switch sequences. '
        + 'Do not emit an action block.'
    ),
};

function normalizeParamType(type) {
    if (!type || type === 'None' || type === 'NoneType') return 'unknown';
    return type;
}

/** Infer param type for chat context when seqExplorer reports NoneType/unknown. */
function inferTypeFromValue(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'boolean') return 'bool';
    if (typeof raw === 'number') return Number.isInteger(raw) ? 'int' : 'float';
    if (Array.isArray(raw)) return 'list';
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (!s) return 'str';
        if (s === 'true' || s === 'false') return 'bool';
        if (s.startsWith('[')) return 'list';
        if (/^-?\d+$/.test(s)) return 'int';
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return 'float';
        return 'str';
    }
    return null;
}

function inferTypeFromName(name) {
    const n = String(name || '').toLowerCase();
    if (/^n_|^num_|^shots$|^dum|^r_spoil|^nread|^nphase$|^fa_ref$|^fa$/.test(n)) return 'int';
    if (/times$|_s$|^te$|^tr$|^ti|^dwell|^dte$|^slice_thickness$|^alpha$/.test(n)) return 'float';
    if (/^show_|^test_|^timing_|^pe_grad|^ro_grad|^v141|^plot|^write_/.test(n)) return 'bool';
    if (/^experiment_id$|^petype$|^seq_filename$/.test(n)) return 'str';
    if (/inversion_times|^fov/.test(n)) return 'list';
    return null;
}

function effectiveParamType(param, raw) {
    const fromName = inferTypeFromName(param.name);
    const fromValue = inferTypeFromValue(raw);
    const normalized = normalizeParamType(param.type);

    if (normalized !== 'unknown') {
        // UI inputs stringify numbers — do not let that become type "str" in context.
        if (normalized === 'str' && fromName && fromName !== 'str') return fromName;
        if (normalized === 'str' && fromValue && fromValue !== 'str') return fromValue;
        return normalized;
    }
    return fromName || fromValue || 'unknown';
}

function fillAgentPrompt(template, vars) {
    return String(template || '').replace(/\{(\w+)\}/g, (_, key) => (
        vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''
    ));
}

let markdownReady = null;

const KATEX_DELIMITERS = [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '$', right: '$', display: false },
    { left: '\\(', right: '\\)', display: false },
];

function ensureKatexCss() {
    if (document.getElementById('chat-katex-css')) return;
    const link = document.createElement('link');
    link.id = 'chat-katex-css';
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
    document.head.appendChild(link);
}

function loadMarkdown() {
    if (!markdownReady) {
        markdownReady = Promise.all([
            import('https://esm.run/marked@12.0.0'),
            import('https://esm.run/dompurify@3.2.4'),
            import('https://esm.run/katex@0.16.11/contrib/auto-render'),
        ]).then(([markedMod, purifyMod, autoRenderMod]) => {
            ensureKatexCss();
            return {
                marked: markedMod.marked,
                DOMPurify: purifyMod.default,
                renderMathInElement: autoRenderMod.default || autoRenderMod.renderMathInElement,
            };
        });
    }
    return markdownReady;
}

async function formatAssistantMarkdown(text) {
    const { marked, DOMPurify, renderMathInElement } = await loadMarkdown();
    const html = DOMPurify.sanitize(marked.parse(String(text || '')));
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    if (typeof renderMathInElement === 'function') {
        renderMathInElement(wrap, {
            delimiters: KATEX_DELIMITERS,
            throwOnError: false,
            ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        });
    }
    return wrap.innerHTML;
}

function normalizeActions(actions) {
    if (!Array.isArray(actions)) return [];
    return actions.filter((a) => a && CHAT_ACTION_TYPES.has(a.type));
}

function chatDebugEnabled() {
    if (typeof window !== 'undefined' && window.ANYFIELD_CHAT_DEBUG) return true;
    try {
        return localStorage.getItem('anyfield_chat_debug') === '1';
    } catch (_) {
        return false;
    }
}

function chatLog(label, data) {
    if (!chatDebugEnabled()) return;
    console.log(`[anyfield-chat] ${label}`, data);
}

function chatApiBase() {
    if (typeof window !== 'undefined' && window.ANYFIELD_CHAT_URL) {
        return String(window.ANYFIELD_CHAT_URL).replace(/\/$/, '');
    }
    return DEFAULT_CHAT_API;
}

function resolveParamValue(param, raw, type = null) {
    if (raw === null || raw === undefined) return null;
    const t = type || effectiveParamType(param, raw);
    if (t === 'bool') return !!raw;
    if (t === 'int') {
        if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : raw;
        const n = parseInt(String(raw), 10);
        return Number.isFinite(n) ? n : raw;
    }
    if (t === 'float') {
        if (typeof raw === 'number') return Number.isFinite(raw) ? raw : raw;
        const n = parseFloat(String(raw));
        return Number.isFinite(n) ? n : raw;
    }
    if (t === 'list' || t === 'ndarray') {
        if (Array.isArray(raw)) return raw;
        const s = String(raw).trim();
        if (s.startsWith('[')) {
            try {
                return JSON.parse(s);
            } catch (_) {
                /* fall through */
            }
        }
        return raw;
    }
    return raw;
}

function parseParamValue(param, raw) {
    return resolveParamValue(param, raw);
}

function sequenceShortLabel(fileName, functionName) {
    const stem = String(fileName || '').split('.').pop()?.replace(/\.py$/i, '') || fileName;
    return `${stem}:${functionName}`;
}

function inferB0FromPhantomName(name) {
    const s = String(name || '');
    if (!s) return null;
    const decimal = s.match(/(\d+\.\d+)\s*-?\s*T\b/i);
    if (decimal) return parseFloat(decimal[1]);
    const hyphenHalf = s.match(/(\d+)-5T\b/i);
    if (hyphenHalf) return parseFloat(hyphenHalf[1]) + 0.5;
    const integer = s.match(/(?:^|[^.\d])(\d+)\s*-?\s*T\b/i);
    if (integer) return parseFloat(integer[1]);
    return null;
}

function catalogEntryKey(entry) {
    return `${entry.file}:${entry.function}`;
}

function catalogKeysFromCatalog(catalog) {
    return catalog.map(catalogEntryKey).sort();
}

function computeCatalogDiff(prevKeys, nextKeys) {
    const prev = new Set(prevKeys || []);
    const next = new Set(nextKeys);
    return {
        added: nextKeys.filter((k) => !prev.has(k)),
        removed: [...prev].filter((k) => !next.has(k)).sort(),
    };
}

/** General MRI timing hints derived from B0 and phantom tissue properties. */
function computeScannerPhysics(parsed, B0_T, gyro_MHz_T) {
    const physics = {};
    if (B0_T != null && gyro_MHz_T != null) {
        physics.larmor_MHz = Math.round(gyro_MHz_T * B0_T * 1000) / 1000;
        const hz = FAT_WATER_PPM * gyro_MHz_T * B0_T;
        physics.fat_water_delta_hz = Math.round(hz * 10) / 10;
        if (hz > 0) {
            physics.opposed_phase_te_s = Math.round((1 / (2 * hz)) * 100000) / 100000;
        }
    }
    const tissues = parsed?.tissues;
    if (tissues && typeof tissues === 'object') {
        const tissues_s = {};
        const ir_null_ti_s = {};
        for (const [key, t] of Object.entries(tissues)) {
            if (!t || typeof t !== 'object') continue;
            const entry = {};
            for (const prop of ['T1', 'T2']) {
                if (typeof t[prop] === 'number') entry[prop] = t[prop];
            }
            if (Object.keys(entry).length) tissues_s[key] = entry;
            if (typeof t.T1 === 'number') {
                ir_null_ti_s[key] = Math.round(t.T1 * Math.LN2 * 100000) / 100000;
            }
        }
        if (Object.keys(tissues_s).length) physics.tissues_s = tissues_s;
        if (Object.keys(ir_null_ti_s).length) {
            physics.ir_null_ti_s = ir_null_ti_s;
            physics.legend = {
                tissues_s: 'T1/T2 relaxation times in seconds',
                ir_null_ti_s: 'IR inversion-null time in seconds (= tissue T1 * ln(2)); use for TI/TI_s, not tissues_s.T1',
                opposed_phase_te_s: 'Echo time for fat-water opposed phase in seconds',
                fat_water_delta_hz: 'Fat-water chemical shift in Hz',
            };
        }
    }
    return physics;
}

/** Scanner / phantom context — always an object (never null). */
function buildScannerContext() {
    const nv = window.nvModule;
    const base = {
        name: 'unknown',
        json_file: null,
        B0_T: null,
        gyro_MHz_T: DEFAULT_GYRO_MHZ_T,
        physics: {},
    };
    if (!nv) return base;

    let group = nv.getActivePhantomGroup?.() ?? null;
    let raw = group ? nv.getPhantomJsonContent?.(group) : null;
    let jsonFile = group?.jsonFileName || group?.jsonName || null;

    if (!raw && nv.getSelectedJsonForSim) {
        const simJson = nv.getSelectedJsonForSim(group);
        if (simJson?.content?.trim()) {
            raw = simJson.content;
            jsonFile = simJson.fileName || jsonFile;
        }
    }

    if (!raw && nv.volumeGroups?.length) {
        group = nv.volumeGroups.find(
            (g) => g.jsonContent || g.jsonFileName || g.jsonName,
        ) ?? group;
        if (group) {
            raw = nv.getPhantomJsonContent?.(group) || group.jsonContent || null;
            jsonFile = group.jsonFileName || group.jsonName || jsonFile;
        }
    }

    const name = group?.jsonName || group?.jsonFileName || jsonFile || base.name;
    let parsed = null;
    let B0_T = inferB0FromPhantomName(name);
    let gyro_MHz_T = DEFAULT_GYRO_MHZ_T;

    if (raw) {
        try {
            parsed = JSON.parse(raw);
            B0_T = parsed?.system?.B0 ?? B0_T;
            gyro_MHz_T = parsed?.system?.gyro ?? gyro_MHz_T;
        } catch (_) {
            /* ignore parse errors */
        }
    }

    return {
        name,
        json_file: jsonFile,
        B0_T,
        gyro_MHz_T,
        physics: computeScannerPhysics(parsed, B0_T, gyro_MHz_T),
    };
}

function buildSequenceCatalog(ex) {
    const catalog = [];
    if (!ex?.sequences) return catalog;
    for (const [fileName, data] of Object.entries(ex.sequences)) {
        for (const fn of data.functions || []) {
            catalog.push({ file: fileName, function: fn.name });
        }
    }
    return catalog;
}

function buildParamEntries(ex) {
    if (!ex?.functionParams) return [];
    return ex.functionParams.map((param) => {
        const { hasValue, value } = ex._readCurrentParamValue(param);
        const raw = hasValue ? value : param.default;
        const type = effectiveParamType(param, raw);
        return {
            name: param.name,
            type,
            value: resolveParamValue(param, raw, type),
        };
    });
}

function buildSelectedState(ex) {
    const sel = ex?.selectedSequence;
    if (!sel) return null;

    return {
        file: sel.fileName,
        function: sel.functionName,
        label: sequenceShortLabel(sel.fileName, sel.functionName),
        params: buildParamEntries(ex),
    };
}

/** Wait until selectedSequence and functionParams describe the same protocol. */
async function waitForSelectedParamsSync(fileName, functionName, maxMs = CONTEXT_REFRESH_WAIT_MS) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const ex = window.seqExplorer;
        const sel = ex?.selectedSequence;
        const schema = ex?.functionParams || [];
        if (
            sel?.fileName === fileName
            && sel?.functionName === functionName
            && schema.length > 0
        ) {
            const schemaNames = schema.map((p) => p.name).sort().join('\0');
            const entryNames = buildParamEntries(ex).map((p) => p.name).sort().join('\0');
            if (schemaNames === entryNames) return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    chatLog('selected params sync timeout', { fileName, functionName });
    return false;
}

function snapshotContext() {
    const ex = window.seqExplorer;
    return {
        selected: buildSelectedState(ex),
        catalog: buildSequenceCatalog(ex),
        scanner: buildScannerContext(),
    };
}

function buildApiContext(snapshot) {
    return {
        selected: snapshot.selected,
        catalog: snapshot.catalog,
        scanner: snapshot.scanner,
    };
}

function fingerprintCatalog(catalog) {
    return JSON.stringify(catalogKeysFromCatalog(catalog || []));
}

function fingerprintScanner(scanner) {
    return JSON.stringify(scanner || {});
}

function fingerprintSelected(selected) {
    return JSON.stringify(selected ?? null);
}

function fingerprintSnapshot(snapshot) {
    return {
        catalog: fingerprintCatalog(snapshot.catalog),
        scanner: fingerprintScanner(snapshot.scanner),
        selected: fingerprintSelected(snapshot.selected),
    };
}

function applyModelKnown(modelKnown, fp) {
    if (fp.catalog != null) modelKnown.catalog = fp.catalog;
    if (fp.scanner != null) modelKnown.scanner = fp.scanner;
    if ('selected' in fp) modelKnown.selected = fp.selected;
    if (fp.bootstrapped) modelKnown.bootstrapped = true;
}

/** Diff live state vs what the model was last told (user UI or agent actions). */
function buildContextDelta(snapshot, modelKnown) {
    if (!modelKnown.bootstrapped) {
        return { content: null, updates: {} };
    }

    const delta = {};
    const updates = {};

    const catalogFp = fingerprintCatalog(snapshot.catalog);
    if (catalogFp !== modelKnown.catalog) {
        const prevKeys = modelKnown.catalog ? JSON.parse(modelKnown.catalog) : [];
        const diff = computeCatalogDiff(prevKeys, catalogKeysFromCatalog(snapshot.catalog));
        if (diff.added.length || diff.removed.length) {
            delta.catalog = diff;
            updates.catalog = catalogFp;
        }
    }

    const scannerFp = fingerprintScanner(snapshot.scanner);
    if (scannerFp !== modelKnown.scanner) {
        delta.scanner = snapshot.scanner;
        updates.scanner = scannerFp;
    }

    const selectedFp = fingerprintSelected(snapshot.selected);
    if (selectedFp !== modelKnown.selected) {
        delta.selected = snapshot.selected;
        updates.selected = selectedFp;
    }

    if (!Object.keys(delta).length) {
        return { content: null, updates: {} };
    }

    return {
        content: `${CONTEXT_UPDATE_PREFIX}\n${JSON.stringify(delta, null, 2)}`,
        updates,
    };
}

function formatActionSummary(action) {
    switch (action.type) {
        case 'select_sequence':
            return `select ${action.function} (${action.file})`;
        case 'set_param':
            return `set ${action.name} = ${JSON.stringify(action.value)}`;
        default:
            return JSON.stringify(action);
    }
}

export async function runChatActions(actions) {
    const ex = window.seqExplorer;
    const steps = normalizeActions(actions);
    if (!ex || !steps.length) {
        return { applied: [], errors: [] };
    }
    const applied = [];
    const errors = [];

    for (const action of steps) {
        try {
            switch (action.type) {
                case 'select_sequence': {
                    const ok = await ex.selectSequenceByFileAndFunction(action.file, action.function);
                    if (!ok) throw new Error(`sequence not found: ${action.file}:${action.function}`);
                    await waitForSelectedParamsSync(action.file, action.function);
                    applied.push(formatActionSummary(action));
                    break;
                }
                case 'set_param': {
                    const params = ex.functionParams || [];
                    const param = params.find((p) => p.name === action.name);
                    if (!param) {
                        throw new Error(
                            `parameter "${action.name}" not on current sequence — select sequence first`,
                        );
                    }
                    let value = action.value;
                    const paramType = effectiveParamType(param, value);
                    if (
                        (paramType === 'list' || paramType === 'ndarray')
                        && value != null
                        && !Array.isArray(value)
                    ) {
                        value = [value];
                    }
                    ex.updateParamValue(action.name, value);
                    applied.push(formatActionSummary({ ...action, value }));
                    break;
                }
            }
        } catch (err) {
            errors.push(`${action.type}: ${err.message || err}`);
        }
    }
    return { applied, errors };
}

export function initChatPanel(containerId) {
    const host = typeof containerId === 'string'
        ? document.getElementById(containerId)
        : containerId;
    if (!host) {
        console.warn('Chat panel: container not found', containerId);
        return null;
    }

    host.innerHTML = `
        <div class="chat-panel">
            <div class="chat-panel-header">
                <span class="chat-panel-title">Sequence assistant</span>
                <span class="chat-panel-status" id="chat-status">checking…</span>
            </div>
            <div class="chat-messages" id="chat-messages">
                <div class="chat-welcome">Ask about MRI parameters or say e.g. “Switch to GRE and set TE to 4 ms”.
Changes apply to the protocol panel in the footer automatically.</div>
            </div>
            <div class="chat-input-row">
                <textarea class="chat-input" id="chat-input" rows="1" placeholder="Message…" aria-label="Chat message"></textarea>
                <button type="button" class="chat-send-btn" id="chat-send">Send</button>
            </div>
        </div>
    `;

    const messagesEl = host.querySelector('#chat-messages');
    const inputEl = host.querySelector('#chat-input');
    const sendBtn = host.querySelector('#chat-send');
    const statusEl = host.querySelector('#chat-status');

    /** @type {{ role: string, content: string }[]} */
    const history = [];
    const modelKnown = {
        bootstrapped: false,
        catalog: null,
        scanner: null,
        selected: null,
    };
    let frozenBootstrapContext = null;
    let sessionBootstrapped = false;
    let maxAgentLoops = MAX_AGENT_LOOPS;
    let agentPrompts = { ...DEFAULT_AGENT_PROMPTS };
    let agentLoopTrace = [];

    function recordAgentTrace(entry) {
        agentLoopTrace.push({ ...entry, at: Date.now() });
        chatLog('agent trace', entry);
    }

    async function appendMessage(role, content, className = '') {
        const el = document.createElement('div');
        el.className = `chat-msg chat-msg-${role}${className ? ` ${className}` : ''}`;
        if (role === 'assistant' && !className) {
            el.classList.add('chat-md');
            el.innerHTML = await formatAssistantMarkdown(content);
        } else {
            el.textContent = content;
        }
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function waitForContextReady(maxMs) {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            const snap = snapshotContext();
            const catalogOk = snap.catalog.length > 0;
            const selectedOk = !!snap.selected;
            const scannerOk = !window.nvModule?.volumeGroups?.length
                || !!window.nvModule.getActivePhantomGroup?.()
                || snap.scanner?.B0_T != null
                || snap.scanner?.name !== 'unknown';
            if (catalogOk && selectedOk && scannerOk) return snap;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const snap = snapshotContext();
        const missing = [];
        if (!snap.catalog.length) missing.push('sequence catalog');
        if (!snap.selected) missing.push('selected sequence');
        if (window.nvModule?.volumeGroups?.length
            && !window.nvModule.getActivePhantomGroup?.()
            && snap.scanner?.name === 'unknown'
            && snap.scanner?.B0_T == null) {
            missing.push('phantom/scanner');
        }
        if (missing.length) {
            throw new Error(`Still loading: ${missing.join(', ')}. Try again in a moment.`);
        }
        return snap;
    }

    async function postChatRequest(userContent, snapshot, { bootstrap = false, agentMeta = null } = {}) {
        history.push({ role: 'user', content: userContent });
        const requestBody = {
            messages: history,
            context: buildApiContext(snapshot),
        };
        if (bootstrap || frozenBootstrapContext) {
            requestBody.bootstrap_context = frozenBootstrapContext || buildApiContext(snapshot);
        }
        if (agentMeta) {
            requestBody.agent_meta = { ...agentMeta, trace: agentLoopTrace };
        }
        chatLog('request', requestBody);

        const res = await fetch(`${chatApiBase()}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        if (!res.ok) {
            history.pop();
            const detail = await res.text();
            throw new Error(detail || res.statusText);
        }
        return res.json();
    }

    function extractReply(data) {
        return String(data?.message || '').trim() || '(no reply)';
    }

    /** Push a context delta into history and advance modelKnown — no LLM call. */
    async function recordContextDelta() {
        const snapshot = snapshotContext();
        const { content, updates } = buildContextDelta(snapshot, modelKnown);
        if (!content) return false;
        history.push({ role: 'user', content });
        applyModelKnown(modelKnown, updates);
        chatLog('context delta recorded', content);
        return true;
    }

    /**
     * One LLM turn. Internal turns update history only; visible turns also update the UI
     * (used for the single final reply at the end of runAgentLoop).
     */
    async function deliverToModel({
        userText = '',
        bootstrap = false,
        internal = false,
        agentMeta = null,
    } = {}) {
        const snapshot = await waitForContextReady(
            bootstrap ? CONTEXT_WAIT_MS : CONTEXT_REFRESH_WAIT_MS,
        );

        if (bootstrap) {
            if (sessionBootstrapped) {
                throw new Error('Internal error: bootstrap called twice');
            }
            frozenBootstrapContext = buildApiContext(snapshot);
        }

        let userContent = userText;
        let pendingUpdates = null;

        if (!bootstrap) {
            const { content: deltaBlock, updates } = buildContextDelta(snapshot, modelKnown);
            if (deltaBlock) {
                pendingUpdates = updates;
                userContent = userText ? `${deltaBlock}\n\n${userText}` : deltaBlock;
            } else if (internal && !userText) {
                return null;
            }
        }

        if (!userContent.trim()) {
            throw new Error('Empty message');
        }

        const data = await postChatRequest(userContent, snapshot, { bootstrap, agentMeta });
        chatLog('response', data);

        if (data?.actions?.length) {
            recordAgentTrace({
                phase: agentMeta?.phase || (internal ? 'internal' : 'user'),
                model_actions: data.actions,
                reply: extractReply(data),
            });
        }

        if (bootstrap) {
            applyModelKnown(modelKnown, { ...fingerprintSnapshot(snapshot), bootstrapped: true });
            sessionBootstrapped = true;
        } else if (pendingUpdates) {
            applyModelKnown(modelKnown, pendingUpdates);
        }

        const reply = extractReply(data);
        history.push({ role: 'assistant', content: reply });
        if (!internal) {
            await appendMessage('assistant', reply);
        }
        return data;
    }

    async function runAgentLoop(initialUserText, { bootstrap = false } = {}) {
        agentLoopTrace = [];
        const appliedAll = [];
        let finalReply = null;
        let data = await deliverToModel({
            userText: initialUserText,
            bootstrap,
            internal: true,
            agentMeta: { phase: 'initial', user_request: initialUserText },
        });
        if (data) finalReply = extractReply(data);

        let loops = 0;

        while (loops < maxAgentLoops && data) {
            const actions = normalizeActions(data.actions || []);
            if (!actions.length) break;

            const selects = actions.filter((a) => a.type === 'select_sequence');
            const params = actions.filter((a) => a.type === 'set_param');

            if (selects.length) {
                const { applied, errors } = await runChatActions(selects);
                if (applied.length) {
                    appliedAll.push(...applied);
                    appendMessage('system', `Applied: ${applied.join('; ')}`, 'chat-msg-actions');
                    recordAgentTrace({ phase: 'apply_select', applied, errors });
                }
                if (errors.length) {
                    appendMessage('system', errors.join('\n'), 'chat-msg-system');
                }
                if (!applied.length) break;

                if (params.length) {
                    await recordContextDelta();
                    const { applied: pApplied, errors: pErrors } = await runChatActions(params);
                    if (pApplied.length) {
                        appliedAll.push(...pApplied);
                        appendMessage('system', `Applied: ${pApplied.join('; ')}`, 'chat-msg-actions');
                        recordAgentTrace({ phase: 'apply_params', applied: pApplied, errors: pErrors });
                    }
                    if (pErrors.length) {
                        appendMessage('system', pErrors.join('\n'), 'chat-msg-system');
                    }
                    await recordContextDelta();
                    break;
                }

                loops += 1;
                data = await deliverToModel({
                    internal: true,
                    userText: fillAgentPrompt(agentPrompts.after_select, {
                        user_request: initialUserText,
                    }),
                    agentMeta: { phase: 'after_select', loop: loops, user_request: initialUserText },
                });
                if (data) finalReply = extractReply(data);
                continue;
            }

            const { applied, errors } = await runChatActions(actions);
            if (applied.length) {
                appliedAll.push(...applied);
                appendMessage('system', `Applied: ${applied.join('; ')}`, 'chat-msg-actions');
                recordAgentTrace({ phase: 'apply_params', applied, errors });
            }
            if (errors.length) {
                appendMessage('system', errors.join('\n'), 'chat-msg-system');
            }
            await recordContextDelta();
            break;
        }

        if (appliedAll.length) {
            const finalData = await deliverToModel({
                internal: true,
                userText: fillAgentPrompt(agentPrompts.final_answer, {
                    user_request: initialUserText,
                    applied_actions: appliedAll.join('; '),
                }),
                agentMeta: {
                    phase: 'final_answer',
                    applied: appliedAll,
                    user_request: initialUserText,
                },
            });
            if (finalData) finalReply = extractReply(finalData);
        }

        await appendMessage('assistant', finalReply || '(no reply)');
    }

    async function pingBackend() {
        try {
            const res = await fetch(`${chatApiBase()}/health`, { cache: 'no-store' });
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json();
            if (Number.isFinite(data.max_agent_loops) && data.max_agent_loops > 0) {
                maxAgentLoops = data.max_agent_loops;
            }
            if (data.agent_prompts) {
                agentPrompts = { ...DEFAULT_AGENT_PROMPTS, ...data.agent_prompts };
            }
            loadMarkdown().catch(() => {});
            statusEl.textContent = 'backend ok';
            statusEl.classList.add('is-ok');
            statusEl.classList.remove('is-error');
        } catch (_) {
            statusEl.textContent = 'offline';
            statusEl.classList.add('is-error');
            statusEl.classList.remove('is-ok');
        }
    }

    async function sendMessage() {
        const text = inputEl.value.trim();
        if (!text) return;

        inputEl.value = '';
        sendBtn.disabled = true;
        appendMessage('user', text);

        try {
            await runAgentLoop(text, { bootstrap: !sessionBootstrapped });
        } catch (err) {
            await appendMessage('system', `Error: ${err.message || err}`, 'chat-msg-system');
        } finally {
            sendBtn.disabled = false;
            inputEl.focus();
        }
    }

    sendBtn.addEventListener('click', sendMessage);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    pingBackend();
    setInterval(pingBackend, 30000);

    return { host, pingBackend };
}
