/**
 * Main-thread client for seq_check Pyodide worker (queued RPC + Pyodide-shaped bridge).
 */

let nextId = 1;

/**
 * @typedef {object} SeqCheckPyBridge
 * @property {(code: string) => Promise<unknown>} runPythonAsync
 * @property {{ set: (key: string, value: unknown) => void }} globals
 * @property {{ writeFile: (path: string, data: string) => void, readFile: (path: string) => Promise<Uint8Array> }} FS
 */

export class SeqCheckPyClient {
    /** @param {Worker} worker */
    constructor(worker) {
        this._worker = worker;
        this._ready = false;
        this._gen = 0;
        /** @type {Map<number, { resolve: Function, reject: Function, gen: number }>} */
        this._pending = new Map();
        /** @type {Promise<void>} */
        this._chain = Promise.resolve();
        /** @type {SeqCheckPyBridge | null} */
        this._bridge = null;

        worker.onmessage = (ev) => this._onMessage(ev);
        worker.onerror = (e) => {
            console.error('[seq_check py worker]', e);
            for (const [, p] of this._pending) {
                p.reject(new Error(e.message || 'Worker error'));
            }
            this._pending.clear();
        };
    }

    static create() {
        const worker = new Worker(new URL('./seq_check_py_worker.js', import.meta.url), {
            type: 'module',
        });
        return new SeqCheckPyClient(worker);
    }

    get ready() {
        return this._ready;
    }

    /** Duck-typed Pyodide handle for seq_plot.js and fig modules. */
    getBridge() {
        if (!this._bridge) {
            const client = this;
            this._bridge = {
                runPythonAsync: (code) => client.runPython(code),
                globals: {
                    set: (key, value) => {
                        void client._enqueue('globalsSet', { key, value }, client._gen);
                    },
                },
                FS: {
                    writeFile: (path, data) => {
                        void client._enqueue('fsWrite', { path, data }, client._gen);
                    },
                    readFile: (path) => client.fsRead(path),
                },
            };
        }
        return this._bridge;
    }

    bumpGeneration() {
        this._gen += 1;
        void this._enqueue('setGen', { gen: this._gen }, this._gen);
        return this._gen;
    }

    getGeneration() {
        return this._gen;
    }

    async init() {
        const gen = this._gen;
        await this._enqueue('init', {}, gen);
        this._ready = true;
    }

    /**
     * @param {string} code
     * @returns {Promise<string | null>}
     */
    async runPython(code) {
        const v = await this._enqueue('runPython', { code }, this._gen);
        return v == null ? null : String(v);
    }

    /**
     * @param {string} key
     * @param {unknown} value
     */
    globalsSet(key, value) {
        return this._globalsSet(key, value);
    }

    async globalsSet(key, value) {
        await this._enqueue('globalsSet', { key, value }, this._gen);
    }

    async fsWrite(path, data) {
        await this._enqueue('fsWrite', { path, data }, this._gen);
    }

    /**
     * @param {string} path
     * @returns {Promise<Uint8Array>}
     */
    async fsRead(path) {
        const bytes = await this._enqueue('fsRead', { path }, this._gen, true);
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    }

    terminate() {
        this._worker.terminate();
        this._ready = false;
        this._bridge = null;
    }

    _onMessage(ev) {
        const msg = ev.data || {};
        if (msg.type === 'pyout' && msg.line) {
            console.log(msg.line);
            return;
        }
        if (msg.type === 'pyerr' && msg.line) {
            console.warn(msg.line);
            return;
        }
        if (msg.type === 'log' && msg.msg) {
            if (this._onLog) this._onLog(msg.msg);
            return;
        }
        if (msg.type !== 'result' || msg.id == null) return;

        const pending = this._pending.get(msg.id);
        if (!pending) return;
        this._pending.delete(msg.id);

        if (msg.stale || msg.gen !== pending.gen) {
            pending.reject(new Error('Stale Pyodide request'));
            return;
        }
        if (msg.ok === false) {
            pending.reject(new Error(msg.error || 'Pyodide worker error'));
            return;
        }
        if (pending.wantBytes) {
            pending.resolve(msg.bytes ?? null);
        } else {
            pending.resolve(msg.value ?? null);
        }
    }

    /**
     * @param {string} type
     * @param {object} payload
     * @param {number} gen
     * @param {boolean} [wantBytes]
     */
    _enqueue(type, payload, gen, wantBytes = false) {
        const run = () => {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                this._pending.set(id, { resolve, reject, gen, wantBytes });
                this._worker.postMessage({ id, type, gen, ...payload });
            });
        };
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => {});
        return p;
    }
}

/**
 * @param {{ onLog?: (msg: string) => void }} [opts]
 */
export async function createSeqCheckPyClient(opts = {}) {
    const client = SeqCheckPyClient.create();
    client._onLog = opts.onLog || null;
    await client.init();
    return client;
}
