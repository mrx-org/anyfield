# Niivue, sform/qform, and MITK Interoperability Insights

## NIfTI Affine Matrix Selection

### Niivue's Behavior
- **Niivue uses `sform` when `sform_code >= qform_code`** (standard NIfTI behavior).
- Source: `niivue_/packages/niivue/src/nvimage/AffineProcessor.ts` line 58.
- If codes are equal, sform is preferred.

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

## Best Practices for Export

1. **Set both qform and sform** to identical transformations.
2. **Set codes to 2** (SCANNER_ANAT) for maximum compatibility.
3. **Extract spacing from affine**, never trust `pixDims` alone.
4. **Use rotated affines** for oriented masks to avoid interpolation and "bounding box" over-coverage.
