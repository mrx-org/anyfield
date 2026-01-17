# Sources configuration for sequence explorer
# Define sources as a list of dictionaries

sources = [
    {
        'name': 'mrseq',
        'type': 'pyodide_module',
        'module': 'mrseq.scripts',
        'description': 'Load sequences from installed mrseq package',
        'dependencies': ['numpy>=2.0.0', 'pypulseq', {'name': 'mrseq', 'deps': False}, 'ismrmrd']
    },
    {
        'name': 'pypulseq_examples',
        'type': 'github_folder',
        'url': 'https://github.com/imr-framework/pypulseq/tree/master/examples/scripts',
        'description': 'Load examples from pypulseq repository',
        'dependencies': ['pypulseq']
    },
    {
        'name': 'RARE 2D (Playground)',
        'type': 'built-in',
        'path': 'built-in-seq/mr0_rare_2d_seq.py',
        'dependencies': ['pypulseq']
    },
    {
        'name': 'MRzero',
        'type': 'remote_file',
        'url': 'https://raw.githubusercontent.com/MRsources/MRzero-Core/refs/heads/main/documentation/playground_mr0/mr0_EPI_2D_seq.ipynb',
        'description': 'EPI 2D sequence from MRzero-Core documentation',
        'dependencies': ['pypulseq']
    }
]
