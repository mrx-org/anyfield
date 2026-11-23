import type { UserFile } from "./types";

/** What clicking a file's name hands over: its name and its hash, for the chat. */
export const fileLine = (name: string, sha256: string) => `"${name}": ${sha256}`;

/** Bytes as B, kB, MB, GB (powers of 1000, one decimal from kB on). */
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
  return `${v.toFixed(1).replace(".", ",")} ${units[i]}`;
}

/** An ISO time as local date and time, e.g. "23.11.26, 14:05". */
export function formatTime(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "–"
    : d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export type SortKey = "name" | "type" | "size" | "uploaded_at";

/** The files sorted by `key` (missing values last), ascending or descending. */
export function sortFiles(files: UserFile[], key: SortKey, ascending: boolean): UserFile[] {
  const dir = ascending ? 1 : -1;
  return [...files].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "de");
    return c * dir;
  });
}

/** The files whose name or type contains `query` (case-insensitive). */
export function filterFiles(files: UserFile[], query: string): UserFile[] {
  const q = query.trim().toLowerCase();
  return q ? files.filter((f) => f.name.toLowerCase().includes(q) || (f.type ?? "").toLowerCase().includes(q)) : files;
}

/** What the list shows: all files, or only the bifti phantoms (the server filters). */
export type FileMode = "all" | "bifti";
export const FILE_MODES: { key: FileMode; label: string }[] = [
  { key: "all", label: "Alle Dateien" },
  { key: "bifti", label: "BIfTIs" },
];
