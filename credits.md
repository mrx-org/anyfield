# Licences, Credits & Dependencies

This application is licensed under [MIT](https://opensource.org/licenses/MIT).

This application uses the following open-source software. We are grateful to their authors and communities.

---

## Frontend & Runtime

### Pyodide
- **Description:** Python runtime for the browser and Node.js (WebAssembly).
- **Version:** 0.29.x
- **URL:** https://pyodide.org
- **License:** [Mozilla Public License 2.0 (MPL-2.0)](https://www.mozilla.org/en-US/MPL/2.0/)

### ChartGPU
- **Description:** WebGPU-accelerated charting; default renderer for MRI sequence waveform panels (RF, gradients, ADC) in the sequence explorer.
- **Version:** 0.3.2 (ES module from esm.sh, see `pypulseq/seq_explorer.js`)
- **URL:** https://github.com/ChartGPU/ChartGPU
- **License:** [MIT](https://github.com/ChartGPU/ChartGPU/blob/main/LICENSE)

### Niivue
- **Description:** Web-based 3D / 4D NIfTI viewer.
- **Version:** 0.65.0
- **URL:** https://github.com/niivue/niivue
- **License:** [MIT](https://opensource.org/licenses/MIT)

### Bootstrap Icons
- **Description:** Icon set for Bootstrap and general use.
- **Version:** 1.11.3
- **URL:** https://icons.getbootstrap.com
- **License:** [MIT](https://opensource.org/licenses/MIT)

### CodeMirror 5
- **Description:** In-browser code editor.
- **Version:** 5.65.2
- **URL:** https://codemirror.net
- **License:** [MIT](https://opensource.org/licenses/MIT)

### JSZip
- **Description:** Create, read, and edit ZIP files in JavaScript.
- **Version:** 3.10.1
- **URL:** https://stuk.github.io/jszip/
- **License:** [MIT](https://opensource.org/licenses/MIT)

### marked
- **Description:** Markdown parser and compiler; used to render this credits file in the app.
- **Version:** 12.x
- **URL:** https://marked.js.org
- **License:** [MIT](https://opensource.org/licenses/MIT)

---

## Python (via Pyodide)

### NumPy
- **Description:** Fundamental package for numerical computing.
- **License:** [BSD-3-Clause](https://opensource.org/licenses/BSD-3-Clause)

### SciPy
- **Description:** Scientific computing (optimization, interpolation, FFT, etc.).
- **License:** [BSD-3-Clause](https://opensource.org/licenses/BSD-3-Clause)

### Matplotlib
- **Description:** Plotting and visualization library.
- **License:** [PSF License](https://matplotlib.org/stable/users/project/license.html)

### micropip
- **Description:** Pip-like package installer for Pyodide.
- **License:** [Mozilla Public License 2.0 (MPL-2.0)](https://www.mozilla.org/en-US/MPL/2.0/)

### nibabel
- **Description:** Read/write neuroimaging file formats (NIfTI, etc.).
- **License:** [MIT](https://opensource.org/licenses/MIT)

### PyNUFFT
- **Description:** Non-uniform FFT library used for non-Cartesian MRI reconstruction in the browser.
- **URL:** https://github.com/jyhmiinlin/pynufft
- **License:** [MIT](https://opensource.org/licenses/MIT)

### PyPulseq
- **Description:** Python package for MRI pulse sequence design.
- **License:** [MIT](https://opensource.org/licenses/MIT)

### Pulseq
- **Description:** Open-source MR sequence format and framework; sequences can be designed in MATLAB, Octave, or Python and executed on multiple scanner platforms.
- **URL:** https://pulseq.github.io
- **License:** [MIT](https://opensource.org/licenses/MIT)

### mrseq
- **Description:** (Py)Pulseq-based MRI sequences; vendor-agnostic pulse sequence definitions.
- **URL:** https://github.com/PTB-MR/mrseq
- **License:** [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)

### MRzeroCore
- **Description:** MRI simulation framework; Bloch simulation and sequence design for zero- and low-field MRI.
- **URL:** https://github.com/MRsources/MRzero-Core
- **License:** [GNU Affero General Public License v3.0 (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html)

### ISMRMRD (ismrmrd)
- **Description:** Python API for the ISMRMRD (ISMRM Raw Data) file format; used for raw MRI data handling in the sequence explorer.
- **URL:** https://github.com/ismrmrd/ismrmrd-python
- **License:** [ISMRMRD Software License](https://github.com/ismrmrd/ismrmrd-python/blob/master/LICENSE) (public domain / NIH)

---

## Demo Data & Phantoms

### Niivue demo images (e.g. MNI152)
- **Description:** Sample NIfTI volumes used for demos.
- **URL:** https://niivue.github.io/niivue-demo-images/
- **License:** Please refer to the Niivue project and image sources for terms of use.

### BrainWeb
- **Description:** Simulated brain MRI database; realistic MRI volumes from digital phantoms. Some phantoms used in this application are derived from or based on BrainWeb data.
- **URL:** https://brainweb.bic.mni.mcgill.ca/brainweb/
- **License:** Free for research use. Please cite as per [BrainWeb terms](https://brainweb.bic.mni.mcgill.ca/brainweb/) (e.g. Cocosco et al., NeuroImage, 1997).

---

