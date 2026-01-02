#!/usr/bin/env python3
"""
Resample a target NIfTI file to match the grid of a FOV mask NIfTI file.

Usage:
    python resample.py

The script will prompt you to:
1. Select the FOV mask NIfTI file (defines target grid)
2. Select the target NIfTI file (to be resampled)
3. The resampled file will be saved as <target_name>_resampled.nii
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
            ("NIfTI files", "*.nii"),
            ("Compressed NIfTI files", "*.nii.gz"),
            ("All NIfTI files", "*.nii *.nii.gz"),
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


def resample_to_reference(source_img, reference_img, order=1):
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
    reference_data = reference_img.get_fdata()
    reference_affine = reference_img.affine
    reference_shape = reference_data.shape[:3]  # Only spatial dimensions
    
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
    
    # Handle multi-dimensional data (e.g., RGB, time series)
    if len(source_data.shape) == 3:
        # Single volume
        resampled_data = map_coordinates(
            source_data,
            [source_coords[..., 0], source_coords[..., 1], source_coords[..., 2]],
            order=order,
            mode='constant',
            cval=0.0,
            prefilter=False
        )
    else:
        # Multi-dimensional (e.g., 4D)
        output_shape = reference_shape + source_data.shape[3:]
        resampled_data = np.zeros(output_shape, dtype=source_data.dtype)
        
        # Resample each volume/timepoint separately
        for i in range(source_data.shape[3]):
            resampled_data[..., i] = map_coordinates(
                source_data[..., i],
                [source_coords[..., 0], source_coords[..., 1], source_coords[..., 2]],
                order=order,
                mode='constant',
                cval=0.0,
                prefilter=False
            )
    
    # Create new NIfTI image with reference header
    resampled_img = nib.Nifti1Image(
        resampled_data,
        reference_affine,
        header=reference_img.header.copy()
    )
    
    # Copy important metadata from source
    resampled_img.header['cal_min'] = source_img.header['cal_min']
    resampled_img.header['cal_max'] = source_img.header['cal_max']
    resampled_img.header['scl_slope'] = source_img.header['scl_slope']
    resampled_img.header['scl_inter'] = source_img.header['scl_inter']
    
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
    
    # Step 2: Select target file
    print()
    print("Step 2: Select target NIfTI file (to be resampled)...")
    target_path = select_file("Select target NIfTI file")
    
    if not target_path:
        print("No file selected. Exiting.")
        sys.exit(1)
    
    print(f"Selected target: {os.path.basename(target_path)}")
    print()
    
    # Load files
    print("Loading files...")
    try:
        fov_img = load_nifti(fov_path)
        target_img = load_nifti(target_path)
    except Exception as e:
        print(f"Error loading files: {e}")
        sys.exit(1)
    
    # Display information
    print()
    print("FOV mask properties:")
    print(f"  Shape: {fov_img.shape[:3]}")
    print(f"  Spacing: {fov_img.header.get_zooms()[:3]}")
    print(f"  Affine shape: {fov_img.affine.shape}")
    
    print()
    print("Target properties:")
    print(f"  Shape: {target_img.shape[:3]}")
    print(f"  Spacing: {target_img.header.get_zooms()[:3]}")
    print(f"  Affine shape: {target_img.affine.shape}")
    print()
    
    # Resample
    print("Resampling target to match FOV mask grid...")
    print("  (Using linear interpolation)")
    try:
        resampled_img = resample_to_reference(target_img, fov_img, order=1)
    except Exception as e:
        print(f"Error during resampling: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    
    # Save result - handle both .nii and .nii.gz
    if target_path.endswith('.nii.gz'):
        # Remove .nii.gz and add _resampled.nii.gz
        base = target_path[:-7]  # Remove '.nii.gz'
        output_path = f"{base}_resampled.nii.gz"
    elif target_path.endswith('.nii'):
        # Remove .nii and add _resampled.nii
        base = target_path[:-4]  # Remove '.nii'
        output_path = f"{base}_resampled.nii"
    else:
        # Fallback: just add _resampled.nii
        base, _ = os.path.splitext(target_path)
        output_path = f"{base}_resampled.nii"
    
    print()
    print(f"Saving resampled file to: {os.path.basename(output_path)}")
    try:
        nib.save(resampled_img, output_path)
        print("✓ Resampling complete!")
        print()
        print("Resampled file properties:")
        print(f"  Shape: {resampled_img.shape[:3]}")
        print(f"  Spacing: {resampled_img.header.get_zooms()[:3]}")
        print(f"  Output file: {output_path}")
    except Exception as e:
        print(f"Error saving file: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
