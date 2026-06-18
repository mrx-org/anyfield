# -*- coding: utf-8 -*-
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "pypulseq==1.4.2.post2",
# ]
#
# [tool.anyfield]
# micropip_no_deps = ["pypulseq"]
# ///
"""Load a Pulseq .seq file and return the sequence. Use upload or enter a VFS path/URL."""
from typing import Annotated


def seq_pulseq_interpreter(
    seq_file: Annotated[str, "file"] = "epi_se_rs.seq",
):
    """
    Load a Pulseq sequence from a .seq file.

    Parameters
    ----------
    filename : str (file)
        Path to the .seq file in the virtual filesystem (e.g. /uploads/foo.seq)
        or a URL. Use the upload button or type the path.

    Returns
    -------
    seq : pypulseq.Sequence
        The loaded sequence.
    """
    import pypulseq as pp
    seq = pp.Sequence()
    try:
        seq.read(seq_file)
    except Exception as e:
        raise RuntimeError(
            f"Failed to read .seq file '{seq_file}': {e!s}. "
            "The file may be from a different Pulseq version or use features not fully supported by this pypulseq build."
        ) from e
    return seq
