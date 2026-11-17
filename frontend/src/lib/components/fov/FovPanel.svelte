<script lang="ts">
  // Numeric FOV and matrix controls. Emits changes; the Selection applies them.
  import type { Fov, Vec3 } from "../../types";

  let {
    fov,
    matrix,
    onfov,
    onmatrix,
  }: { fov: Fov; matrix: Vec3; onfov: (change: Partial<Fov>) => void; onmatrix: (matrix: Vec3) => void } = $props();

  const groups: Array<{ field: keyof Fov; label: string; unit: string; min: number; max: number; step: number }> = [
    { field: "center_mm", label: "Position", unit: "mm", min: -150, max: 150, step: 1 },
    { field: "rotation_deg", label: "Rotation", unit: "°", min: -180, max: 180, step: 1 },
    { field: "size_mm", label: "Größe", unit: "mm", min: 1, max: 400, step: 1 },
  ];
  const axes = ["x", "y", "z"] as const;

  function set(field: keyof Fov, axis: number, raw: string) {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const next = [...fov[field]] as Vec3;
    next[axis] = v;
    onfov({ [field]: next });
  }

  function setMatrix(axis: number, raw: string) {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v) || v < 1 || v > 1024) return;
    const next = [...matrix] as Vec3;
    next[axis] = v;
    onmatrix(next);
  }

  const voxel = $derived(fov.size_mm.map((s, i) => s / matrix[i]));
</script>

<div class="flex flex-col gap-4 text-sm">
  {#each groups as g (g.field)}
    <fieldset class="flex flex-col gap-1.5">
      <legend class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{g.label} ({g.unit})</legend>
      {#each axes as axis, i (axis)}
        <label class="grid grid-cols-[1rem_1fr_4.5rem] items-center gap-2">
          <span class="text-muted">{axis}</span>
          <input
            type="range"
            min={g.min}
            max={g.max}
            step={g.step}
            value={fov[g.field][i]}
            oninput={(e) => set(g.field, i, e.currentTarget.value)}
            class="accent-accent"
            aria-label="{g.label} {axis}"
          />
          <input
            type="number"
            min={g.min}
            max={g.max}
            step={g.step}
            value={Math.round(fov[g.field][i] * 10) / 10}
            onchange={(e) => set(g.field, i, e.currentTarget.value)}
            class="w-full rounded border border-border bg-bg px-1.5 py-0.5 text-right"
            aria-label="{g.label} {axis} Wert"
          />
        </label>
      {/each}
    </fieldset>
  {/each}
  <fieldset class="flex flex-col gap-1.5">
    <legend class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Matrix</legend>
    <div class="grid grid-cols-3 gap-2">
      {#each axes as axis, i (axis)}
        <label class="flex items-center gap-1">
          <span class="text-muted">{axis}</span>
          <input
            type="number"
            min="1"
            max="1024"
            step="1"
            value={matrix[i]}
            onchange={(e) => setMatrix(i, e.currentTarget.value)}
            class="w-full rounded border border-border bg-bg px-1.5 py-0.5 text-right"
            aria-label="Matrix {axis}"
          />
        </label>
      {/each}
    </div>
    <span class="text-xs text-muted">Voxel: {voxel.map((v) => v.toFixed(2)).join(" × ")} mm</span>
  </fieldset>
</div>
