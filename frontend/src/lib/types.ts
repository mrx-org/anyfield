export type Vec3 = [number, number, number];

export interface Fov {
  center_mm: Vec3;
  /** Rotation about x, then y, then z (degrees). */
  rotation_deg: Vec3;
  size_mm: Vec3;
}

export interface SessionState {
  key: string;
  name: string;
  rev: number;
  owner_login: string | null;
  updated_at: number;
  fov: Fov;
  phantom_url: string;
  web_url: string;
}

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
