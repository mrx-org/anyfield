"""Characterisation coverage for pypulseq/seq_source_manager.py.

This module is the Python half of the sequence-build path: it parses `.seq`
source files, reads PEP 723 / `_anyfield_json` metadata, resolves parameter
defaults for the UI, and finally executes the user's sequence function. It had no
tests at any level, which makes migrating `buildSequence`
to a worker the riskiest step. These tests exist to
notice if that migration changes anything, so they pin **current** behaviour,
including the parts that look wrong. Those are marked `CHARACTERISATION:` and are
documented here rather than fixed.

Loading contract: this file is never imported by the app. `seq_explorer.js`'s
`ensureSourceManager()` fetches it as text and `exec`s it into a bare
``ModuleType('seq_source_manager')`` registered under that flat name, so there is
no package context. The `source_manager` fixture reproduces that exactly, for the
reason that a relative import added to a module loaded
this way breaks the browser while an `import`-based test suite stays green.

Loading it by file path rather than as `pypulseq.seq_source_manager` is also the
only arrangement that survives someone installing a real `pypulseq` into the venv
-- see `test_the_module_is_not_reachable_as_a_pypulseq_submodule_by_design`.
"""
from __future__ import annotations

import ast
import json
import sys
import textwrap
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "pypulseq" / "seq_source_manager.py"
ANYSEQ_DIR = REPO_ROOT / "pypulseq" / "anyseq"
SOURCES_TOML = REPO_ROOT / "pypulseq" / "sources.toml"


def _load_via_browser_exec_contract() -> ModuleType:
    """Load the module the way `ensureSourceManager()` does in the browser."""
    module = ModuleType("seq_source_manager")
    sys.modules["seq_source_manager"] = module
    code = compile(MODULE_PATH.read_text(), str(MODULE_PATH), "exec")
    exec(code, module.__dict__)
    return module


@pytest.fixture(scope="module")
def source_manager() -> ModuleType:
    previous = sys.modules.get("seq_source_manager")
    try:
        yield _load_via_browser_exec_contract()
    finally:
        if previous is None:
            sys.modules.pop("seq_source_manager", None)
        else:
            sys.modules["seq_source_manager"] = previous


@pytest.fixture
def manager(source_manager):
    return source_manager.SourceManager()


@pytest.fixture
def isolated_interpreter_state(source_manager):
    """Undo the interpreter-wide state `execute_function` mutates.

    It inserts the filesystem root onto `sys.path`, purges `pypulseq*` from
    `sys.modules`, and writes `SourceManager._last_sequence` plus `__main__.seq`.
    Every one of those outlives the call, so tests that trigger it restore the
    interpreter afterwards or they leak into whatever runs next.
    """
    import __main__

    saved_path = list(sys.path)
    saved_modules = dict(sys.modules)
    sentinel = object()
    saved_last = getattr(source_manager.SourceManager, "_last_sequence", sentinel)
    saved_seq = getattr(__main__, "seq", sentinel)
    try:
        yield
    finally:
        sys.path[:] = saved_path
        sys.modules.clear()
        sys.modules.update(saved_modules)
        if saved_last is sentinel:
            if hasattr(source_manager.SourceManager, "_last_sequence"):
                del source_manager.SourceManager._last_sequence
        else:
            source_manager.SourceManager._last_sequence = saved_last
        if saved_seq is sentinel:
            if hasattr(__main__, "seq"):
                del __main__.seq
        else:
            __main__.seq = saved_seq


def _expr(src: str) -> ast.expr:
    return ast.parse(src, mode="eval").body


def _func_args(src: str) -> ast.arguments:
    return ast.parse(textwrap.dedent(src)).body[0].args


class _SeqLike:
    """Duck-typed stand-in for a pypulseq Sequence.

    `execute_function`'s `is_seq()` only asks for `plot` and `check_timing`, so
    this is a faithful double rather than a stub of anything under test.
    """

    def plot(self):  # pragma: no cover - never called
        pass

    def check_timing(self):  # pragma: no cover - never called
        pass


class _FalsySeqLike(_SeqLike):
    """Sequence-like object that is falsy, as an empty `__len__` would make it."""

    def __len__(self):
        return 0


class _JsNullLike:
    """Stands in for `pyodide.ffi.JsNull`, whose `__bool__` is False.

    JS `null` reaching Python is not `None` -- that mismatch is a known
    JS-boundary bug. What can be
    checked on the host is the property the code actually relies on: the `x or ''`
    guards take the empty-string path for *any* falsy object, so a `JsNull`
    argument is handled, while a truthy non-string is not (see the TypeError
    tests below).
    """

    def __bool__(self):
        return False


# ---------------------------------------------------------------------------
# Loading contract
# ---------------------------------------------------------------------------


def test_module_loads_under_the_browser_exec_contract(source_manager):
    """`exec`'d into a bare ModuleType with no package context, as the app does.

    A relative import anywhere in this file would raise ImportError here while
    leaving an `import`-based suite green -- exactly the `9bd18a9` failure.
    """
    assert isinstance(source_manager, ModuleType)
    assert sys.modules["seq_source_manager"] is source_manager
    assert source_manager.__dict__["__name__"] == "seq_source_manager"
    for name in ("SourceManager", "parse_script_metadata", "parse_metadata_toml"):
        assert hasattr(source_manager, name)


def test_the_module_is_not_reachable_as_a_pypulseq_submodule_by_design():
    """`import pypulseq.seq_source_manager` works only while no real pypulseq is
    installed, so no test may depend on it.

    `pypulseq/` in the repo root has no `__init__.py`, so with `pythonpath = ["."]`
    it resolves as a *namespace* portion and its files are importable as
    submodules. Namespace portions lose to any regular package of the same name
    found later on `sys.path`, so installing the real `pypulseq` into the venv
    (which the app does at runtime via micropip, and which a future change might
    do to test `seq_plot_utils` for real) would silently make that import fail.
    """
    assert not (REPO_ROOT / "pypulseq" / "__init__.py").exists()
    import pypulseq

    assert getattr(pypulseq, "__file__", None) is None, (
        "a real pypulseq is now installed; pypulseq.seq_source_manager is no "
        "longer importable and this test's premise has changed"
    )


# ---------------------------------------------------------------------------
# PEP 723 and _anyfield_json metadata
# ---------------------------------------------------------------------------


def test_extract_pep723_block_decomments_a_real_shipped_sequence(source_manager):
    code = (ANYSEQ_DIR / "gre_seq.py").read_text()
    toml_text = source_manager.extract_pep723_block(code)
    assert toml_text is not None
    assert toml_text.startswith('requires-python = ">=3.9"')
    assert "[tool.anyfield]" in toml_text
    assert not any(line.startswith("#") for line in toml_text.splitlines())


def test_extract_pep723_block_returns_none_for_a_missing_block(source_manager):
    assert source_manager.extract_pep723_block("import numpy\n") is None


def test_extract_pep723_block_filters_on_block_type(source_manager):
    code = "# /// pyproject\n# name = 'x'\n# ///\n"
    assert source_manager.extract_pep723_block(code) is None
    assert source_manager.extract_pep723_block(code, "pyproject") == "name = 'x'"


@pytest.mark.parametrize("falsy", [None, "", 0, _JsNullLike()])
def test_extract_pep723_block_treats_any_falsy_input_as_empty_source(source_manager, falsy):
    """`code or ''` means None, '', 0 and a JsNull-shaped object all return None
    rather than raising -- the boundary case a worker migration is most likely to
    hit."""
    assert source_manager.extract_pep723_block(falsy) is None


def test_extract_pep723_block_raises_typeerror_on_a_truthy_non_string(source_manager):
    """CHARACTERISATION: only *falsy* non-strings are tolerated. A number or a
    PyProxy arriving where source text was expected surfaces as a bare re TypeError
    rather than a message naming the argument."""
    with pytest.raises(TypeError, match="expected string or bytes-like object"):
        source_manager.extract_pep723_block(42)


def test_extract_anyfield_json_reads_the_raw_string_block_the_ui_writes(source_manager):
    # Byte-for-byte the shape of seq_explorer.js's buildAnyfieldJsonBlock().
    code = (
        "# --- AnyField metadata begin ---\n"
        "_anyfield_json = r'''\n"
        '{\n  "seq_func": "gre_seq:seq_gre",\n  "simulation": {"backend": "modal_http_t4"}\n}\n'
        "'''\n"
        "# --- AnyField metadata end ---\n"
    )
    assert source_manager.extract_anyfield_json(code) == {
        "seq_func": "gre_seq:seq_gre",
        "simulation": {"backend": "modal_http_t4"},
    }


def test_extract_anyfield_json_returns_empty_without_the_markers(source_manager):
    assert source_manager.extract_anyfield_json('_anyfield_json = "{}"\n') == {}


def test_extract_anyfield_json_accepts_an_annotated_assignment(source_manager):
    code = (
        "# --- AnyField metadata begin ---\n"
        '_anyfield_json: str = "{\\"a\\": 1}"\n'
        "# --- AnyField metadata end ---\n"
    )
    assert source_manager.extract_anyfield_json(code) == {"a": 1}


def test_extract_anyfield_json_swallows_a_syntax_error_in_the_block(source_manager):
    code = (
        "# --- AnyField metadata begin ---\n"
        "_anyfield_json = (((\n"
        "# --- AnyField metadata end ---\n"
    )
    assert source_manager.extract_anyfield_json(code) == {}


def test_extract_anyfield_json_rejects_a_non_literal_value(source_manager):
    code = (
        "# --- AnyField metadata begin ---\n"
        "_anyfield_json = build_it()\n"
        "# --- AnyField metadata end ---\n"
    )
    with pytest.raises(ValueError, match="must be a string literal"):
        source_manager.extract_anyfield_json(code)


def test_extract_anyfield_json_rejects_a_non_object_payload(source_manager):
    code = (
        "# --- AnyField metadata begin ---\n"
        '_anyfield_json = "[1, 2]"\n'
        "# --- AnyField metadata end ---\n"
    )
    with pytest.raises(ValueError, match="must decode to an object"):
        source_manager.extract_anyfield_json(code)


def test_extract_anyfield_json_propagates_a_json_decode_error(source_manager):
    """CHARACTERISATION: malformed JSON in a saved protocol reaches JS as a raw
    JSONDecodeError, not as one of the two ValueErrors above."""
    code = (
        "# --- AnyField metadata begin ---\n"
        '_anyfield_json = "{not json}"\n'
        "# --- AnyField metadata end ---\n"
    )
    with pytest.raises(json.JSONDecodeError):
        source_manager.extract_anyfield_json(code)


def test_extract_anyfield_json_only_sees_top_level_assignments(source_manager):
    code = (
        "# --- AnyField metadata begin ---\n"
        "if True:\n"
        '    _anyfield_json = "{\\"a\\": 1}"\n'
        "# --- AnyField metadata end ---\n"
    )
    assert source_manager.extract_anyfield_json(code) == {}


def test_parse_script_metadata_on_a_real_shipped_sequence(source_manager):
    meta = json.loads(source_manager.parse_script_metadata((ANYSEQ_DIR / "gre_seq.py").read_text()))
    assert meta["dependencies"] == ["numpy", "matplotlib", "pypulseq==1.4.2.post2"]
    assert meta["requires_python"] == ">=3.9"
    assert meta["micropip_no_deps"] == ["pypulseq"]
    # No AnyField block in the shipped sequences, so `anyfield` carries only the
    # PEP install hint that gets copied across.
    assert meta["anyfield"] == {"micropip_no_deps": ["pypulseq"]}


def test_parse_script_metadata_returns_all_keys_for_empty_source(source_manager):
    """The JS side reads `.dependencies` / `.anyfield` unconditionally, so the
    keys have to be present even with nothing to report."""
    meta = json.loads(source_manager.parse_script_metadata(""))
    assert meta == {
        "dependencies": [],
        "requires_python": None,
        "micropip_no_deps": [],
        "anyfield": {},
    }


def test_parse_script_metadata_lets_the_pep_block_win_over_anyfield_json(source_manager):
    code = (
        "# /// script\n"
        "# [tool.anyfield]\n"
        '# micropip_no_deps = ["from_pep"]\n'
        "# ///\n"
        "# --- AnyField metadata begin ---\n"
        '_anyfield_json = "{\\"micropip_no_deps\\": [\\"from_json\\"]}"\n'
        "# --- AnyField metadata end ---\n"
    )
    meta = json.loads(source_manager.parse_script_metadata(code))
    assert meta["anyfield"]["micropip_no_deps"] == ["from_pep"]


def test_parse_script_metadata_keeps_anyfield_json_hint_when_pep_is_silent(source_manager):
    code = (
        "# --- AnyField metadata begin ---\n"
        '_anyfield_json = "{\\"micropip_no_deps\\": [\\"from_json\\"]}"\n'
        "# --- AnyField metadata end ---\n"
    )
    meta = json.loads(source_manager.parse_script_metadata(code))
    assert meta["micropip_no_deps"] == []
    assert meta["anyfield"]["micropip_no_deps"] == ["from_json"]


def test_parse_metadata_toml_round_trips_an_extracted_block(source_manager):
    toml_text = source_manager.extract_pep723_block((ANYSEQ_DIR / "tse.py").read_text())
    parsed = json.loads(source_manager.parse_metadata_toml(toml_text))
    assert parsed["dependencies"]
    assert set(parsed) == {"dependencies", "requires_python", "micropip_no_deps"}


def test_parse_metadata_toml_accepts_empty_input(source_manager):
    assert json.loads(source_manager.parse_metadata_toml(None)) == {
        "dependencies": [],
        "requires_python": None,
        "micropip_no_deps": [],
    }


# ---------------------------------------------------------------------------
# AST default evaluation -- what the parameter table shows before any import
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "src, expected",
    [
        ("3", 3),
        ("3.5", 3.5),
        ("'text'", "text"),
        ("True", True),
        ("None", None),
        ("(1, 2)", [1, 2]),
        ("[1, [2, 3]]", [1, [2, 3]]),
        ("-4", -4),
        ("+4", 4),
        ("220e-3", 0.22),
        ("1 + 2", 3),
        ("8 / 2", 4.0),
        ("2 ** 3", 8),
        ("7 % 3", 1),
        ("np.pi", pytest.approx(3.141592653589793)),
        ("math.e", pytest.approx(2.718281828459045)),
        ("numpy.pi_2", pytest.approx(1.5707963267948966)),
    ],
)
def test_ast_eval_simple_default_evaluates_literal_expressions(source_manager, src, expected):
    assert source_manager._ast_eval_simple_default(_expr(src)) == expected


def test_ast_eval_simple_default_returns_none_for_a_missing_node(source_manager):
    assert source_manager._ast_eval_simple_default(None) is None


@pytest.mark.parametrize("src", ["build()", "np.float64", "other.pi", "a + b", "1 << 2"])
def test_ast_eval_simple_default_rejects_what_it_cannot_evaluate(source_manager, src):
    with pytest.raises(ValueError):
        source_manager._ast_eval_simple_default(_expr(src))


def test_ast_eval_simple_default_mishandles_not_and_invert(source_manager):
    """CHARACTERISATION -- looks wrong, pinned as-is.

    The UnaryOp branch is `-value if isinstance(op, USub) else +value`, so every
    non-USub unary operator becomes unary plus. `not True` evaluates to 1 and
    `~5` to 5. Neither appears in a shipped sequence signature today.
    """
    assert source_manager._ast_eval_simple_default(_expr("not True")) == 1
    assert source_manager._ast_eval_simple_default(_expr("~5")) == 5


def test_ast_function_params_maps_non_finite_defaults_to_null(source_manager):
    """Regression: noexec parameter defaults must be JSON-safe.

    `_ast_eval_simple_default` still evaluates `np.inf` / `np.nan` to IEEE floats
    (they are supported constants). `_ast_function_params` then maps those values
    through `_json_safe_default` — the same encoding as
    `seq_plot_utils._tolist_json_safe` — so `seq_explorer.js`'s `json.dumps`
    emits `null` and `JSON.parse` succeeds.
    """
    assert source_manager._ast_eval_simple_default(_expr("np.inf")) == float("inf")
    nan = source_manager._ast_eval_simple_default(_expr("np.nan"))
    assert nan != nan

    params = source_manager._ast_function_params(
        _func_args("def f(t=np.inf, n=np.nan):\n    pass\n")
    )
    dumped = json.dumps(params)
    assert dumped == (
        '[{"name": "t", "default": null, "type": "float"}, '
        '{"name": "n", "default": null, "type": "float"}]'
    )
    assert json.loads(dumped) == params


@pytest.mark.parametrize(
    "value, expected",
    [
        (True, "bool"),
        (3, "int"),
        (3.5, "float"),
        ("s", "str"),
        ([1], "list"),
        ((1,), "list"),
        (None, "NoneType"),
        ({"a": 1}, "dict"),
    ],
)
def test_ast_default_type_name(source_manager, value, expected):
    assert source_manager._ast_default_type_name(value) == expected


@pytest.mark.parametrize(
    "annotation, expected",
    [
        ("int", None),
        ('Annotated[str, "file"]', "file"),
        ("Annotated[str, 'url']", "url"),
        ('Annotated[str, "file", "url"]', "file"),
        ('Annotated[int, "other"]', None),
    ],
)
def test_ast_param_type_from_annotation(source_manager, annotation, expected):
    args = _func_args(f"def f(x: {annotation} = 'v'):\n    pass\n")
    assert source_manager._ast_param_type_from_annotation(args.args[0]) == expected


def test_ast_param_type_from_annotation_ignores_an_unannotated_arg(source_manager):
    args = _func_args("def f(x=1):\n    pass\n")
    assert source_manager._ast_param_type_from_annotation(args.args[0]) is None


def test_ast_param_dict_marks_an_unevaluable_default_unknown(source_manager):
    """The default falls back to its unparsed source text with type 'unknown',
    which is what makes `seq_explorer.js` treat the input box as a raw Python
    expression."""
    args = _func_args("def f(x=build()):\n    pass\n")
    assert source_manager._ast_param_dict_from_arg(args.args[0], args.defaults[0]) == {
        "name": "x",
        "default": "build()",
        "type": "unknown",
    }


def test_ast_param_dict_reports_np_array_default_as_ndarray(source_manager):
    """`np.array(...)` is a list payload plus type `ndarray` — the pair
    `seq_explorer.js` already JSON-stringifies and wraps on execute."""
    args = _func_args("def f(x=np.array([1, 2])):\n    pass\n")
    assert source_manager._ast_param_dict_from_arg(args.args[0], args.defaults[0]) == {
        "name": "x",
        "default": [1, 2],
        "type": "ndarray",
    }


def test_ast_param_dict_reports_no_default_as_type_none(source_manager):
    args = _func_args("def f(x):\n    pass\n")
    assert source_manager._ast_param_dict_from_arg(args.args[0], None) == {
        "name": "x",
        "default": None,
        "type": "None",
    }


# ---------------------------------------------------------------------------
# Parameter and signature extraction from an AST
# ---------------------------------------------------------------------------


def test_ast_function_params_aligns_defaults_and_includes_keyword_only(source_manager):
    params = source_manager._ast_function_params(
        _func_args("def f(a, b=2, *, c=3, d):\n    pass\n")
    )
    assert params == [
        {"name": "a", "default": None, "type": "None"},
        {"name": "b", "default": 2, "type": "int"},
        {"name": "c", "default": 3, "type": "int"},
        {"name": "d", "default": None, "type": "None"},
    ]


def test_ast_function_params_skips_the_system_parameter_by_default(source_manager):
    args = _func_args("def f(fov=1, system=None, n=2):\n    pass\n")
    assert [p["name"] for p in source_manager._ast_function_params(args)] == ["fov", "n"]
    assert [p["name"] for p in source_manager._ast_function_params(args, skip_system=False)] == [
        "fov",
        "system",
        "n",
    ]


def test_ast_function_params_drops_positional_only_parameters(source_manager):
    """CHARACTERISATION -- looks wrong, pinned as-is.

    `posonlyargs` is never read, so a parameter before `/` is invisible to the UI
    and cannot be set. Defaults still line up for the remaining parameters
    because `defaults` is right-aligned. No shipped sequence uses `/`.
    """
    params = source_manager._ast_function_params(_func_args("def f(a, /, b=2):\n    pass\n"))
    assert [p["name"] for p in params] == ["b"]
    assert params[0]["default"] == 2


def test_ast_format_function_signature_covers_star_args_and_kwargs(source_manager):
    fmt = source_manager._ast_format_function_signature
    assert fmt(_func_args("def f(plot, *, fov=1, n_read=64):\n    pass\n")) == (
        "(plot, *, fov = 1, n_read = 64)"
    )
    assert fmt(_func_args("def f(a, *rest, **kw):\n    pass\n")) == "(a, *rest, **kw)"
    assert fmt(_func_args("def f(x: int = 3):\n    pass\n")) == "(x: int = 3)"
    assert fmt(_func_args("def f():\n    pass\n")) == "()"


def test_ast_format_function_signature_omits_the_positional_only_marker(source_manager):
    """CHARACTERISATION: same `posonlyargs` gap as above -- the rendered signature
    silently loses both the parameter and the `/`."""
    assert source_manager._ast_format_function_signature(
        _func_args("def f(a, /, b):\n    pass\n")
    ) == "(b)"


# ---------------------------------------------------------------------------
# parse_file_functions
# ---------------------------------------------------------------------------


def test_parse_file_functions_on_a_real_shipped_sequence(manager):
    functions = manager.parse_file_functions((ANYSEQ_DIR / "gre_seq.py").read_text())
    by_name = {f["name"]: f for f in functions}
    assert "seq_gre" in by_name
    assert by_name["seq_gre"]["doc"].startswith("Generate a gradient-recalled echo")
    # The rendered signature is `ast.unparse`d, not the original source text, so
    # the literal `220e-3` in the file is shown to the user as `0.22`.
    assert by_name["seq_gre"]["signature"].startswith(
        "(fov_xy: tuple = (0.22, 0.22), slice_thickness: float = 0.003, Nread: int = 96"
    )


def test_parse_file_functions_filter_keeps_seq_prefix_and_main(manager):
    code = "def seq_a(): pass\ndef main(): pass\ndef helper(): pass\n"
    assert [f["name"] for f in manager.parse_file_functions(code, filter_seq_prefix=True)] == [
        "seq_a",
        "main",
    ]


def test_parse_file_functions_also_reports_nested_functions_and_methods(manager):
    """CHARACTERISATION -- pinned, not fixed.

    It walks the whole tree instead of `tree.body`, so inner functions and class
    methods are offered as selectable sequence entry points. Harmless today
    because the UI filters on the `seq_` prefix, but it is why an unfiltered
    listing shows more than the file's public functions.
    """
    code = (
        "def top():\n"
        "    def inner():\n"
        "        pass\n"
        "class C:\n"
        "    def method(self):\n"
        "        pass\n"
    )
    assert [f["name"] for f in manager.parse_file_functions(code)] == ["top", "inner", "method"]


def test_parse_file_functions_cannot_see_async_definitions(manager):
    """CHARACTERISATION: only `ast.FunctionDef` is matched, so `async def` is
    invisible -- and so is the regex fallback's view of it."""
    assert manager.parse_file_functions("async def seq_a(): pass\n") == []


def test_parse_file_functions_falls_back_to_a_regex_on_a_syntax_error(manager):
    functions = manager.parse_file_functions(
        "def multi(\n    a,\n    b,\n):\n    pass\ndef ok(x): pass\nthis is not python(\n"
    )
    assert [f["name"] for f in functions] == ["multi", "ok"]
    # The fallback reports the matched `def ...:` text as the signature and can
    # never recover a docstring.
    assert functions[0]["signature"] == "def multi(\n    a,\n    b,\n):"
    assert all(f["doc"] == "" for f in functions)


def test_parse_file_functions_regex_fallback_misses_parenthesised_defaults(manager):
    """CHARACTERISATION: the fallback pattern is `\\([^)]*\\)`, so any default
    containing a closing paren -- a tuple FOV, a `np.array(...)` -- stops the
    match. A file that fails to parse loses exactly the sequence functions this
    app cares about most."""
    assert manager.parse_file_functions("def seq_x(fov=(1, 2)): pass\nnot python(\n") == []


def test_parse_file_functions_returns_empty_for_source_without_functions(manager):
    assert manager.parse_file_functions("x = 1\n") == []


# ---------------------------------------------------------------------------
# load_sources_config
# ---------------------------------------------------------------------------


def test_load_sources_config_parses_the_shipped_sources_toml(manager):
    sources = manager.load_sources_config(SOURCES_TOML.read_text())
    assert [s["name"] for s in sources] == [
        "anyseq",
        "builtin",
        "mrseq.sequences",
        "pypulseq_examples",
        "MRzero",
        "Educational",
    ]
    assert sources[0]["type"] == "folder"
    assert sources[0]["micropip_no_deps"] == ["pypulseq"]


def test_load_sources_config_accepts_a_json_array(manager):
    assert manager.load_sources_config('[{"type": "file", "path": "a.py"}]') == [
        {"type": "file", "path": "a.py"}
    ]


def test_load_sources_config_returns_a_bare_dict_for_a_json_object(manager):
    """CHARACTERISATION -- pinned, not fixed.

    The docstring promises a list of source dictionaries, but a JSON object is
    returned unchanged. `loadSourcesFromConfig` then `json.dumps`es it and JS
    iterates it, which for an object yields its *keys* -- so a mistyped config
    silently produces string "sources" instead of failing.
    """
    assert manager.load_sources_config('{"type": "file"}') == {"type": "file"}


def test_load_sources_config_rejects_toml_without_a_sources_array(manager):
    with pytest.raises(ValueError, match="must be sources.toml"):
        manager.load_sources_config('name = "x"\n')


def test_load_sources_config_accepts_an_empty_sources_table(manager):
    """No validation of the entries themselves -- an empty `[[sources]]` table is
    returned as a one-element list of an empty dict."""
    assert manager.load_sources_config("[[sources]]\n\n[other]\nx = 1\n") == [{}]


def test_load_sources_config_cannot_reach_its_own_toml_error_message(manager):
    """CHARACTERISATION: TOML decode errors surface as tomllib's raw ValueError.

    `except ValueError: raise` re-raises `tomllib.TOMLDecodeError` (a ValueError)
    as-is. The caller sees tomllib's position report with no mention of which
    file failed.
    """
    with pytest.raises(ValueError, match=r"^Invalid value \(at line 2, column 8\)$"):
        manager.load_sources_config("[[sources]]\nname = \n")


def test_load_sources_config_loses_the_reason_bad_json_failed(manager):
    """CHARACTERISATION: JSON that starts with `{` but does not parse falls
    through to the TOML branch, so the caller is told the config is neither TOML
    nor JSON and never sees the actual decode error."""
    with pytest.raises(ValueError, match="must be sources.toml"):
        manager.load_sources_config('{"unterminated": ')


@pytest.mark.parametrize("value", [None, 42, ["a"], {"a": 1}])
def test_load_sources_config_requires_a_string(manager, value):
    with pytest.raises(ValueError, match="must be a string"):
        manager.load_sources_config(value)


def test_load_sources_config_detects_toml_by_substring_anywhere(manager):
    """CHARACTERISATION: the TOML check is `'[[sources]]' in text`, so a comment
    mentioning the token is enough. The shipped sources.toml relies on this
    working either way -- its header comment contains the literal token."""
    header = SOURCES_TOML.read_text().split("[[sources]]", 1)[0]
    assert header.lstrip().startswith("#"), "sources.toml no longer opens with a comment block"
    with pytest.raises(ValueError, match=r"must define a \[\[sources\]\] array"):
        manager.load_sources_config("# mentions [[sources]] only in prose\n")


# ---------------------------------------------------------------------------
# convert_notebook_to_python
# ---------------------------------------------------------------------------


def test_convert_notebook_keeps_code_cells_and_drops_everything_else(manager):
    notebook = {
        "cells": [
            {"cell_type": "markdown", "source": ["# heading\n"]},
            {"cell_type": "code", "source": ["import numpy as np\n", "\n", "x = 1\n"]},
            {"cell_type": "code", "source": "y = 2\n"},
        ]
    }
    assert manager.convert_notebook_to_python(notebook) == "import numpy as np\nx = 1\n\ny = 2"


def test_convert_notebook_accepts_a_json_string(manager):
    notebook = {"cells": [{"cell_type": "code", "source": ["x = 1\n"]}]}
    assert manager.convert_notebook_to_python(json.dumps(notebook)) == "x = 1"


def test_convert_notebook_drops_shell_magic_and_help_lines(manager):
    notebook = {
        "cells": [
            {
                "cell_type": "code",
                "source": [
                    "!pip install pypulseq\n",
                    "%matplotlib inline\n",
                    "?np.array\n",
                    "keep = 1\n",
                ],
            }
        ]
    }
    assert manager.convert_notebook_to_python(notebook) == "keep = 1"


def test_convert_notebook_returns_empty_string_for_no_code_cells(manager):
    assert manager.convert_notebook_to_python({"cells": []}) == ""
    assert manager.convert_notebook_to_python({}) == ""


def test_convert_notebook_preserves_percent_operators(manager):
    """Regression: inline-magic scrubbing must not truncate Python ``%``.

    Format specifiers (``'%d'``) and modulo (``5 %2``, ``a % b``) are valid
    Python and must survive conversion. Real IPython magics (``%matplotlib``,
    ``%%time``) are still stripped, including when they trail a statement.
    """
    notebook = {
        "cells": [
            {
                "cell_type": "code",
                "source": [
                    "x = 5 %2\n",
                    "y = '%d' % n\n",
                    "z = a % b\n",
                    "import numpy %matplotlib inline\n",
                    "setup() %%time\n",
                ],
            }
        ]
    }
    assert manager.convert_notebook_to_python(notebook) == (
        "x = 5 %2\ny = '%d' % n\nz = a % b\nimport numpy\nsetup()"
    )


# ---------------------------------------------------------------------------
# extract_function_parameters_noexec -- the AST path the UI uses for files
# ---------------------------------------------------------------------------


def test_extract_function_parameters_noexec_from_supplied_code(manager):
    result = manager.extract_function_parameters_noexec(
        "/built_in_seq/x.py",
        "seq_gre",
        code=(ANYSEQ_DIR / "gre_seq.py").read_text(),
    )
    names = [p["name"] for p in result["params"]]
    assert names[:3] == ["fov_xy", "slice_thickness", "Nread"]
    assert result["params"][0]["default"] == [0.22, 0.22]
    assert result["params"][0]["type"] == "list"
    assert result["doc"].startswith("Generate a gradient-recalled echo")


def test_extract_function_parameters_noexec_skips_system(manager):
    result = manager.extract_function_parameters_noexec(
        "/x.py", "seq_TSE_2D", code=(ANYSEQ_DIR / "mr0_tse_2d_seq.py").read_text()
    )
    assert "system" not in [p["name"] for p in result["params"]]


def test_extract_function_parameters_noexec_reads_a_file_when_code_is_absent(manager, tmp_path):
    path = tmp_path / "seq.py"
    path.write_text('def seq_a(n=3):\n    """Doc."""\n')
    result = manager.extract_function_parameters_noexec(str(path), "seq_a")
    assert result == {"params": [{"name": "n", "default": 3, "type": "int"}], "doc": "Doc."}


def test_extract_function_parameters_noexec_roots_a_relative_path(manager):
    """A relative path is resolved against the VFS root, which is why this only
    ever works inside Pyodide."""
    with pytest.raises(FileNotFoundError, match="VFS file not found: /built_in_seq/nope.py"):
        manager.extract_function_parameters_noexec("built_in_seq/nope.py", "seq_a")


def test_extract_function_parameters_noexec_raises_for_a_missing_function(manager):
    with pytest.raises(AttributeError, match="Function 'seq_b' not found"):
        manager.extract_function_parameters_noexec("/x.py", "seq_b", code="def seq_a(): pass\n")


def test_extract_function_parameters_noexec_ignores_a_nested_definition(manager):
    """Unlike `parse_file_functions`, this one scans `tree.body` only, so a
    function of the right name nested inside another is not found."""
    code = "def outer():\n    def seq_a(n=1):\n        pass\n"
    with pytest.raises(AttributeError):
        manager.extract_function_parameters_noexec("/x.py", "seq_a", code=code)


def test_extract_function_parameters_noexec_propagates_a_syntax_error(manager):
    with pytest.raises(SyntaxError):
        manager.extract_function_parameters_noexec("/x.py", "seq_a", code="def (\n")


def test_extract_function_parameters_noexec_reports_an_absent_docstring_as_empty(manager):
    result = manager.extract_function_parameters_noexec("/x.py", "seq_a", code="def seq_a(): pass\n")
    assert result == {"params": [], "doc": ""}


def test_extract_function_parameters_noexec_evaluates_an_ndarray_default(manager):
    """`seq_explorer.js` treats `list`/`ndarray` as a JSON list in the input box
    and wraps the user's text in `np.array(...)` on execute and share."""
    body = "import numpy as np\n\n\ndef seq_a(arr=np.array([1.0, 2.0])):\n    pass\n"
    params = manager.extract_function_parameters_noexec("/x.py", "seq_a", code=body)["params"]
    assert params == [{"name": "arr", "default": [1.0, 2.0], "type": "ndarray"}]


# ---------------------------------------------------------------------------
# find_module_file -- module sources are parsed from their installed file, never imported
# ---------------------------------------------------------------------------


@pytest.fixture
def importable_module(tmp_path, monkeypatch):
    """Write a module to disk on `sys.path`, without leaking either the
    `sys.path` entry or an import into the rest of the session."""
    monkeypatch.syspath_prepend(str(tmp_path))
    created: list[str] = []

    def write(name: str, body: str) -> str:
        (tmp_path / f"{name}.py").write_text(textwrap.dedent(body))
        created.append(name)
        return name

    yield write
    for name in created:
        sys.modules.pop(name, None)


def test_find_module_file_locates_a_module_without_importing_it(manager, importable_module):
    name = importable_module("probe_locate", "raise RuntimeError('must not be imported')\n")
    assert Path(manager.find_module_file(name)).name == f"{name}.py"
    assert name not in sys.modules


def test_find_module_file_resolves_packages_and_submodules(manager, importable_package):
    package = importable_package("probe_locate_pkg", {"a": "def seq_a(): pass\n"})
    assert Path(manager.find_module_file(package)).parts[-2:] == (package, "__init__.py")
    assert Path(manager.find_module_file(f"{package}.a")).parts[-2:] == (package, "a.py")
    assert f"{package}.a" not in sys.modules


def test_find_module_file_raises_for_an_unknown_module(manager):
    with pytest.raises(ModuleNotFoundError, match="no_such_module_anywhere"):
        manager.find_module_file("no_such_module_anywhere")


def test_module_source_parameters_come_from_the_located_file(manager, importable_module):
    name = importable_module(
        "probe_module_params",
        '''
        import pypulseq_that_is_not_installed

        def main(n=3, flag=True, system=None):
            """Doc."""
        ''',
    )
    result = manager.extract_function_parameters_noexec(manager.find_module_file(name), "main")
    assert result == {
        "params": [
            {"name": "n", "default": 3, "type": "int"},
            {"name": "flag", "default": True, "type": "bool"},
        ],
        "doc": "Doc.",
    }


# ---------------------------------------------------------------------------
# Package listing -- AST only
# ---------------------------------------------------------------------------


@pytest.fixture
def importable_package(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(tmp_path))
    created: list[str] = []

    def write(package: str, files: dict[str, str]) -> str:
        directory = tmp_path / package
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "__init__.py").write_text("")
        for stem, body in files.items():
            (directory / f"{stem}.py").write_text(textwrap.dedent(body))
        created.append(package)
        return package

    yield write
    for package in created:
        for name in [k for k in sys.modules if k == package or k.startswith(package + ".")]:
            sys.modules.pop(name, None)


def test_get_functions_from_package_noexec_never_imports(manager, importable_package):
    package = importable_package(
        "probe_noexec",
        {
            "a": 'def seq_a(n=1):\n    """Doc A."""\n',
            "b": "raise RuntimeError('would break an importing scan')\n",
            "_private": "def seq_hidden(): pass\n",
        },
    )
    result = manager.get_functions_from_package_noexec(package)
    # `b` raises on import; it is parsed happily and simply has no functions.
    assert set(result) == {"a"}
    assert result["a"]["full_module_path"] == f"{package}.a"
    assert result["a"]["functions"][0]["doc"] == "Doc A."
    assert f"{package}.b" not in sys.modules


def test_get_functions_from_package_noexec_reports_a_missing_directory(manager):
    result = manager.get_functions_from_package_noexec("no.such.package")
    assert result["error"].startswith("Package directory for 'no.such.package' not found")


def test_get_functions_from_package_noexec_returns_empty_for_a_package_without_functions(
    manager, importable_package
):
    package = importable_package("probe_noexec_empty", {"a": "X = 1\n"})
    assert manager.get_functions_from_package_noexec(package) == {}


def test_get_functions_from_package_noexec_ignores_the_seq_prefix_filter(manager, importable_package):
    """CHARACTERISATION: the AST lister hardcodes `filter_seq_prefix=False` and
    takes no such argument."""
    package = importable_package("probe_noexec_filter", {"a": "def helper(): pass\n"})
    assert [f["name"] for f in manager.get_functions_from_package_noexec(package)["a"]["functions"]] == [
        "helper"
    ]


def test_get_functions_from_package_noexec_lists_a_single_module(manager, importable_module):
    name = importable_module("probe_noexec_single", "raise RuntimeError('boom')\n\ndef seq_a(): pass\n")
    result = manager.get_functions_from_package_noexec(name)
    assert list(result) == [name]
    assert result[name]["full_module_path"] == name
    assert [f["name"] for f in result[name]["functions"]] == ["seq_a"]
    assert name not in sys.modules


# ---------------------------------------------------------------------------
# execute_function -- the call the worker migration has to turn into one atomic worker RPC
# ---------------------------------------------------------------------------


@pytest.fixture
def sequence_module(source_manager, isolated_interpreter_state):
    """A module of sequence-shaped functions, registered directly in
    `sys.modules` so `importlib.import_module` finds it. Safe to leave behind:
    `isolated_interpreter_state` restores `sys.modules` wholesale."""
    module = ModuleType("probe_sequences")

    module.returns_seq = lambda **kw: _SeqLike()
    module.returns_seq_first = lambda: (_SeqLike(), "extra")
    module.returns_seq_second = lambda: ("extra", _SeqLike())
    module.returns_falsy_seq = lambda: _FalsySeqLike()
    module.returns_nothing = lambda: None
    module.echoes = lambda **kw: kw

    def raises_value_error():
        raise ValueError("bad parameter")

    def raises_key_error():
        raise KeyError()

    module.raises_value_error = raises_value_error
    module.raises_key_error = raises_key_error

    sys.modules["probe_sequences"] = module
    return module


def test_execute_function_reports_success_as_a_json_string(manager, sequence_module):
    result = json.loads(manager.execute_function("probe_sequences", "returns_seq"))
    assert result["result"] == "SUCCESS"
    assert "Result type: _SeqLike" in result["message"]


def test_execute_function_publishes_the_sequence_to_all_three_globals(
    manager, source_manager, sequence_module
):
    """The one contract every JS caller depends on. `seq_explorer.js` and
    `scan_module.js` both read `SourceManager._last_sequence`, falling back to
    `__main__.seq`; the worker migration has to reproduce all of it in a single RPC."""
    import __main__

    manager.execute_function("probe_sequences", "returns_seq")
    stored = source_manager.SourceManager._last_sequence
    assert isinstance(stored, _SeqLike)
    assert __main__.seq is stored
    assert sys.modules["__main__"].seq is stored


def test_execute_function_takes_the_sequence_from_the_head_of_a_tuple(
    manager, source_manager, sequence_module
):
    manager.execute_function("probe_sequences", "returns_seq_first")
    assert isinstance(source_manager.SourceManager._last_sequence, _SeqLike)


def test_execute_function_misses_a_sequence_that_is_not_first(manager, source_manager, sequence_module):
    """CHARACTERISATION: only `result[0]` is inspected, so a function returning
    `(metadata, seq)` reports SUCCESS while the sequence is silently dropped and
    the UI says "No sequence found"."""
    payload = json.loads(manager.execute_function("probe_sequences", "returns_seq_second"))
    assert payload["result"] == "SUCCESS"
    assert source_manager.SourceManager._last_sequence is None


def test_execute_function_stores_a_falsy_sequence(manager, source_manager, sequence_module):
    """Duck-type is independent of truthiness; store uses `is not None`.

    After `is_seq` accepts the object, `seq_to_store` is either None or a
    duck-typed sequence. A sequence whose empty instance is falsy (`__len__`
    == 0) must still be stored on all three globals.
    """
    import __main__

    payload = json.loads(manager.execute_function("probe_sequences", "returns_falsy_seq"))
    assert payload["result"] == "SUCCESS"
    stored = source_manager.SourceManager._last_sequence
    assert isinstance(stored, _FalsySeqLike)
    assert __main__.seq is stored
    assert sys.modules["__main__"].seq is stored


def test_execute_function_clears_the_previous_sequence_first(manager, source_manager, sequence_module):
    import __main__

    manager.execute_function("probe_sequences", "returns_seq")
    assert source_manager.SourceManager._last_sequence is not None
    manager.execute_function("probe_sequences", "returns_nothing")
    assert source_manager.SourceManager._last_sequence is None
    assert __main__.seq is None


def test_execute_function_evaluates_arguments_as_python_expression_strings(manager, sequence_module):
    """This is the JS boundary: `seq_explorer.js` builds every value as a Python
    *source* string -- `'True'`, `'96'`, `'np.array([1, 2])'`, `'"text"'`."""
    captured = {}
    sequence_module.echoes = lambda **kw: captured.update(kw)
    manager.execute_function(
        "probe_sequences",
        "echoes",
        {"flag": "True", "n": "96", "text": '"hello"', "expr": "2 * 3"},
    )
    assert captured == {"flag": True, "n": 96, "text": "hello", "expr": 6}


def test_execute_function_can_build_numpy_arrays_from_an_argument(manager, sequence_module):
    import numpy as np

    captured = {}
    sequence_module.echoes = lambda **kw: captured.update(kw)
    manager.execute_function("probe_sequences", "echoes", {"fov": "np.array([1, 2])"})
    assert np.array_equal(captured["fov"], np.array([1, 2]))


@pytest.mark.parametrize("args", [None, {}])
def test_execute_function_accepts_no_arguments(manager, sequence_module, args):
    assert json.loads(manager.execute_function("probe_sequences", "returns_seq", args))["result"] == (
        "SUCCESS"
    )


def test_execute_function_rejects_a_non_string_argument_value(manager, sequence_module):
    """CHARACTERISATION -- the JS-boundary case worth knowing before the worker migration.

    Values must be Python source strings. A JS number arriving unquoted (which is
    what happens the moment someone builds `args_dict` from real JS values rather
    than from `valExpr` strings) reaches `eval` as an int and fails with a message
    that blames the argument rather than the caller.
    """
    with pytest.raises(ValueError, match="Failed to evaluate argument 'n': 96"):
        manager.execute_function("probe_sequences", "echoes", {"n": 96})


def test_execute_function_reports_an_unevaluable_expression(manager, sequence_module):
    with pytest.raises(ValueError, match="Failed to evaluate argument 'n'"):
        manager.execute_function("probe_sequences", "echoes", {"n": "1 +"})


def test_execute_function_requires_a_module_path(manager, sequence_module):
    with pytest.raises(ValueError, match="module_path must be provided"):
        manager.execute_function("", "returns_seq")


def test_execute_function_lets_an_import_error_through_unwrapped(manager, isolated_interpreter_state):
    with pytest.raises(ModuleNotFoundError):
        manager.execute_function("no_such_sequence_module", "seq_a")


def test_execute_function_raises_for_a_missing_function(manager, sequence_module):
    with pytest.raises(AttributeError, match="Function 'nope' not found in module"):
        manager.execute_function("probe_sequences", "nope")


def test_execute_function_wraps_a_failing_sequence_but_not_a_value_error(manager, sequence_module):
    """CHARACTERISATION: `except ValueError: raise` sits above the general
    handler, so a sequence that validates its own parameters with ValueError
    reaches JS unwrapped and without the function name, while every other
    exception becomes a RuntimeError that names it."""
    with pytest.raises(ValueError, match="^bad parameter$"):
        manager.execute_function("probe_sequences", "raises_value_error")

    with pytest.raises(RuntimeError, match=r"Error executing function 'raises_key_error': KeyError"):
        manager.execute_function("probe_sequences", "raises_key_error")


def test_execute_function_falls_back_to_the_exception_class_name(manager, sequence_module):
    def raises_blank():
        raise RuntimeError("")

    sequence_module.raises_blank = raises_blank
    with pytest.raises(RuntimeError, match="'raises_blank': RuntimeError"):
        manager.execute_function("probe_sequences", "raises_blank")


def test_execute_function_purges_pypulseq_from_the_module_cache(
    manager, sequence_module, source_manager
):
    """CHARACTERISATION -- a real side effect, pinned because it is easy to lose
    in a worker migration.

    Whenever the cached `pypulseq` lacks an `opts` attribute, every `pypulseq*`
    entry is deleted from `sys.modules` so the next import picks up the real
    package. In the browser that is the recovery path from the explorer's mock
    module. On the host the repo's own `pypulseq/` namespace package never has
    `opts`, so the purge fires on every call -- which also evicts
    `pypulseq.seq_source_manager`, and is the second reason these tests load the
    module by path instead.
    """
    import pypulseq

    assert sys.modules["pypulseq"] is pypulseq
    sys.modules["pypulseq.probe_marker"] = ModuleType("pypulseq.probe_marker")
    manager.execute_function("probe_sequences", "returns_seq")
    assert "pypulseq.probe_marker" not in sys.modules


def test_execute_function_never_removes_a_mock_module(manager, sequence_module):
    """execute_function does not evict a cached `mrseq` (or its submodules).

    The force-reimport path only clears `pypulseq` when it lacks `opts`
    (see the test above). `mrseq` and `ismrmrd` stay in `sys.modules`.
    """
    assert ModuleType("x").__class__.__name__ == "module"

    mock = ModuleType("mrseq")
    sys.modules["mrseq"] = mock
    sys.modules["mrseq.scripts"] = ModuleType("mrseq.scripts")
    manager.execute_function("probe_sequences", "returns_seq")
    assert sys.modules["mrseq"] is mock
    assert "mrseq.scripts" in sys.modules


def test_execute_function_puts_the_filesystem_root_on_sys_path(manager, sequence_module):
    """So that a protocol's `from built_in_seq.x import seq_x` resolves against
    the VFS root. Never removed, and on a real filesystem it means `'/'`."""
    import os

    manager.execute_function("probe_sequences", "returns_seq")
    assert sys.path[0] == os.path.abspath(os.path.sep)
