import { describe, expect, it } from "vitest";
import { AnyfieldClient } from "../client/anyfield";
import { MockTransport } from "../client/mock";
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
    expect(store.fov?.center_mm).toEqual([0, 0, 10]);
  });

  it("applies edits at once and throttles commits", async () => {
    const { t, store } = setup();
    await store.refresh();
    for (let i = 1; i <= 20; i++) store.editFov({ center_mm: [i, 0, 0] });
    expect(store.fov?.center_mm).toEqual([20, 0, 0]); // optimistic
    await store.settled();
    const commits = t.calls.filter((c) => c.name === "set_fov");
    expect(commits.length).toBeLessThan(5);
    expect(commits.at(-1)?.args.center_mm).toEqual([20, 0, 0]);
    expect(store.server?.fov.center_mm).toEqual([20, 0, 0]);
    expect(store.pendingFov).toBeNull();
  });

  it("pending edits win over a stale poll", async () => {
    const { store } = setup();
    await store.refresh();
    store.editFov({ size_mm: [50, 50, 50] });
    await store.refresh();
    expect(store.fov?.size_mm).toEqual([50, 50, 50]);
    await store.settled();
  });

  it("reports unknown keys", async () => {
    const store = new SessionStore(new AnyfieldClient(new MockTransport()), "nope");
    await store.refresh();
    expect(store.error).toMatch(/Unknown session key/);
  });
});

describe("SessionStore phantoms", () => {
  it("selects a phantom and a property", async () => {
    const { t, store } = setup();
    await store.refresh();
    await store.selectPhantom("demo-001", "shapes.json");
    expect(store.server?.phantom.collection).toBe("demo-001");
    expect(store.selecting).toBeNull();
    await store.setPhantomProperty("T1");
    expect(store.server?.phantom.url).toMatch(/T1\.nii\.gz$/);
    expect(t.calls.map((c) => c.name)).toContain("set_phantom_property");
  });
});
