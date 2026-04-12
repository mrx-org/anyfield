# Sources configuration for sequence explorer
# Each source must have: type ("file" | "folder" | "module"), path (or url), and optionally name (tree label), seq_func (entry point; legacy: base_sequence), dependencies.

sources = [
    {
        'type': 'file',
        'name': 'Built-in',
        'path': 'built_in_seq/gre_seq.py',
        'seq_func': 'seq_gre',
        'dependencies': ['pypulseq']
    },
    {
        'type': 'file',
        'name': 'Built-in',
        'path': 'built_in_seq/mr0_rare_2d_seq.py',
        'seq_func': 'seq_RARE_2D',
        'dependencies': ['pypulseq']
    },
    {
        'type': 'file',
        'name': 'Built-in',
        'path': 'built_in_seq/mr0_tse_2d_seq.py',
        'seq_func': 'seq_TSE_2D',
        'dependencies': ['pypulseq']
    },
    {
        'type': 'file',
        'name': 'Built-in',
        'path': 'built_in_seq/seq_pulseq_interpreter.py',
        'seq_func': 'seq_pulseq_interpreter',
        'dependencies': ['pypulseq']
    },
    {
        'type': 'module',
        'name': 'mrseq.scripts',
        'path': 'mrseq.scripts',
        'seq_func': None,
        'dependencies': ['numpy>=2.0.0', 'pypulseq', {'name': 'mrseq', 'deps': False}, 'ismrmrd']
    },
    {
        'type': 'folder',
        'name': 'pypulseq',
        'path': 'https://github.com/imr-framework/pypulseq/tree/master/examples/scripts',
        'seq_func': None,
        'dependencies': ['pypulseq']
    },
    {
        'type': 'file',
        'name': 'MRzero',
        'path': 'https://raw.githubusercontent.com/MRsources/MRzero-Core/refs/heads/main/documentation/playground_mr0/mr0_EPI_2D_seq.ipynb',
        'seq_func': None,
        'dependencies': ['pypulseq']
    }
]
