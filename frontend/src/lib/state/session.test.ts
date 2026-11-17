import { describe, expect, it } from "vitest";
import { AnyfieldClient } from "../client/anyfield";
import { MockTransport } from "../client/mock";
import type { ScanGrid } from "../types";
import { LocalSelection } from "./local.svelte";
import { niftiName } from "./maps.svelte";
import { mergePatch } from "./patch";
import { SessionStore } from "./session.svelte";

const setup = () => {
  const t = new MockTransport();
  return { t, store: new SessionStore(new AnyfieldClient(t), "mock-key", { commitMs: 20 }) };
};

describe("SessionStore", () => {
  it("loads and then polls with known_rev", async () => {
    const { t, store } = setup();
    await store.refresh();
    expect(store.server?.rev).toBe(1);
    await store.refresh();
    expect(t.calls.at(-1)?.args.known_rev).toBe(1);
  });

  it("sees changes made by someone else", async () => {
    const { t, store } = setup();
    await store.refresh();
    await t.callTool("move_fov", { session_key: "mock-key", delta_mm: [0, 0, 10] }); // e.g. the AI
    await store.refresh();
    expect(store.state?.fov.center_mm).toEqual([0, 0, 10]);
  });

  it("applies edits at once and throttles commits", async () => {
    const { t, store } = setup();
    await store.refresh();
    for (let i = 1; i <= 20; i++) store.patch({ fov: { center_mm: [i, 0, 0] } });
    expect(store.state?.fov.center_mm).toEqual([20, 0, 0]); // optimistic
    expect(store.state?.fov.size_mm).toEqual([200, 200, 100]); // merged, not replaced
    await store.settled();
    const commits = t.calls.filter((c) => c.name === "patch_state");
    expect(commits.length).toBeLessThan(5);
    expect((commits.at(-1)?.args.patch as { fov: { center_mm: number[] } }).fov.center_mm).toEqual([20, 0, 0]);
    expect(store.server?.state.fov.center_mm).toEqual([20, 0, 0]);
    expect(store.pending).toBeNull();
  });

  it("pending edits win over a stale poll", async () => {
    const { store } = setup();
    await store.refresh();
    store.patch({ matrix: [64, 64, 1] });
    await store.refresh();
    expect(store.state?.matrix).toEqual([64, 64, 1]);
    await store.settled();
  });

  it("selects a phantom and goes back to the default", async () => {
    const { store } = setup();
    await store.refresh();
    store.patch({ phantom: { collection: "demo-001", name: "shapes.json" }, view: { property: "T1" } });
    await store.settled();
    expect(store.server?.state.phantom?.name).toBe("shapes.json");
    expect(store.server?.state.view.property).toBe("T1");
    store.patch({ phantom: null });
    expect(store.state?.phantom).toBeNull();
    await store.settled();
    expect(store.server?.state.phantom).toBeNull();
  });

  it("reports unknown keys", async () => {
    const store = new SessionStore(new AnyfieldClient(new MockTransport()), "nope");
    await store.refresh();
    expect(store.error).toMatch(/Unknown session key/);
  });
});

describe("LocalSelection", () => {
  it("changes only locally and reports every change", () => {
    const t = new MockTransport();
    const seen: string[] = [];
    const sel = new LocalSelection(new AnyfieldClient(t), undefined, (s) => seen.push(s.phantom?.name ?? "default"));
    sel.patch({ phantom: { collection: "c", name: "p.json" } });
    expect(sel.state.phantom?.name).toBe("p.json");
    expect(sel.sessionKey).toBeNull();
    expect(seen).toEqual(["p.json"]);
    expect(t.calls).toEqual([]);
  });
});

describe("mergePatch", () => {
  it("follows RFC 7386", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] })).toEqual({ a: 1, b: { d: 3, e: 4 }, f: [1] });
  });
});

describe("AnyfieldClient", () => {
  it("caches phantom maps per phantom", async () => {
    const t = new MockTransport();
    const c = new AnyfieldClient(t);
    const p = { collection: "c", name: "p.json" };
    await c.getPhantomMaps(p);
    await c.getPhantomMaps(p);
    await c.getPhantomMaps(null);
    expect(t.calls.filter((x) => x.name === "get_phantom_maps").length).toBe(2);
  });

  it("reslices onto the scan grid, uncached", async () => {
    const t = new MockTransport();
    const c = new AnyfieldClient(t);
    const grid = { fov: { center_mm: [0, 0, 0], rotation_deg: [0, 0, 0], size_mm: [200, 200, 5] }, matrix: [128, 128, 1] } as ScanGrid;
    const m = await c.getPhantomMaps(null, grid);
    await c.getPhantomMaps(null, grid);
    const calls = t.calls.filter((x) => x.name === "get_phantom_maps");
    expect(calls.length).toBe(2);
    expect(calls[0].args).toEqual({ fov: grid.fov, matrix: [128, 128, 1] });
    expect(m.default).toBe(true);
  });
});

describe("niftiName", () => {
  it("gives gateway URLs (a bare hash) a NIfTI extension", () => {
    expect(niftiName("https://gw.test/files/abc123")).toBe("abc123.nii.gz");
    expect(niftiName("https://x.test/a/T1.nii.gz")).toBe("T1.nii.gz");
  });
});
