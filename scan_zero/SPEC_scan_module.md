# SPEC: Scan Module

The Scan Module is a core component of the No-field Scanner lab. It manages the execution of simulations (scans) and provides a queue-based interface for tracking and viewing results.

## Overview
The module bridges the gap between **Planning** (Sequence Explorer/Niivue) and **Results** (NIfTI images). It implements a "File-Pair" logic where every scan produces both a Pulseq sequence file (`.seq`) and a corresponding reconstructed volume (`.nii.gz`).

## Architecture
- **Location**: `scan_zero/`
- **Class**: `ScanModule` (defined in `scan_module.js`)
- **Styles**: `scan_module.css`
- **Dependencies**: 
    - `event_hub.js` for inter-module communication.
    - `NiivueModule` (global instance `window.nvModule`) for image data and resampling logic.
    - `Pyodide` for running the simulation engine (Python).

## Key State
- `queue`: An array of `Job` objects representing past and current scans.
- `currentSequence`: The sequence currently selected in the Sequence Explorer.
- `currentFov`: The FOV geometry (size, offset, rotation) received from Niivue.

## The "Fake Scan" Engine
Since a real MRzero simulation is not yet fully integrated, the current implementation uses a **Resampling Simulation**:
1. **Trigger**: User clicks the "SCAN" button.
2. **Execution**: The module automatically triggers `SequenceExplorer.executeFunction(silent=true)`. This ensures the pulse sequence is generated in memory without switching to Sequence Mode or showing a plot.
3. **Data Capture**:
    - The module retrieves the current base volume from Niivue.
    - It retrieves the current FOV box coordinates (the "yellow box").
4. **Python Execution**: 
    - Uses `nibabel` and `scipy.ndimage.map_coordinates` in Pyodide.
    - Resamples the base volume into the exact grid defined by the FOV box.
    - **Sequence Export**: The current sequence object in memory is saved as a real `.seq` file in the Pyodide virtual filesystem (`/outputs/[baseName].seq`).
5. **Results**:
    - Generates a Blob URL for the new NIfTI file.
    - Stores the path to the virtual `.seq` file for later viewing.

## Interface & Workflow
- **SCAN Button**: Green button at the top; only active if a sequence is selected.
- **Queue Item**: Shows the sequence name, timestamp, and status.
    - **Pending/Scanning**: Shows a yellow spinner.
    - **Done**: Shows two buttons:
        - **VIEW SCAN**: Tells the `NiivueModule` to load the generated NIfTI as an overlay (mask/red tint) on top of the current volume.
        - **VIEW SEQ**: Switches the app to **Sequence Mode**, reads the specific `.seq` file associated with this job from the VFS, and plots it.
    - **Error**: Shows a warning icon with a tooltip.

## Integration Points (eventHub)
- `sequenceSelected`: Listens for this event to update the "Ready" sequence name and enable scanning.
- `fov_changed`: Listens for this event to keep the internal FOV geometry in sync for the next scan.
- `loadUrl`: Calls this method on `window.nvModule` to display results.

## Layout Configuration
In the `no-field_index.html` Lab Shell, the module is integrated into the 3-column footer:
```css
/* Layout in no-field_index.html */
grid-template-columns: 1fr 0.8fr 1.5fr; /* Tree | Scan | Params */
```
