import type { AnyfieldClient } from "../client/anyfield";
import type { PhantomChoice, PhantomMaps, PhantomProperty, ScanGrid } from "../types";

/**
 * The display maps of the chosen phantom (loaded on demand from the gateway, not
 * part of the state). With a grid: the maps resliced onto the planned scan grid.
 */
export class MapsLoader {
  maps = $state<PhantomMaps | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  private id: string | null = null;

  constructor(private client: AnyfieldClient) {}

  /** Load the maps of `phantom` (on `grid`) unless they are already loaded or loading. */
  load(phantom: PhantomChoice | null, grid?: ScanGrid): void {
    const id = JSON.stringify([phantom, grid ?? null]);
    if (id === this.id) return;
    this.id = id;
    this.loading = true;
    this.error = null;
    this.client.getPhantomMaps(phantom, grid && $state.snapshot(grid)).then(
      (m) => {
        if (this.id !== id) return;
        this.maps = m;
        this.loading = false;
      },
      (e) => {
        if (this.id !== id) return;
        this.maps = null;
        this.loading = false;
        this.error = e instanceof Error ? e.message : String(e);
      },
    );
  }

  /** The map of `key`, or the first one (PD) if the phantom has no such property. */
  property(key: string): PhantomProperty | null {
    const props = this.maps?.properties ?? [];
    return props.find((p) => p.key === key) ?? props[0] ?? null;
  }
}

/** File name for NiiVue, which tells the format by its extension (gateway URLs end in the hash). */
export function niftiName(url: string): string {
  const last = url.split("/").pop() || "map";
  return /\.nii(\.gz)?$/.test(last) ? last : `${last}.nii.gz`;
}
