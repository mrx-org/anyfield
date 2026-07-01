/**
 * Anyfield sequence assistant chat panel.
 * Talks to chat/backend FastAPI; applies actions via seqExplorer.
 */

const DEFAULT_CHAT_API = 'http://127.0.0.1:8765';
const CHAT_ACTION_TYPES = new Set(['select_sequence', 'set_param']);
const STATE_PREFIX = '[Anyfield state]';

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

function parseParamValue(param, raw) {
    if (param.type === 'bool') return !!raw;
    if (param.type === 'int') {
        const n = parseInt(String(raw), 10);
        return Number.isFinite(n) ? n : raw;
    }
    if (param.type === 'float') {
        const n = parseFloat(String(raw));
        return Number.isFinite(n) ? n : raw;
    }
    if (param.type === 'list' || param.type === 'ndarray') {
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

function sequenceShortLabel(fileName, functionName) {
    const stem = String(fileName || '').split('.').pop()?.replace(/\.py$/i, '') || fileName;
    return `${stem}:${functionName}`;
}

function buildPhantomContext() {
    const nv = window.nvModule;
    const group = nv?.getActivePhantomGroup?.();
    if (!group) return null;

    const name = group.jsonName || group.jsonFileName || 'phantom';
    let B0_T = null;
    let gyro_MHz_T = null;
    const raw = nv?.getPhantomJsonContent?.(group);
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            B0_T = parsed?.system?.B0 ?? null;
            gyro_MHz_T = parsed?.system?.gyro ?? null;
        } catch (_) {
            /* ignore parse errors */
        }
    }
    if (B0_T == null && /3T|3-t|3\.0T/i.test(String(name))) B0_T = 3;
    if (B0_T == null && /1\.5T|1-5T/i.test(String(name))) B0_T = 1.5;

    return {
        name,
        json_file: group.jsonFileName || null,
        B0_T,
        gyro_MHz_T,
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

function formatStateBlock(selected) {
    return `${STATE_PREFIX}\n${JSON.stringify({ selected }, null, 2)}`;
}

function formatUserMessageWithState(text, selected) {
    const stateBlock = formatStateBlock(selected);
    return text ? `${stateBlock}\n\n${text}` : stateBlock;
}

function buildSelectedState(ex) {
    const sel = ex?.selectedSequence;
    if (!sel) return null;

    const params = {};
    if (ex.functionParams) {
        for (const param of ex.functionParams) {
            const { hasValue, value } = ex._readCurrentParamValue(param);
            if (hasValue) {
                params[param.name] = parseParamValue(param, value);
            }
        }
    }

    return {
        file: sel.fileName,
        function: sel.functionName,
        label: sequenceShortLabel(sel.fileName, sel.functionName),
        params,
    };
}

function fingerprintSelectedState(selected) {
    if (!selected) return null;
    return JSON.stringify(selected);
}

function buildChatContext(stateChanged = true) {
    const ex = window.seqExplorer;
    return {
        selected: buildSelectedState(ex),
        sequence_catalog: buildSequenceCatalog(ex),
        phantom: buildPhantomContext(),
        pyodide_ready: !!ex?.config?.pyodide,
        state_changed: !!stateChanged,
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
                    applied.push(formatActionSummary(action));
                    break;
                }
                case 'set_param': {
                    ex.updateParamValue(action.name, action.value);
                    applied.push(formatActionSummary(action));
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
    /** Fingerprint of selected state last appended to a new user message. */
    let lastSentStateFingerprint = null;

    function appendMessage(role, content, className = '') {
        const el = document.createElement('div');
        el.className = `chat-msg chat-msg-${role}${className ? ` ${className}` : ''}`;
        el.textContent = content;
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function pingBackend() {
        try {
            const res = await fetch(`${chatApiBase()}/health`, { cache: 'no-store' });
            if (!res.ok) throw new Error(String(res.status));
            statusEl.textContent = 'backend ok';
            statusEl.classList.add('is-ok');
            statusEl.classList.remove('is-error');
        } catch (_) {
            statusEl.textContent = 'backend offline';
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

        const selected = buildSelectedState(window.seqExplorer);
        const fp = fingerprintSelectedState(selected);
        const stateChanged = fp !== lastSentStateFingerprint;
        const includeState = stateChanged && selected;
        const userContent = includeState
            ? formatUserMessageWithState(text, selected)
            : text;
        if (includeState) {
            lastSentStateFingerprint = fp;
        }
        history.push({ role: 'user', content: userContent });

        const requestBody = {
            messages: history,
            context: buildChatContext(includeState),
        };
        chatLog('request', requestBody);

        try {
            const res = await fetch(`${chatApiBase()}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
            if (!res.ok) {
                const detail = await res.text();
                throw new Error(detail || res.statusText);
            }
            const data = await res.json();
            chatLog('response', data);
            const reply = String(data.message || '').trim() || '(no reply)';
            appendMessage('assistant', reply);
            history.push({ role: 'assistant', content: reply });

            const { applied, errors } = await runChatActions(data.actions || []);
            if (applied.length) {
                appendMessage('system', `Applied: ${applied.join('; ')}`, 'chat-msg-actions');
            }
            if (errors.length) {
                appendMessage('system', errors.join('\n'), 'chat-msg-system');
            }
        } catch (err) {
            appendMessage('system', `Error: ${err.message || err}`, 'chat-msg-system');
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
