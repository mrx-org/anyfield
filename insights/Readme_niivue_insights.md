# Niivue, sform/qform, and MITK Interoperability Insights

## NIfTI Affine Matrix Selection

### Niivue's Behavior
- **Niivue uses `sform` when `sform_code >= qform_code`** (standard NIfTI behavior).
- Source: `niivue_/packages/niivue/src/nvimage/AffineProcessor.ts` line 58.
- If codes are equal, sform is preferred.
- the niivue standard phantom seems to have contradicting sfrom and qfrom...

### MITK's Behavior
- **MITK prefers `qform` when `qform_code > 0`**.
- This causes misalignment if qform and sform don't match.
- **Solution**: Set both qform and sform to identical transformations.

---

## Critical Niivue Limitation: vol.matRAS Missing Translation

### The Problem
**`vol.matRAS` does NOT include translation (world coordinate origin)**.
During Niivue's `calculateRAS()` process, the translation component from the NIfTI header is lost.

### The Solution
When exporting NIfTI files from Niivue, you must **manually combine** the components:
1. **Rotation/Scaling**: Extract from `vol.matRAS` (preserves current orientation).
2. **Translation**: Extract from `hdr.affine` (preserves original world origin).
3. **Write to Both**: Write the resulting 4x4 matrix to both `sform` and `qform`.

---

## Voxel Spacing Estimation

Always estimate voxel spacing by calculating the distance between adjacent voxels in world space using the current affine matrix (`vol.matRAS`):
1. Compute world coordinates for $(0,0,0)$ and $(1,0,0)$.
2. Distance $= \text{dist}(P_{000}, P_{100})$.
3. **Why**: Relying on `hdr.pixDims` can lead to 0.75x or 1.33x scaling errors if the header is inconsistent with the affine matrix or if the volume was reoriented.

---

## FOV Mask NIfTI Export (Rotated Affine)

To perfectly match the oriented FOV box (especially when tilted), the exported FOV mask NIfTI uses a **rotated affine matrix** instead of an axis-aligned one. This ensures the NIfTI volume grid is internally aligned with the FOV box axes, preventing "over-coverage" in world Z-direction.

### Mathematical Derivation

1. **Rotation Matrix ($R$):**
   Derived from FOV rotation $(\theta_x, \theta_y, \theta_z)$ using $Z-Y-X$ Euler sequence:
   $$R = R_z(\theta_z) \cdot R_y(\theta_y) \cdot R_x(\theta_x)$$

2. **Voxel Spacing ($S$):**
   Calculated from local FOV size $(L_x, L_y, L_z)$ and requested matrix dimensions $(D_x, D_y, D_z)$:
   $$sp_x = L_x / D_x, \quad sp_y = L_y / D_y, \quad sp_z = L_z / D_z$$

3. **World Origin ($P_{world,0}$):**
   The world coordinate of voxel $(0,0,0)$ center, using true FOV center $C_{world}$:
   $$P_{local,0} = \left[ -L_x/2 + sp_x/2, \quad -L_y/2 + sp_y/2, \quad -L_z/2 + sp_z/2 \right]$$
   $$P_{world,0} = R \cdot P_{local,0} + C_{world}$$

4. **Final Affine Matrix ($A_{mask}$):**
   Sets both **sform** (matrix) and **qform** (quaternions):
   $$A_{mask} = \begin{bmatrix} R_{00} \cdot sp_x & R_{01} \cdot sp_y & R_{02} \cdot sp_z & P_{world,0,x} \\ R_{10} \cdot sp_x & R_{11} \cdot sp_y & R_{12} \cdot sp_z & P_{world,0,y} \\ R_{20} \cdot sp_x & R_{21} \cdot sp_y & R_{22} \cdot sp_z & P_{world,0,z} \\ 0 & 0 & 0 & 1 \end{bmatrix}$$

### Benefits
- **Zero Interpolation Error**: Every voxel in the mask is "inside" the FOV.
- **Perfect Tilted Display**: Viewers (MITK, Niivue) use the affine to display the volume at the correct physical tilt.
- **Correct Z-Coverage**: A single-slice mask (e.g., $128 \times 128 \times 1$) appears as a single tilted plane in world space.

---

## STL Export: RAS vs LPS

Different viewers expect different coordinate systems:
- **RAS (Right-Anterior-Superior)**: Niivue, NIfTI standard.
- **LPS (Left-Posterior-Superior)**: MITK, DICOM standard.
- **Conversion**: LPS = RAS with X and Y axes flipped ($x \to -x, y \to -y$).

We export both `fov-box-ras.stl` and `fov-box-lps.stl` to ensure compatibility.

---

## Interactive FOV Rotation (Best Practices)

To ensure a natural and consistent "feeling" during mouse-based FOV rotation, several coordinate-system and display issues must be addressed:

### 1. Robust Rotation Pivot
Always use the visual crosshair position in the **current tile** as the rotation pivot. 
- **Method**: Use `nv.frac2canvasPosWithTile(frac, tileIndex)` instead of global `frac2canvasPos`.
- **Why**: In multi-planar layouts (e.g., 2x2), calculating rotation relative to a pivot in a different tile creates a massive "lever arm," making rotation feel sluggish or inconsistent.

### 2. Device Pixel Ratio (DPR) Calibration
Mouse events (`clientX/Y`) are in CSS pixels, while Niivue's internal positions are often in backing-store pixels.
- **Solution**: Normalize the pivot point by the DPR: `pivotX = rect.left + (canvasPos[0] / dpr)`.
- **Why**: Failure to divide by DPR causes the rotation center to "drift" on high-DPI screens (e.g., 4K monitors or Retina displays).

### 3. Plane-Specific Rotation Directions
Medical views often require different rotation signs to feel "natural" because screen space is Y-down, while volume space is Z-up (Superior):
- **Axial**: Standard clockwise.
- **Coronal**: Inverted (clockwise mouse movement should move Superior part to the Right).
- **Sagittal**: User-preference/standard-dependent (typically non-inverted).
- **Radiological Convention**: If active, the X-axis is flipped (Left is Right), so rotation directions in **Axial** and **Coronal** planes must be inverted to remain consistent with the visual feedback.

---

## Recovering Box from STL (PCA Method)

When converting an oriented STL box back to a NIfTI mask, use **Principal Component Analysis (PCA)** on the STL vertices to determine the box parameters:

1. **Center**: The mean of all unique vertices.
2. **Axes**: The principal components (eigenvectors) of the vertex coordinates define the local X, Y, and Z axes of the box.
3. **Dimensions**: The range (max - min) of the vertices projected onto each principal axis.

This method is robust against any initial rotation or translation of the STL and allows for the automatic construction of a perfectly matching **rotated NIfTI affine**.

---

## Best Practices for Export

1. **Set both qform and sform** to identical transformations.
2. **Set codes to 2** (SCANNER_ANAT) for maximum compatibility.
3. **Extract spacing from affine**, never trust `pixDims` alone.
4. **Use rotated affines** for oriented masks to avoid interpolation and "bounding box" over-coverage.
5. **Calibrate UI interactions for DPR** to ensure precise dragging and rotation.

---

## Python/Nibabel Resampling: Critical qform/sform Pitfall

### The Problem
When resampling a NIfTI and copying the source header:
```python
new_header = source_img.header.copy()
resampled_img = nib.Nifti1Image(resampled_data, reference_affine, header=new_header)
```

**Nibabel only sets `sform` from the affine parameter!** The `qform` retains the old values from the copied source header.

### Symptoms
- **Niivue**: Displays correctly (uses sform)
- **MITK**: Misaligned (prefers qform when `qform_code > 0`)

### The Fix
Explicitly synchronize both forms after creating the image:
```python
resampled_img.set_sform(reference_affine, code=2)
resampled_img.set_qform(reference_affine, code=2)
```

---

## Niivue Export: Avoid Mixing Affine Sources

### The Problem
When exporting a volume from Niivue, there are two potential affine sources:
- `vol.matRAS`: Niivue's internal rendering matrix (may be modified during loading)
- `hdr.affine`: The sform/qform read from the NIfTI header

**Mixing rotation from `matRAS` with translation from `hdr.affine` causes small alignment offsets** if they don't match exactly.

### The Fix
Use `hdr.affine` as the **single authoritative source** when exporting:
```javascript
// Priority: Use hdr.affine (sform from file) as primary source
if (hdr?.affine) {
    currentAffineRow = parseAffine(hdr.affine);
}
// Only fall back to matRAS if hdr.affine not available
if (!currentAffineRow && vol.matRAS) {
    currentAffineRow = affineColToRowMajor(vol.matRAS);
}
```

This preserves the exact affine that was set (e.g., from Python resampling) without Niivue's internal modifications.

---

## Voxel Center vs. Corner (+0.5 Correction)

When aligning a discrete NIfTI mask with a continuous STL mesh, there is often an ambiguity regarding whether coordinates refer to **voxel centers** or **voxel corners**.

### The Logic
- **NIfTI Standard**: In world space, the coordinate $[x, y, z]$ typically points to the **center** of a voxel.
- **Mesh Alignment**: If the first voxel's center is at $[0, 0, 0]$, its physical boundaries (corners) actually extend to $[-0.5 \cdot sp, -0.5 \cdot sp, -0.5 \cdot sp]$.

### Implementation in this App
The rotated affine matrix calculation for the FOV mask **implicitly handles the +0.5 voxel shift**. 

When calculating the `rasOrigin` (the center of voxel $[0,0,0]$), we use:
$$P_{local,0} = \left[ -L_x/2 + sp_x/2, \quad -L_y/2 + sp_y/2, \quad -L_z/2 + sp_z/2 \right]$$

Adding half the voxel spacing ($sp/2$) effectively shifts the grid so that the **entire voxel volume** stays contained within the theoretical FOV box. Without this correction, the mask would appear shifted by half a voxel in all directions relative to the STL mesh.

Because this logic is mathematically robust and hardcoded into the export, the manual "Shift Voxel" toggle is unnecessary and has been removed from the UI.

---

## Interactive FOV Positioning via Mouse Click

### The Problem
When using Ctrl+click to position the FOV box at a specific location, the FOV appeared at the **center of the brain** instead of at the **clicked position**.

### Root Cause
The original implementation computed FOV offsets using a **voxel-based approach**:
1. Get voxel coordinates from `lastLocationVox` (from Niivue's `onLocationChange`)
2. Convert voxel → offset using custom affine transform
3. Use `voxelToWorldFactory(affine)` to transform mesh vertices to world coordinates

**The problem**: The affine matrix from `hdr.affine` or `vol.matRAS` was missing the translation component (see "Critical Niivue Limitation" above). This caused the voxel-to-world transform to behave like an identity transform, so voxel $(0,0,0)$ incorrectly mapped to world $(0,0,0)$ instead of the actual world position.

### The Solution
Instead of computing world coordinates via a potentially broken affine, **use Niivue's slice geometry directly** to compute world mm from the mouse position:

```javascript
// Get slice info for the clicked tile
const slice = nv.screenSlices[tileIndex];
const ltwh = slice.leftTopWidthHeight;

// Compute fractional position within slice
let fX = (screenX - ltwh[0]) / ltwh[2];
const fY = 1.0 - (screenY - ltwh[1]) / ltwh[3];
if (ltwh[2] < 0) fX = 1.0 - fX;

// Compute slice-local mm coordinates
let xyzMM = [
    slice.leftTopMM[0] + fX * slice.fovMM[0],
    slice.leftTopMM[1] + fY * slice.fovMM[1],
    0
];
const v = slice.AxyzMxy;
xyzMM[2] = v[2] + v[4] * (xyzMM[1] - v[1]) - v[3] * (xyzMM[0] - v[0]);

// Convert to RAS world coordinates based on slice orientation
let rasMM;
if (slice.axCorSag === 1) rasMM = [xyzMM[0], xyzMM[2], xyzMM[1]];      // Coronal
else if (slice.axCorSag === 2) rasMM = [xyzMM[2], xyzMM[0], xyzMM[1]]; // Sagittal
else rasMM = xyzMM;                                                     // Axial
```

### Key Insight
The FOV offset values (`fovOffX/Y/Z`) represent **displacement in world mm from the brain center (world origin)**. When offset = 0, the FOV is centered at world $(0,0,0)$. So when clicking at world position $(x, y, z)$, the offset should simply be $(x, y, z)$ — no complex voxel conversion needed.

### Additional Improvement
Also store `lastLocationMm` from Niivue's `onLocationChange` callback as a fallback when slice geometry is unavailable:

```javascript
nv.onLocationChange = (data) => {
    const { mm } = data;
    if (mm?.length >= 3) {
        this.lastLocationMm = [mm[0], mm[1], mm[2]];
    }
};
```
