# Sequence Explorer Specification

## Intent
In-browser Python environment for executing PyPulseq scripts and visualizing MRI sequence waveforms.

## Core Functionality
- **Execution**: Pyodide-powered Python runtime for local sequence generation.
- **Silent Execution**: Support for background sequence generation (without mode switching or plotting) for simulation workflows.
- **Dynamic UI**: Automatic generation of input controls from Python function signatures.
- **Plotting**: Optimized Matplotlib visualization of RF, Gradients (X, Y, Z), and ADC events with downsampling.
- **Integration**: Synchronizes internal sequence parameters with scanner FOV events and emits `sequenceSelected` for other modules.
- **Editor**: Built-in CodeMirror instance for live sequence logic modification.

## Modular API
- **Class**: `SequenceExplorer`
- **Parts**:
  - `renderTree(target)`: Sequence database / file tree.
  - `renderParams(target)`: Dynamic protocol parameter inputs.
  - `renderPlot(target)`: Matplotlib waveform output pane.
- **Key Methods**:
  - `executeFunction(silent)`: Executes the current sequence with optional UI suppression.