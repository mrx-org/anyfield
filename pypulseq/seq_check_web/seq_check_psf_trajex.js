/**
 * PSF k-space + signal via tool-trajex signal=True (matches seq_check.py get_or_compute_psf_bundle).
 *
 * tool-trajex (Rust): signal=false → root TypedList<Vec4>; signal=true → Dict { kspace, signal }.
 */

import init, { call } from 'https://unpkg.com/toolapi-wasm@0.4.5/toolapi_wasm.js';

const CONSEQ_ADDR = 'wss://tool-conseq.fly.dev/tool';
const TRAJEX_ADDR = 'wss://tool-trajex.fly.dev/tool';

/** Applied to res/(2·fov) per axis before trajex PSF (relaxes in-simulator Nyquist cutoff). */
const NYQUIST_SCALE_FACTOR = 1.5;

/** Same tissues / T1,T2,T2' as seq_check.py get_or_compute_psf_bundle. */
export const PSF_TISSUES = [
    { name: 'Gray Matter', T1: 1.56, T2: 0.083, T2dash: 0.32 },
    { name: 'White Matter', T1: 0.83, T2: 0.075, T2dash: 0.18 },
    { name: 'CSF', T1: 4.16, T2: 1.65, T2dash: 0.059 },
    /** brain_default phantom; PSF trajex uses T1/T2/T2′ only (no dB0 shift). */
    { name: 'Fat', T1: 0.37, T2: 0.125, T2dash: 0.012 },
];

let wasmReady = false;

async function ensureToolApi() {
    if (!wasmReady) {
        await init();
        wasmReady = true;
    }
}

/** Unwrap Ok/Error only — do not strip Dict (payload may live under result.Dict). */
function unwrapOkShell(result) {
    let r = result;
    for (let depth = 0; depth < 8 && r != null; depth++) {
        if (r?.Error) throw new Error(String(r.Error));
        if (r?.Ok !== undefined) {
            r = r.Ok;
            continue;
        }
        break;
    }
    return r;
}

/** toolapi-wasm may represent Value::Dict as a plain object or a JavaScript Map. */
function mapToObject(m) {
    if (!(m instanceof Map)) return m;
    const o = {};
    for (const [k, v] of m.entries()) o[String(k)] = v;
    return o;
}

/**
 * Normalize trajex return to a plain object we can read keys from.
 * signal=false: { TypedList: { Vec4 } } at root
 * signal=true:  { Dict: { kspace, signal } } or Map, or { kspace, signal }
 */
function trajexPayloadRoot(result) {
    const shell = unwrapOkShell(result);
    if (shell == null) return null;

    if (shell instanceof Map) return mapToObject(shell);

    if (shell.Dict != null) {
        if (Array.isArray(shell.Dict)) {
            const o = {};
            for (const entry of shell.Dict) {
                if (Array.isArray(entry) && entry.length >= 2) o[String(entry[0])] = entry[1];
            }
            if (Object.keys(o).length) return o;
        }
        const d = mapToObject(shell.Dict);
        if (d && typeof d === 'object' && !Array.isArray(d)) return d;
    }

    if (shell.TypedList != null) return shell;
    if (shell.kspace != null || shell.signal != null) return shell;

    return shell;
}

function num(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && v.Float !== undefined) return Number(v.Float);
    if (typeof v === 'object' && v.Int !== undefined) return Number(v.Int);
    return Number(v);
}

function toArr(x) {
    if (x == null) return [];
    if (Array.isArray(x)) return x;
    if (x instanceof Map) return Array.from(x.values());
    if (x?.Float != null) return toArr(x.Float);
    if (typeof x.length === 'number') return Array.from(x);
    return [];
}

function vec4Data(v) {
    if (!v || typeof v !== 'object') return null;
    let d = v.data;
    if (d?.Float != null) d = toArr(d.Float);
    else if (d?.TypedList?.Float != null) d = toArr(d.TypedList.Float);
    else d = toArr(d);
    if (d.length >= 3) return d.map(num);
    return null;
}

function vec4Row(v) {
    const raw = v?.Vec4 != null ? v.Vec4 : v;
    if (raw == null) return null;

    const data = vec4Data(raw);
    if (data) {
        return [
            data[0],
            data[1],
            data[2],
            Number.isFinite(data[3]) ? data[3] : 0,
        ];
    }

    if (Array.isArray(raw)) {
        if (raw.length < 3) return null;
        return [num(raw[0]), num(raw[1]), num(raw[2]), num(raw.length > 3 ? raw[3] : 0)];
    }

    if (typeof raw === 'object') {
        return [
            num(raw.k_x ?? raw.kx ?? raw.x ?? raw[0]),
            num(raw.k_y ?? raw.ky ?? raw.y ?? raw[1]),
            num(raw.k_z ?? raw.kz ?? raw.z ?? raw[2]),
            num(raw.tau ?? raw.t ?? raw.time ?? raw[3] ?? 0),
        ];
    }
    return null;
}

function parseKspaceRowsFromList(list) {
    const rows = [];
    for (const item of toArr(list)) {
        const row = vec4Row(item);
        if (row && row.every((x) => Number.isFinite(x))) rows.push(row);
    }
    return rows.length ? rows : null;
}

function parseKspaceN4(payload) {
    const p = payload instanceof Map ? mapToObject(payload) : payload;
    if (p == null) return null;

    if (p.List) {
        const rows = parseKspaceRowsFromList(p.List);
        if (rows) return rows;
    }

    if (p.TypedList?.Vec4) {
        const rows = parseKspaceRowsFromList(p.TypedList.Vec4);
        if (rows) return rows;
    }

    const tl = p.TypedList;
    if (tl) {
        if (tl.Vec4) {
            const rows = parseKspaceRowsFromList(tl.Vec4);
            if (rows) return rows;
        }
        const kx = toArr(tl.k_x ?? tl.kx ?? tl[0]).map(num);
        const ky = toArr(tl.k_y ?? tl.ky ?? tl[1]).map(num);
        const kz = toArr(tl.k_z ?? tl.kz ?? tl[2]).map(num);
        const tau = toArr(tl.tau ?? tl.t ?? tl.time ?? tl[3]).map(num);
        const n = Math.max(kx.length, ky.length, kz.length, tau.length);
        if (n > 0) {
            const rows = [];
            for (let i = 0; i < n; i++) {
                rows.push([
                    Number.isFinite(kx[i]) ? kx[i] : 0,
                    Number.isFinite(ky[i]) ? ky[i] : 0,
                    Number.isFinite(kz[i]) ? kz[i] : 0,
                    Number.isFinite(tau[i]) ? tau[i] : 0,
                ]);
            }
            return rows;
        }
    }

    if (Array.isArray(p)) {
        return parseKspaceRowsFromList(p);
    }

    if (p.Trajectory != null) return parseKspaceN4(p.Trajectory);
    if (p.trajectory != null) return parseKspaceN4(p.trajectory);

    return null;
}

function complexPair(c) {
    if (c == null) return null;
    if (typeof c === 'number') return [c, 0];
    if (Array.isArray(c) && c.length >= 2) return [num(c[0]), num(c[1])];
    if (c.Complex != null) return complexPair(c.Complex);
    if (c.Float != null) {
        const fa = toArr(c.Float).map(num);
        if (fa.length >= 2) return [fa[0], fa[1]];
    }
    const re = c.real ?? c.Real ?? c.re ?? c[0];
    const im = c.imag ?? c.Imag ?? c.im ?? c[1];
    if (re !== undefined && im !== undefined) return [num(re), num(im)];
    return null;
}

function parseSignalFromList(list) {
    const out = [];
    for (const item of toArr(list)) {
        const pair = complexPair(item);
        if (pair && pair.every((x) => Number.isFinite(x))) out.push(pair);
    }
    return out.length ? out : null;
}

function parseSignalReIm(payload) {
    const p = payload instanceof Map ? mapToObject(payload) : payload;
    if (p == null) return null;

    if (p.List) {
        const fromList = parseSignalFromList(p.List);
        if (fromList) return fromList;
    }

    const tl = p.TypedList;
    if (tl) {
        if (tl.Float) {
            const fa = toArr(tl.Float).map(num);
            if (fa.length >= 2) {
                const out = [];
                for (let i = 0; i + 1 < fa.length; i += 2) {
                    out.push([fa[i], fa[i + 1]]);
                }
                if (out.length) return out;
                const half = Math.floor(fa.length / 2);
                if (half > 0) {
                    for (let i = 0; i < half; i++) out.push([fa[i], fa[half + i]]);
                    if (out.length) return out;
                }
            }
        }

        for (const key of ['Complex', 'Cplx', 'Vec2']) {
            if (tl[key] == null) continue;
            const c = tl[key];
            let real = c.real ?? c.Real;
            let imag = c.imag ?? c.Imag;
            if (c.Float) {
                const fa = toArr(c.Float).map(num);
                if (fa.length >= 2) {
                    real = real ?? fa[0];
                    imag = imag ?? fa[1];
                }
            }
            const r = toArr(real).map(num);
            const im = toArr(imag).map(num);
            const n = Math.max(r.length, im.length);
            if (n > 0) {
                const out = new Array(n);
                for (let i = 0; i < n; i++) out[i] = [r[i] || 0, im[i] || 0];
                return out;
            }
            const fromC = parseSignalFromList(c);
            if (fromC) return fromC;
        }

        const rTop = tl.real ?? tl.Real;
        const iTop = tl.imag ?? tl.Imag;
        if (rTop != null && iTop != null) {
            const r = toArr(rTop).map(num);
            const im = toArr(iTop).map(num);
            const n = Math.max(r.length, im.length);
            if (n > 0) {
                const out = new Array(n);
                for (let i = 0; i < n; i++) out[i] = [r[i] || 0, im[i] || 0];
                return out;
            }
        }
    }

    const re = toArr(p.re ?? p.real).map(num);
    const im = toArr(p.im ?? p.imag).map(num);
    if (re.length || im.length) {
        const n = Math.max(re.length, im.length);
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = [re[i] || 0, im[i] || 0];
        return out;
    }

    if (Array.isArray(p)) {
        return parseSignalFromList(p);
    }

    const one = complexPair(p);
    return one ? [one] : null;
}

function describeTrajexResult(result, root) {
    const parts = [];
    if (result instanceof Map) parts.push('top=Map');
    else if (result?.Dict instanceof Map) parts.push('Dict=Map');
    else if (result?.Dict != null) parts.push('Dict=object');
    if (root instanceof Map) parts.push('root=Map');
    else if (root && typeof root === 'object') {
        parts.push(`keys=${Object.keys(root).join(',') || '(none)'}`);
        if (root.TypedList) {
            const tk = Object.keys(root.TypedList);
            parts.push(`TypedList={${tk.join(',')}}`);
        }
    } else {
        parts.push(`root=${typeof root}`);
    }
    return parts.join(' ');
}

/**
 * Parse trajex `signal=True` result → { kspace: number[][], signal: number[][] }.
 */
export function parseTrajexKspaceSignal(result) {
    const root = trajexPayloadRoot(result);
    if (root == null || typeof root !== 'object') {
        throw new Error('trajex returned empty result');
    }

    let kspace = null;
    let signal = null;

    for (const key of ['kspace', 'k_space', 'Kspace', 'KSpace', 'Trajectory', 'trajectory']) {
        if (root[key] != null) {
            kspace = parseKspaceN4(root[key]);
            if (kspace?.length) break;
        }
    }

    for (const key of ['signal', 'Signal', 'signals', 'Signals']) {
        if (root[key] != null) {
            signal = parseSignalReIm(root[key]);
            if (signal?.length) break;
        }
    }

    if (!kspace?.length || !signal?.length) {
        const tl = root.TypedList;
        if (tl) {
            if (!kspace?.length && tl.Vec4) {
                kspace = parseKspaceN4({ TypedList: { Vec4: tl.Vec4 } });
            }
            if (!signal?.length && (tl.Complex || tl.Cplx)) {
                signal = parseSignalReIm({ TypedList: tl });
            }
        }
    }

    if (!kspace?.length) kspace = parseKspaceN4(root);
    if (!signal?.length) signal = parseSignalReIm(root);

    if (!kspace?.length || !signal?.length) {
        const hint = describeTrajexResult(result, root);
        if (kspace?.length && !signal?.length) {
            throw new Error(
                `trajex returned k-space (${kspace.length} pts) but no signal — ` +
                    'confirm request includes signal: { Bool: true } and server returns Value::Dict.',
            );
        }
        throw new Error(
            `trajex signal=True parse failed (${hint}); k=${kspace?.length ?? 0} sig=${signal?.length ?? 0}. ` +
                'Expected Dict { kspace, signal } from tool-trajex when signal=true.',
        );
    }

    const n = Math.min(kspace.length, signal.length);
    return { kspace: kspace.slice(0, n), signal: signal.slice(0, n) };
}

/** toolapi-wasm Vec3: three plain f64 values. */
function nyquistInput(nyquist) {
    return {
        Vec3: [Number(nyquist[0]), Number(nyquist[1]), Number(nyquist[2])],
    };
}

function trajexSignalDict(events, tissue, nyquist) {
    return {
        Dict: {
            sequence: { TypedList: { InstantSeqEvent: events } },
            t1: { Float: tissue.T1 },
            t2: { Float: tissue.T2 },
            min_mag: { Float: 1e-4 },
            signal: { Bool: true },
            nyquist: nyquistInput(nyquist),
        },
    };
}

export async function runConseq(seqText, onMessage = () => {}) {
    await ensureToolApi();
    onMessage('conseq…');
    const conseqResult = await call(
        CONSEQ_ADDR,
        {
            Dict: {
                seq_file: { Str: seqText },
                exact_trajectory: { Bool: false },
            },
        },
        (msg) => {
            onMessage(`conseq: ${msg}`);
            return true;
        },
    );
    const events = conseqResult.TypedList?.InstantSeqEvent;
    if (!events?.length) throw new Error('conseq returned no events');
    onMessage(`conseq: ${events.length} events`);
    return events;
}

/**
 * Desktop PSF bundle: one trajex signal=True call per tissue + shared k-space.
 */
/**
 * @param {string} seqText
 * @param {{ fov: number[], res: number[] }} grid
 * @param {(msg: string) => void} [onMessage]
 * @param {*} [events] precomputed conseq events (skips second conseq when shared with sim)
 */
export async function fetchPsfTrajexBundle(seqText, grid, onMessage = () => {}, events = null) {
    await ensureToolApi();
    const fov = grid.fov;
    const res = grid.res;
    const nyquist = [
        (res[0] / (2.0 * fov[0])) * NYQUIST_SCALE_FACTOR,
        (res[1] / (2.0 * fov[1])) * NYQUIST_SCALE_FACTOR,
        (res[2] / (2.0 * fov[2])) * NYQUIST_SCALE_FACTOR,
    ];

    const ev = events ?? (await runConseq(seqText, onMessage));

    onMessage(`trajex PSF (${PSF_TISSUES.length} tissues, parallel)…`);
    const results = await Promise.all(
        PSF_TISSUES.map((tissue) =>
            call(
                TRAJEX_ADDR,
                trajexSignalDict(ev, tissue, nyquist),
                (msg) => {
                    onMessage(`trajex ${tissue.name}: ${msg}`);
                    return true;
                },
            ),
        ),
    );

    let kspace = null;
    const tissues = [];
    for (let i = 0; i < PSF_TISSUES.length; i++) {
        const tissue = PSF_TISSUES[i];
        const parsed = parseTrajexKspaceSignal(results[i]);
        if (!kspace) kspace = parsed.kspace;
        tissues.push({
            name: tissue.name,
            T2dash: tissue.T2dash,
            signal: parsed.signal,
        });
    }

    if (!kspace || tissues.length !== PSF_TISSUES.length) {
        throw new Error('PSF trajex bundle incomplete');
    }

    onMessage(`PSF trajex · ${kspace.length} samples · ${tissues.length} tissues`);
    return { kspace, tissues, nyquist, source: 'trajex signal=True (seq_check.py)' };
}
