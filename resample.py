#!/usr/bin/env python3
"""
Resample target NIfTI file(s) to match the grid of a FOV mask NIfTI file.

Usage:
    python resample.py

The script will prompt you to:
1. Select the FOV mask NIfTI file (defines target grid)
2. Select one or more target NIfTI file(s) (to be resampled)
3. Each resampled file will be saved as <target_name>_resampled.nii[.gz]
"""

import numpy as np
import nibabel as nib
from scipy.ndimage import map_coordinates
import tkinter as tk
from tkinter import filedialog
import sys
import os


def select_file(title, filetypes=None):
    """Open a file dialog to select a file."""
    if filetypes is None:
        filetypes = [
            ("NIfTI files", "*.nii *.nii.gz"),
            ("Standard NIfTI", "*.nii"),
            ("Compressed NIfTI", "*.nii.gz"),
            ("All files", "*.*")
        ]
    
    root = tk.Tk()
    root.withdraw()  # Hide the main window
    root.attributes('-topmost', True)  # Bring dialog to front
    
    filepath = filedialog.askopenfilename(
        title=title,
        filetypes=filetypes
    )
    
    root.destroy()
    return filepath


def select_files(title, filetypes=None):
    """Open a file dialog to select multiple files."""
    if filetypes is None:
        filetypes = [
            ("NIfTI files", "*.nii *.nii.gz"),
            ("Standard NIfTI", "*.nii"),
            ("Compressed NIfTI", "*.nii.gz"),
            ("All files", "*.*")
        ]
    
    root = tk.Tk()
    root.withdraw()  # Hide the main window
    root.attributes('-topmost', True)  # Bring dialog to front
    
    filepaths = filedialog.askopenfilenames(
        title=title,
        filetypes=filetypes
    )
    
    root.destroy()
    return list(filepaths)


def load_nifti(path):
    """
    Load a NIfTI file, with a fallback if a .nii.gz file is not actually gzipped.
    """
    try:
        return nib.load(path)
    except Exception as e:
        error_msg = str(e).lower()
        if ("not a gzip file" in error_msg or "not a gzipped file" in error_msg) and path.lower().endswith('.gz'):
            print(f"  Note: {os.path.basename(path)} has .gz extension but is not gzipped. Using fallback loader.")
            # If it's not a gzip file but has the extension, try loading it as a standard NIfTI
            try:
                # Use FileHolder and explicitly load data to bypass extension-based dispatching
                with open(path, 'rb') as f:
                    fh = nib.FileHolder(path, f)
                    img = nib.Nifti1Image.from_file_map({'header': fh, 'image': fh})
                    # Create a new image with data in memory to avoid future gzip errors on this file
                    return nib.Nifti1Image(img.get_fdata(), img.affine, img.header.copy())
            except Exception as fallback_e:
                # If that also fails, raise the original error
                print(f"  Fallback failed: {fallback_e}")
                raise e
        raise e


def resample_to_reference(source_img, reference_img, order=3):
    """
    Resample source image to match reference image's grid.
    
    Parameters:
    -----------
    source_img : nibabel.Nifti1Image
        Source image to resample
    reference_img : nibabel.Nifti1Image
        Reference image (defines target grid)
    order : int
        Interpolation order (0=nearest, 1=linear, 3=cubic)
    
    Returns:
    --------
    resampled_img : nibabel.Nifti1Image
        Resampled image with reference grid
    """
    # Get source data and affine
    source_data = source_img.get_fdata()
    source_affine = source_img.affine
    
    # Get reference grid properties
    reference_affine = reference_img.affine
    reference_shape = reference_img.shape[:3]  # Only spatial dimensions
    
    # Create coordinate grid for reference space
    # Generate voxel coordinates in reference space
    ref_coords = np.meshgrid(
        np.arange(reference_shape[0]),
        np.arange(reference_shape[1]),
        np.arange(reference_shape[2]),
        indexing='ij'
    )
    ref_coords = np.stack(ref_coords, axis=-1)  # Shape: (nx, ny, nz, 3)
    
    # Convert reference voxel coordinates to world coordinates
    ref_coords_flat = ref_coords.reshape(-1, 3)
    ref_coords_world = np.dot(
        np.column_stack([ref_coords_flat, np.ones(len(ref_coords_flat))]),
        reference_affine.T
    )[:, :3]
    
    # Convert world coordinates to source voxel coordinates
    source_affine_inv = np.linalg.inv(source_affine)
    source_coords = np.dot(
        np.column_stack([ref_coords_world, np.ones(len(ref_coords_world))]),
        source_affine_inv.T
    )[:, :3]
    
    # Reshape back to reference grid shape
    source_coords = source_coords.reshape(reference_shape + (3,))
    
    # Handle multi-dimensional data (preserve exact dimensionality)
    extra_dims = source_data.shape[3:]
    output_shape = reference_shape + extra_dims
    resampled_data = np.zeros(output_shape, dtype=source_data.dtype)
    
    if not extra_dims:
        # Single volume (3D)
        resampled_data = map_coordinates(
            source_data,
            [source_coords[..., 0], source_coords[..., 1], source_coords[..., 2]],
            order=order,
            mode='constant',
            cval=0.0,
            prefilter=False
        )
    else:
        # Multi-dimensional (4D, 5D, etc.)
        # Resample each volume/timepoint separately by iterating over all extra dimensions
        for idx in np.ndindex(extra_dims):
            # Combined index: [:, :, :, idx0, idx1, ...]
            full_idx = (slice(None), slice(None), slice(None)) + idx
            resampled_data[full_idx] = map_coordinates(
                source_data[full_idx],
                [source_coords[..., 0], source_coords[..., 1], source_coords[..., 2]],
                order=order,
                mode='constant',
                cval=0.0,
                prefilter=False
            )
    
    # Create new NIfTI image with source header to preserve metadata
    new_header = source_img.header.copy()
    resampled_img = nib.Nifti1Image(
        resampled_data,
        reference_affine,
        header=new_header
    )
    
    # CRITICAL: Sync both sform AND qform to the reference affine
    # nibabel only sets sform by default - qform keeps old values from copied header
    # MITK prefers qform, causing misalignment if not synced
    resampled_img.set_sform(reference_affine, code=2)
    resampled_img.set_qform(reference_affine, code=2)
    
    # Ensure header zooms are correct: spatial from reference, others from source
    ref_zooms = reference_img.header.get_zooms()[:3]
    src_zooms = source_img.header.get_zooms()
    new_zooms = list(ref_zooms)
    if len(src_zooms) > 3:
        new_zooms.extend(src_zooms[3:])
    
    resampled_img.header.set_zooms(new_zooms)
    
    return resampled_img


def main():
    print("=" * 60)
    print("NIfTI Resampling Tool")
    print("=" * 60)
    print()
    
    # Step 1: Select FOV mask file
    print("Step 1: Select FOV mask NIfTI file (defines target grid)...")
    fov_path = select_file("Select FOV mask NIfTI file")
    
    if not fov_path:
        print("No file selected. Exiting.")
        sys.exit(1)
    
    print(f"Selected FOV mask: {os.path.basename(fov_path)}")
    
    # Step 2: Select target file(s)
    print()
    print("Step 2: Select target NIfTI file(s) (to be resampled)...")
    print("  (You can select multiple .nii or .nii.gz files)")
    target_paths = select_files("Select target NIfTI file(s)")
    
    if not target_paths:
        print("No files selected. Exiting.")
        sys.exit(1)
    
    print(f"Selected {len(target_paths)} target(s): {[os.path.basename(p) for p in target_paths]}")
    print()
    
    # Load FOV mask once
    print("Loading FOV mask...")
    try:
        fov_img = load_nifti(fov_path)
    except Exception as e:
        print(f"Error loading FOV mask: {e}")
        sys.exit(1)
    
    print("FOV mask properties:")
    print(f"  Shape: {fov_img.shape}")
    print(f"  Spacing: {fov_img.header.get_zooms()}")
    print(f"  Affine shape: {fov_img.affine.shape}")
    print()
    
    # Process each target file
    for i, target_path in enumerate(target_paths):
        print("-" * 60)
        print(f"Processing [{i + 1}/{len(target_paths)}]: {os.path.basename(target_path)}")
        print("-" * 60)
        
        try:
            target_img = load_nifti(target_path)
        except Exception as e:
            print(f"  Error loading target: {e}")
            continue
        
        print(f"  Target shape: {target_img.shape}, spacing: {target_img.header.get_zooms()[:3]}")
        
        # Resample
        print("  Resampling to match FOV mask grid (linear interpolation)...")
        try:
            resampled_img = resample_to_reference(target_img, fov_img, order=1)
        except Exception as e:
            print(f"  Error during resampling: {e}")
            import traceback
            traceback.print_exc()
            continue
        
        # Save result - handle both .nii and .nii.gz
        if target_path.endswith('.nii.gz'):
            base = target_path[:-7]
            output_path = f"{base}_resampled.nii.gz"
        elif target_path.endswith('.nii'):
            base = target_path[:-4]
            output_path = f"{base}_resampled.nii"
        else:
            base, _ = os.path.splitext(target_path)
            output_path = f"{base}_resampled.nii"
        
        try:
            nib.save(resampled_img, output_path)
            print(f"  ✓ Saved: {os.path.basename(output_path)}")
        except Exception as e:
            print(f"  Error saving file: {e}")
    
    print()
    print("=" * 60)
    print(f"Done. Processed {len(target_paths)} file(s).")


if __name__ == "__main__":
    main()
