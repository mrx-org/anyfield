export type Vec3 = [number, number, number];

export interface Fov {
  center_mm: Vec3;
  /** Rotation about x, then y, then z (degrees). */
  rotation_deg: Vec3;
  size_mm: Vec3;
}

export interface PhantomChoice {
  collection: string;
  /** Phantom file name, e.g. "subj04-3T-1mm.json". */
  name: string;
}

/** A session's state: the user's choices only, no data. `phantom: null` is the built-in default. */
export interface State {
  phantom: PhantomChoice | null;
  view: { property: string };
  fov: Fov;
  /** Resolution (x, y, z) of the planned scan. */
  matrix: Vec3;
}

/** JSON Merge Patch (RFC 7386) of a State: objects merge, null removes, the rest replaces. */
export type StatePatch = {
  phantom?: PhantomChoice | null;
  view?: { property: string };
  fov?: Partial<Fov>;
  matrix?: Vec3;
};

export interface Session {
  key: string;
  name: string;
  rev: number;
  updated_at: number;
  state: State;
  web_url: string;
}

export interface PhantomProperty {
  key: string;
  label: string;
  unit: string;
  /** 2nd and 98th percentile inside the phantom, for windowing. */
  range: [number, number] | null;
  url: string;
}

/** Display maps of a phantom (`get_phantom_maps`): data, never stored in the state. */
export interface PhantomMaps {
  phantom: PhantomChoice | null;
  shape?: Vec3;
  spacing_mm?: Vec3;
  properties: PhantomProperty[];
}

/** A collection of the BIfTI registry (from the gateway's `bifti_list_collections`). */
export interface PhantomCollection {
  collection: string;
  description: string;
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
