import type { AnyfieldClient } from "../client/anyfield";
import type { PhantomChoice, PhantomMaps, PhantomProperty } from "../types";

/** The display maps of the currently chosen phantom (loaded on demand, not part of the state). */
export class MapsLoader {
  maps = $state<PhantomMaps | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  private id: string | null = null;

  constructor(private client: AnyfieldClient) {}

  /** Load the maps of `phantom` unless they are already loaded or loading. */
  load(phantom: PhantomChoice | null): void {
    const id = phantom ? `${phantom.collection}/${phantom.name}` : "";
    if (id === this.id) return;
    this.id = id;
    this.loading = true;
    this.error = null;
    this.client.getPhantomMaps(phantom).then(
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
