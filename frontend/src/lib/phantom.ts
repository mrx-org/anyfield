// Helpers for the two kinds of phantom: one of the registry (catalog) or one in
// the gateway's CAS (a bifti .zip, addressed by its hash).
import type { CasPhantom, PhantomChoice, StatePatch } from "./types";

export const isCas = (p: PhantomChoice): p is CasPhantom => "sha256" in p;

/** A stable id of a phantom, e.g. for caches. */
export const phantomKey = (p: PhantomChoice) => (isCas(p) ? `cas:${p.sha256}` : `${p.collection}/${p.name}`);

/** The tool arguments that name a phantom (select_phantom, get_phantom_maps, ...). */
export const phantomArgs = (p: PhantomChoice): Record<string, string> =>
  isCas(p) ? { sha256: p.sha256 } : { collection: p.collection, name: p.name };

/**
 * The state patch that makes `p` the phantom. A merge patch merges objects, so
 * the field of the other kind is removed explicitly (null).
 */
export const phantomPatch = (p: PhantomChoice): StatePatch["phantom"] =>
  isCas(p) ? { sha256: p.sha256, name: p.name, collection: null } : { collection: p.collection, name: p.name, sha256: null };

/** Where a phantom comes from, for display: its collection, or "CAS · <hash>". */
export const phantomSource = (p: PhantomChoice) => (isCas(p) ? `CAS · ${p.sha256.slice(0, 12)}…` : p.collection);
