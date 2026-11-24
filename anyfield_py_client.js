/**
 * Main-thread client for the app's Pyodide worker.
 *
 * Requests are serialised into one chain, matching the seq_check client this is
 * modelled on: Pyodide is single-threaded, so overlapping `runPythonAsync` calls
 * would interleave against the same interpreter globals.
 *
 * `getBridge()` returns a handle shaped like the subset of `PyodideInterface` the app
 * actually uses (`runPythonAsync`, `runPythonBytes`, `globals.set`, `FS.writeFile`,
 * `FS.readFile`), so a call site can move onto the worker by swapping which object it
 * was handed. The one unavoidable difference is that `FS.readFile` is async here; a
 * synchronous VFS read cannot be emulated across a worker boundary at all.
 */

let nextId = 1;

/** @param {unknown} x @returns {Uint8Array} */
function asU8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) {
        return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    }
    return new Uint8Array(0);
}

/** Rebuild a worker-side exception locally, preserving what callers switch on. */
function reviveError(payload, fallback) {
    if (!payload) return new Error(fallback || 'Pyodide worker error');
    if (typeof payload === 'string') return new Error(payload);
    const err = new Error(payload.message || fallback || 'Pyodide worker error');
    if (payload.name) err.name = payload.name;
    // `formatPyodideError` branches on `errno === 44` / `name === 'ErrnoError'`, and
    // the EEXIST guards around the phantom VFS writes branch on errno too.
    if (typeof payload.errno === 'number') err.errno = payload.errno;
    if (payload.pyType) err.type = payload.pyType;
    if (payload.stack) err.workerStack = payload.stack;
    return err;
}

export class AnyfieldPyClient {
    /** @param {Worker} worker */
    constructor(worker) {
        this._worker = worker;
        this._ready = false;
        this._runtimeReady = false;
        this._initRuntimePromise = null;
        this._gen = 0;
        /** @type {Map<number, { resolve: Function, reject: Function, gen: number, wantBytes: boolean, onProgress?: Function }>} */
        this._pending = new Map();
        this._chain = Promise.resolve();
        this._bridge = null;
        this._onLog = null;

        worker.onmessage = (ev) => this._onMessage(ev);
        worker.onerror = (e) => {
            console.error('[anyfield py worker]', e);
            const err = new Error(e?.message || 'Worker error');
            for (const [, p] of this._pending) p.reject(err);
            this._pending.clear();
        };
    }

    static create() {
        const worker = new Worker(new URL('./anyfield_py_worker.js', import.meta.url), {
            type: 'module',
        });
        return new AnyfieldPyClient(worker);
    }

    get ready() {
        return this._ready;
    }

    /**
     * Duck-typed Pyodide handle. `FS.writeFile` and `globals.set` are synchronous on
     * the real Pyodide object, so they stay fire-and-forget here — they are ordered
     * behind earlier work by the same chain every other call uses, so a subsequent
     * `runPython` still sees their effect.
     */
    getBridge() {
        if (!this._bridge) {
            const client = this;
            this._bridge = {
                runPythonAsync: (code) => client.runPython(code),
                runPythonBytes: (code) => client.runPythonBytes(code),
                globals: {
                    set: (key, value) => {
                        void client._enqueue('globalsSet', { key, value });
                    },
                },
                FS: {
                    writeFile: (path, data) => {
                        void client.fsWrite(path, data);
                    },
                    readFile: (path) => client.fsRead(path),
                    unlink: (path) => {
                        void client._enqueue('fsUnlink', { path });
                    },
                },
            };
        }
        return this._bridge;
    }

    /**
     * Invalidate in-flight work. Results stamped with an older generation are
     * discarded on arrival. Note this does *not* free the worker: a stale
     * multi-second call still runs to completion, because cancelling Python mid-run
     * needs `setInterruptBuffer`, which needs a `SharedArrayBuffer`, which needs
     * COOP/COEP headers this app is not served with.
     */
    bumpGeneration() {
        this._gen += 1;
        void this._enqueue('setGen', { gen: this._gen }, { gen: this._gen });
        return this._gen;
    }

    getGeneration() {
        return this._gen;
    }

    /**
     * Load Pyodide only (stdlib gzip/tar). Extract can stop here; packages wait
     * for `init()`.
     * @param {{ indexURL?: string, onProgress?: Function }} [opts]
     */
    async initRuntime(opts = {}) {
        if (this._runtimeReady) return;
        if (!this._initRuntimePromise) {
            this._initRuntimePromise = this._enqueue('init', { opts: { indexURL: opts.indexURL } }, {
                onProgress: opts.onProgress,
            }).then(() => {
                this._runtimeReady = true;
            }).catch((e) => {
                this._initRuntimePromise = null;
                throw e;
            });
        }
        await this._initRuntimePromise;
    }

    /**
     * @param {{ indexURL?: string, packages?: object, modules?: Array<object>, onProgress?: Function }} [opts]
     */
    async init(opts = {}) {
        await this.initRuntime(opts);
        if (opts.packages) {
            await this._enqueue('installPackages', { spec: opts.packages }, {
                onProgress: opts.onProgress,
            });
        }
        if (opts.modules?.length) {
            await this._enqueue('loadPyModules', { modules: opts.modules }, {
                onProgress: opts.onProgress,
            });
        }
        this._ready = true;
    }

    /**
     * @param {string} code
     * @param {{ globals?: Record<string, unknown>, onProgress?: Function,
     *           transfer?: Transferable[] }} [opts] `globals` are set worker-side in the
     *   same message as the run. Prefer it over separate `globalsSet` calls whenever the
     *   code depends on them: only whole messages are serialised, so two callers issuing
     *   `globalsSet` then `runPython` interleave and read each other's inputs.
     * @returns {Promise<string | null>}
     */
    async runPython(code, opts = {}) {
        const payload = opts.globals ? { code, globals: opts.globals } : { code };
        const v = await this._enqueue('runPython', payload, opts);
        return v == null ? null : String(v);
    }

    /**
     * Same queue as `runPython`, but keeps a bytes/bytearray result as `Uint8Array`
     * (transferable). `runPython` `toString()`s, which cannot carry the ChartGPU xy blob.
     * @param {string} code
     * @param {{ globals?: Record<string, unknown>, onProgress?: Function,
     *           transfer?: Transferable[] }} [opts]
     * @returns {Promise<Uint8Array>}
     */
    async runPythonBytes(code, opts = {}) {
        const payload = opts.globals ? { code, globals: opts.globals } : { code };
        const bytes = await this._enqueue('runPython', payload, { ...opts, wantBytes: true });
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    }

    /**
     * @param {{ load?: string[], micropip?: Array<{ name: string, deps?: boolean, optional?: boolean }|string> }} spec
     * @param {{ onProgress?: Function }} [opts]
     */
    async installPackages(spec = {}, opts = {}) {
        return this._enqueue('installPackages', { spec }, opts);
    }

    /**
     * Silent / ChartGPU sequence execute + harvest on the worker. One message so
     * JS never getattr `_last_sequence` / `__main__.seq` on the main interpreter.
     * @param {{ modulePath: string, functionName: string, argsDict?: Record<string, string>,
     *           silent?: boolean, plotSpeed?: string, showKspace?: boolean,
     *           timeRange?: [unknown, unknown], timeUnit?: string, gradUnit?: string,
     *           theme?: string, sourceSeqPath?: string|null }} spec
     * @returns {Promise<{ result: object|null, seqBytes: Uint8Array, fovMm: number[]|null,
     *                     matrix: number[]|null, chartgpuJson: object|string|null,
     *                     chartgpuXy: Uint8Array, kspaceJson: object|string|null }>}
     */
    async executeAndHarvest(spec = {}) {
        const value = await this._enqueue('executeAndHarvest', { spec });
        const v = value || {};
        return {
            result: v.result ?? null,
            seqBytes: asU8(v.seqBytes),
            fovMm: v.fovMm ?? null,
            matrix: v.matrix ?? null,
            chartgpuJson: v.chartgpuJson ?? null,
            chartgpuXy: asU8(v.chartgpuXy),
            kspaceJson: v.kspaceJson ?? null,
        };
    }

    /**
     * Set one Python global on its own. Safe for setup that no concurrent caller
     * competes for; for a run's *inputs* use `runPython(code, { globals })`, which
     * cannot interleave with another caller's.
     */
    async globalsSet(key, value) {
        await this._enqueue('globalsSet', { key, value });
    }

    /**
     * @param {string} path
     * @param {Uint8Array | string} data
     * @param {{ transfer?: boolean }} [opts] Transfer moves `data`'s buffer to the
     *   worker, which leaves it detached and unusable here. Only pass a buffer the
     *   caller is finished with.
     */
    async fsWrite(path, data, opts = {}) {
        if (opts.transfer && data instanceof Uint8Array) {
            const buf = data.buffer;
            await this._enqueue('fsWrite', { path, data: buf }, { transfer: [buf] });
            return;
        }
        await this._enqueue('fsWrite', { path, data });
    }

    /**
     * @param {string} path
     * @param {{ unlink?: boolean }} [opts]
     * @returns {Promise<Uint8Array>}
     */
    async fsRead(path, opts = {}) {
        const bytes = await this._enqueue(
            'fsRead',
            { path, opts: { unlink: !!opts.unlink } },
            { wantBytes: true },
        );
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    }

    async fsUnlink(path) {
        await this._enqueue('fsUnlink', { path });
    }

    /**
     * @param {string} path
     * @returns {Promise<string[]>}
     */
    async fsReaddir(path) {
        const names = await this._enqueue('fsReaddir', { path });
        return Array.isArray(names) ? names : [];
    }

    /**
     * @param {{ tarBytes: Uint8Array | ArrayBuffer }} spec
     * @returns {Promise<{ jsonFiles: Array<{ name: string, bytes: Uint8Array }>, niftiFiles: Array<{ name: string, bytes: Uint8Array }> }>}
     */
    async extractAndPopulatePhantom(spec = {}) {
        const src = spec.tarBytes;
        const u8 = src instanceof Uint8Array ? src : new Uint8Array(src || []);
        const opts = {};
        let payload = u8;
        if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
            payload = u8.buffer;
            opts.transfer = [u8.buffer];
        }
        const value = await this._enqueue('extractAndPopulatePhantom', { tarBytes: payload }, opts);
        return value || { jsonFiles: [], niftiFiles: [] };
    }

    /**
     * @param {{ jsonName: string, jsonBody?: string }} spec
     * @returns {Promise<{ files: Array<{ name: string, path: string, bytes: Uint8Array }> }>}
     */
    async executePhantom(spec = {}) {
        const value = await this._enqueue('executePhantom', {
            jsonName: spec.jsonName,
            jsonBody: spec.jsonBody,
        });
        return value || { files: [] };
    }

    terminate() {
        this._worker.terminate();
        this._ready = false;
        this._runtimeReady = false;
        this._initRuntimePromise = null;
        this._bridge = null;
        const err = new Error('Pyodide worker terminated');
        for (const [, p] of this._pending) p.reject(err);
        this._pending.clear();
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
        if (msg.type === 'progress') {
            const pending = this._pending.get(msg.id);
            if (pending?.onProgress) pending.onProgress(msg);
            else if (this._onLog) this._onLog(msg.phase);
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
            pending.reject(reviveError(msg.error));
            return;
        }
        pending.resolve(pending.wantBytes ? (msg.bytes ?? null) : (msg.value ?? null));
    }

    /**
     * @param {string} type
     * @param {object} payload
     * @param {{ gen?: number, wantBytes?: boolean, onProgress?: Function, transfer?: Transferable[] }} [opts]
     */
    _enqueue(type, payload, opts = {}) {
        const gen = opts.gen ?? this._gen;
        const run = () => {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                this._pending.set(id, {
                    resolve,
                    reject,
                    gen,
                    wantBytes: !!opts.wantBytes,
                    onProgress: opts.onProgress,
                });
                this._worker.postMessage({ id, type, gen, ...payload }, opts.transfer || []);
            });
        };
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => {});
        return p;
    }
}

/**
 * @param {{ onLog?: Function, onProgress?: Function, packages?: object, modules?: Array<object> }} [opts]
 */
export async function createAnyfieldPyClient(opts = {}) {
    const client = AnyfieldPyClient.create();
    client._onLog = opts.onLog || null;
    await client.init(opts);
    return client;
}
