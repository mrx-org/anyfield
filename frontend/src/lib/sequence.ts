// Helpers for the two kinds of sequence: one of a sequence source (a file at a URL
// or a module, and the function in it) or a file in the gateway's CAS.
import type { CasSequence, SequenceChoice, StatePatch, UserFile } from "./types";

export const isCasSequence = (s: SequenceChoice): s is CasSequence => "sha256" in s;

/** The kind of a CAS sequence file from its name; null if it is none. */
export function casSeqType(name: string): CasSequence["type"] | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".seq")) return "seq";
  if (lower.endsWith(".py")) return "py";
  if (lower.endsWith(".ipynb")) return "ipynb";
  return null;
}

/** A CAS file as sequence (without function: a .py's comes with the gateway's listing). */
export const casSequence = (f: Pick<UserFile, "sha256" | "name">): CasSequence | null => {
  const type = casSeqType(f.name);
  return type ? { sha256: f.sha256, type, name: f.name, func: null } : null;
};

/**
 * The state patch that makes `s` the sequence. A merge patch merges objects, so the
 * fields of the other kind are removed explicitly (null), and so is a function the
 * new one lacks.
 */
export const sequencePatch = (s: SequenceChoice): NonNullable<StatePatch["sequence"]> =>
  isCasSequence(s)
    ? { sha256: s.sha256, type: s.type, name: s.name, func: s.func ?? null, source: null, url: null }
    : { source: s.source, type: s.type, url: s.url, name: s.name, func: s.func ?? null, sha256: null };

/** The same sequence (file and function)? */
export function sameSequence(a: SequenceChoice | null | undefined, b: SequenceChoice | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const where = (s: SequenceChoice) => (isCasSequence(s) ? `cas:${s.sha256}` : `${s.source}|${s.url}`);
  return where(a) === where(b) && (a.func ?? null) === (b.func ?? null);
}

/** Where a sequence comes from, for display: its source, or "CAS · <hash>". */
export const sequenceSource = (s: SequenceChoice) => (isCasSequence(s) ? `CAS · ${s.sha256.slice(0, 12)}…` : s.source);

/** File and function, e.g. "gre_seq.py · seq_gre". */
export const sequenceLabel = (s: SequenceChoice) => (s.func ? `${s.name} · ${s.func}` : s.name);
