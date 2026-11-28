import { m } from "../paraglide/messages.js";
import { compareText, formatDateTime, formatNumber } from "./i18n.svelte";
import type { UserFile } from "./types";

/** What clicking a file's name hands over: its name and its hash, for the chat. */
export const fileLine = (name: string, sha256: string) => `"${name}": ${sha256}`;

/** Bytes as B, kB, MB, GB (powers of 1000, one decimal from kB on), in the UI's language. */
export function formatSize(bytes: number | null): string {
  if (bytes == null) return "–";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${formatNumber(v, 1)} ${units[i]}`;
}

/** An ISO time as local date and time in the UI's language, e.g. "23.11.26, 14:05". */
export function formatTime(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "–"
    : formatDateTime(d);
}

export type SortKey = "name" | "type" | "size" | "uploaded_at";

/** The files sorted by `key` (missing values last), ascending or descending. */
export function sortFiles(files: UserFile[], key: SortKey, ascending: boolean): UserFile[] {
  const dir = ascending ? 1 : -1;
  return [...files].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : compareText(String(x), String(y));
    return c * dir;
  });
}

/** The files whose name or type contains `query` (case-insensitive). */
export function filterFiles(files: UserFile[], query: string): UserFile[] {
  const q = query.trim().toLowerCase();
  return q ? files.filter((f) => f.name.toLowerCase().includes(q) || (f.type ?? "").toLowerCase().includes(q)) : files;
}

/** What the list shows: all files, only the bifti phantoms or only the sequence files
 * (.seq, .py, .ipynb; the server filters). */
export type FileMode = "all" | "bifti" | "sequence";
export const FILE_MODES: { key: FileMode; label: () => string }[] = [
  { key: "all", label: m.files_mode_all },
  { key: "bifti", label: m.files_mode_bifti },
  { key: "sequence", label: m.files_mode_sequence },
];
