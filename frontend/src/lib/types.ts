export type Vec3 = [number, number, number];

export interface Fov {
  center_mm: Vec3;
  /** Rotation about x, then y, then z (degrees). */
  rotation_deg: Vec3;
  size_mm: Vec3;
}

export interface PhantomProperty {
  key: string;
  label: string;
  unit: string;
  /** 2nd and 98th percentile inside the phantom, for windowing. */
  range: [number, number] | null;
}

export interface PhantomState {
  /** null: the built-in default phantom. */
  collection: string | null;
  name: string;
  property: string;
  status: "ready" | "loading" | "error";
  error: string | null;
  properties: PhantomProperty[];
  /** URL of the shown map; null while loading or after an error. */
  url: string | null;
}

export interface SessionState {
  key: string;
  name: string;
  rev: number;
  owner_login: string | null;
  updated_at: number;
  fov: Fov;
  phantom: PhantomState;
  phantom_url: string | null;
  web_url: string;
}

export interface PhantomCollection {
  collection: string;
  label: string;
  description: string;
  keywords: string[];
  authors: string[];
  license: string | null;
  doi: string | null;
  phantom_count: number;
}

/** A registry phantoms list: file names and nested groups. */
export type PhantomTree = Array<string | { group: string; default?: string; phantoms: PhantomTree }>;

export interface SessionSummary {
  key: string;
  name: string;
  rev: number;
  updated_at: number;
}

export interface FovChange {
  rev: number;
  fov: Fov;
  summary: string;
}
