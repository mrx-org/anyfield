"""
Python-based source manager for sequence explorer.
Handles cloning, inspecting, and extracting sequences from various sources.
"""
import json
import inspect
import importlib
import pkgutil
import os
import sys
import re
import ast
from types import ModuleType
from pathlib import Path
from typing import get_origin, get_args

try:
    import tomllib
except ImportError:
    import tomli as tomllib


# PEP 723 inline script metadata block: https://peps.python.org/pep-0723/
_PEP723_BLOCK = re.compile(
    r'(?m)^# /// (?P<type>[a-zA-Z0-9-]+)$\s(?P<content>(^#(| .*)$\s)+)^# ///$'
)


def extract_pep723_block(code, block_type='script'):
    """
    Return the de-commented TOML text of the PEP 723 inline metadata block of the
    given type (default 'script'), or None if no such block is present.
    """
    for m in _PEP723_BLOCK.finditer(code or ''):
        if m.group('type') != block_type:
            continue
        lines = []
        for line in m.group('content').splitlines():
            if line.startswith('# '):
                lines.append(line[2:])
            elif line.startswith('#'):
                lines.append(line[1:])
            else:
                lines.append(line)
        return '\n'.join(lines)
    return None


def _ast_eval_simple_default(node):
    """Evaluate a simple literal default expression from a function parameter AST node."""
    import math
    import operator as op_mod

    np_constants = {
        'pi': math.pi,
        'e': math.e,
        'inf': math.inf,
        'nan': float('nan'),
        'pi_2': math.pi / 2,
    }

    if node is None:
        return None

    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, (ast.Tuple, ast.List)):
        return [_ast_eval_simple_default(el) for el in node.elts]
    if isinstance(node, ast.UnaryOp):
        value = _ast_eval_simple_default(node.operand)
        return -value if isinstance(node.op, ast.USub) else +value
    if isinstance(node, ast.BinOp):
        left = _ast_eval_simple_default(node.left)
        right = _ast_eval_simple_default(node.right)
        ops = {
            ast.Add: op_mod.add,
            ast.Sub: op_mod.sub,
            ast.Mult: op_mod.mul,
            ast.Div: op_mod.truediv,
            ast.Pow: op_mod.pow,
            ast.Mod: op_mod.mod,
        }
        fn = ops.get(type(node.op))
        if fn is None:
            raise ValueError
        return fn(left, right)
    if isinstance(node, ast.Attribute):
        if isinstance(node.value, ast.Name) and node.value.id in ('np', 'numpy', 'math'):
            value = getattr(math, node.attr, np_constants.get(node.attr))
            if value is None:
                raise ValueError
            return value
    if isinstance(node, ast.Name):
        if node.id in ('True', 'False', 'None'):
            return {'True': True, 'False': False, 'None': None}[node.id]
        if node.id in np_constants:
            return np_constants[node.id]
    raise ValueError(f'Cannot evaluate: {ast.dump(node)}')


def _ast_default_type_name(value):
    if isinstance(value, bool):
        return 'bool'
    if isinstance(value, int):
        return 'int'
    if isinstance(value, float):
        return 'float'
    if isinstance(value, str):
        return 'str'
    if isinstance(value, (list, tuple)):
        return 'list'
    return type(value).__name__


def _ast_param_type_from_annotation(arg):
    if arg.annotation is None:
        return None
    try:
        ann_src = ast.unparse(arg.annotation)
    except Exception:
        return None
    if 'Annotated' in ann_src:
        if '"file"' in ann_src or "'file'" in ann_src:
            return 'file'
        if '"url"' in ann_src or "'url'" in ann_src:
            return 'url'
    return None


def _ast_param_dict_from_arg(arg, default_node):
    name = arg.arg
    val, type_name = None, 'None'

    if default_node is not None:
        try:
            val = _ast_eval_simple_default(default_node)
            if isinstance(val, (list, tuple)):
                val = list(val)
            type_name = _ast_default_type_name(val)
        except Exception:
            try:
                val = ast.unparse(default_node)
                type_name = 'unknown'
            except Exception:
                val = None

    annotated_type = _ast_param_type_from_annotation(arg)
    if annotated_type is not None:
        type_name = annotated_type

    return {'name': name, 'default': val, 'type': type_name}


def _ast_function_params(func_args, skip_system=True):
    """Build UI parameter dicts from a function ``arguments`` AST node (incl. keyword-only)."""
    params = []

    positional_args = func_args.args
    positional_defaults = func_args.defaults
    n_pos = len(positional_args)
    n_defaults = len(positional_defaults)
    default_map = {n_pos - n_defaults + i: positional_defaults[i] for i in range(n_defaults)}

    for i, arg in enumerate(positional_args):
        if skip_system and arg.arg == 'system':
            continue
        params.append(_ast_param_dict_from_arg(arg, default_map.get(i)))

    for i, arg in enumerate(func_args.kwonlyargs):
        if skip_system and arg.arg == 'system':
            continue
        default_node = func_args.kw_defaults[i] if i < len(func_args.kw_defaults) else None
        params.append(_ast_param_dict_from_arg(arg, default_node))

    return params


def _ast_format_arg(arg, default_node=None):
    arg_str = arg.arg
    if arg.annotation:
        try:
            arg_str += f': {ast.unparse(arg.annotation)}'
        except Exception:
            pass
    if default_node is not None:
        try:
            arg_str += f' = {ast.unparse(default_node)}'
        except Exception:
            pass
    return arg_str


def _ast_format_function_signature(func_args):
    """Format ``(plot, *, fov=..., n_read=...)`` including keyword-only parameters after ``*``."""
    parts = []

    positional = list(func_args.args)
    defaults = func_args.defaults
    n_pos = len(positional)
    n_defaults = len(defaults)
    default_map = {n_pos - n_defaults + i: defaults[i] for i in range(n_defaults)}
    for i, arg in enumerate(positional):
        parts.append(_ast_format_arg(arg, default_map.get(i)))

    if func_args.vararg:
        parts.append(f'*{func_args.vararg.arg}')
    elif func_args.kwonlyargs:
        parts.append('*')

    for i, arg in enumerate(func_args.kwonlyargs):
        default_node = func_args.kw_defaults[i] if i < len(func_args.kw_defaults) else None
        parts.append(_ast_format_arg(arg, default_node))

    if func_args.kwarg:
        parts.append(f'**{func_args.kwarg.arg}')

    return f'({", ".join(parts)})'


def _pep_install_from_toml_data(data):
    """PEP 723 install fields only — scanner metadata lives in `_anyfield_json`."""
    tool = data.get('tool', {}) or {}
    anyfield = tool.get('anyfield', {}) or {}
    return {
        'dependencies': data.get('dependencies', []) or [],
        'requires_python': data.get('requires-python'),
        'micropip_no_deps': anyfield.get('micropip_no_deps', []) or [],
    }


def extract_anyfield_json(code):
    """Return parsed `_anyfield_json` dict from the marked metadata block, or {} if absent.

    The scanner metadata is intentionally separate from PEP 723: PEP installs
    packages, `_anyfield_json` describes AnyField protocol/sim/recon semantics.
    Use AST literal parsing so no user code is executed while reading metadata.
    """
    text = code or ''
    marked = re.search(
        r'# --- AnyField metadata begin ---([\s\S]*?)# --- AnyField metadata end ---',
        text,
    )
    if not marked:
        return {}
    text = marked.group(1)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return {}
    for node in tree.body:
        targets = []
        value = None
        if isinstance(node, ast.Assign):
            targets = node.targets
            value = node.value
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
            value = node.value
        else:
            continue
        if not any(isinstance(t, ast.Name) and t.id == '_anyfield_json' for t in targets):
            continue
        if not isinstance(value, ast.Constant) or not isinstance(value.value, str):
            raise ValueError('_anyfield_json must be a string literal')
        data = json.loads(value.value)
        if not isinstance(data, dict):
            raise ValueError('_anyfield_json must decode to an object')
        return data
    return {}


def parse_script_metadata(code):
    """
    Parse PEP 723 install metadata plus optional `_anyfield_json` scanner metadata
    from a Python source string.

    Returns a JSON string for JS consumption:
      {
        "dependencies": [...],        # PEP 508 strings from PEP 723
        "requires_python": str|None,
        "anyfield": {...}             # _anyfield_json plus PEP install hints
      }
    """
    toml_text = extract_pep723_block(code, 'script')
    data = tomllib.loads(toml_text) if toml_text else {}
    install = _pep_install_from_toml_data(data)
    json_meta = extract_anyfield_json(code)
    anyfield = dict(json_meta) if json_meta else {}
    if install['micropip_no_deps']:
        anyfield['micropip_no_deps'] = install['micropip_no_deps']
    meta = {
        'dependencies': install['dependencies'],
        'requires_python': install['requires_python'],
        'micropip_no_deps': install['micropip_no_deps'],
        'anyfield': anyfield,
    }
    return json.dumps(meta)


def parse_metadata_toml(toml_text):
    """Parse already-extracted (de-commented) PEP 723 TOML install metadata."""
    data = tomllib.loads(toml_text) if toml_text else {}
    install = _pep_install_from_toml_data(data)
    return json.dumps({
        'dependencies': install['dependencies'],
        'requires_python': install['requires_python'],
        'micropip_no_deps': install['micropip_no_deps'],
    })


class SourceManager:
    """Manages sequence sources and their extraction."""
    
    def __init__(self, pyodide=None):
        self.pyodide = pyodide
        self.sources = []
        self.sequences = {}
        
    def load_sources_config(self, config_path_or_code):
        """
        Load sources from a Python file or JSON string.
        
        Args:
            config_path_or_code: Path to Python file, or Python code string, or JSON string
            
        Returns:
            List of source dictionaries
        """
        if isinstance(config_path_or_code, str):
            # Check if it's JSON
            if config_path_or_code.strip().startswith('{') or config_path_or_code.strip().startswith('['):
                try:
                    return json.loads(config_path_or_code)
                except json.JSONDecodeError:
                    pass

            # sources.toml: a [[sources]] array of tables (current registry format)
            if '[[sources]]' in config_path_or_code:
                try:
                    data = tomllib.loads(config_path_or_code)
                    if 'sources' in data:
                        return data['sources']
                    raise ValueError("sources.toml must define a [[sources]] array")
                except ValueError:
                    raise
                except Exception as e:
                    raise ValueError(f"Failed to parse sources.toml: {type(e).__name__}: {e}")

            raise ValueError("Config must be sources.toml ([[sources]] array) or JSON")
        else:
            raise ValueError("Config must be a string (TOML or JSON)")
    
    def add_source(self, source):
        """Add a source to the manager."""
        self.sources.append(source)
    
    def get_functions_from_package(self, package_path, filter_seq_prefix=False):
        """
        Extract functions from all modules in a package.
        
        Args:
            package_path: Python package path (e.g., 'mrseq.scripts')
            filter_seq_prefix: If True, only return functions starting with 'seq_' or named 'main'
            
        Returns:
            Dictionary mapping module names to their functions
        """
        try:
            package = importlib.import_module(package_path)
            package_path_obj = package.__path__ if hasattr(package, '__path__') else None
            
            all_functions = {}
            
            if package_path_obj:
                for importer, modname, ispkg in pkgutil.iter_modules(package_path_obj, package_path + '.'):
                    if ispkg:
                        continue
                    
                    try:
                        module = importlib.import_module(modname)
                        module_basename = os.path.basename(modname)
                        
                        functions = []
                        for name in dir(module):
                            if name.startswith('_'):
                                continue
                            
                            obj = getattr(module, name)
                            if inspect.isfunction(obj):
                                # Apply filter
                                if filter_seq_prefix and not (name.startswith('seq_') or name == 'main'):
                                    continue
                                
                                functions.append({
                                    'name': name,
                                    'doc': inspect.getdoc(obj) or '',
                                    'signature': str(inspect.signature(obj))
                                })
                        
                        if functions:
                            all_functions[module_basename] = {
                                'functions': functions,
                                'full_module_path': modname
                            }
                    except Exception as e:
                        print(f"Warning: Could not load module {modname}: {e}", file=sys.stderr)
                        continue
            else:
                # Single module
                module = importlib.import_module(package_path)
                module_name = os.path.basename(package_path)
                functions = []
                for name in dir(module):
                    if name.startswith('_'):
                        continue
                    obj = getattr(module, name)
                    if inspect.isfunction(obj):
                        if filter_seq_prefix and not (name.startswith('seq_') or name == 'main'):
                            continue
                        functions.append({
                            'name': name,
                            'doc': inspect.getdoc(obj) or '',
                            'signature': str(inspect.signature(obj))
                        })
                if functions:
                    all_functions[module_name] = {
                        'functions': functions,
                        'full_module_path': package_path
                    }
            
            return all_functions
        except Exception as e:
            return {'error': str(e)}

    def get_functions_from_package_noexec(self, package_path):
        """
        Find and AST-parse functions from an installed package WITHOUT importing
        any module.  Locates the package directory by scanning sys.path, then reads
        each .py file and parses with ast.parse — no importlib.import_module calls,
        so module-level side-effects (e.g. importing pypulseq) are never triggered.

        Args:
            package_path: Dotted package path (e.g. 'mrseq.scripts')

        Returns:
            Dict mapping module_basename -> {'functions': [...], 'full_module_path': str}
            or {'error': str} on failure.
        """
        parts = package_path.split('.')
        results = {}

        # Locate the package directory by scanning sys.path — no imports at all.
        pkg_dir = None
        for base in sys.path:
            candidate = os.path.join(base, *parts)
            if os.path.isdir(candidate):
                pkg_dir = candidate
                break
        if pkg_dir is None:
            return {'error': f'Package directory for {package_path!r} not found in sys.path'}

        for fn in sorted(os.listdir(pkg_dir)):
            if not fn.endswith('.py') or fn.startswith('_'):
                continue
            mod_stem = fn[:-3]
            full_mod_path = f'{package_path}.{mod_stem}'
            try:
                with open(os.path.join(pkg_dir, fn), 'r', encoding='utf-8', errors='replace') as f:
                    code = f.read()
                functions = self.parse_file_functions(code, filter_seq_prefix=False)
                if functions:
                    results[mod_stem] = {
                        'functions': functions,
                        'full_module_path': full_mod_path,
                    }
            except Exception as e:
                print(f'Warning: could not parse {fn}: {e}', file=sys.stderr)
                continue

        return results

    def parse_file_functions(self, code, filter_seq_prefix=False):
        """
        Parse Python code and extract function definitions.
        
        Args:
            code: Python source code string
            filter_seq_prefix: If True, only return functions starting with 'seq_' or named 'main'
            
        Returns:
            List of function dictionaries with 'name', 'doc', 'signature'
        """
        functions = []
        
        try:
            tree = ast.parse(code)
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef):
                    func_name = node.name
                    
                    # Apply filter
                    if filter_seq_prefix and not (func_name.startswith('seq_') or func_name == 'main'):
                        continue
                    
                    # Extract docstring
                    docstring = ast.get_docstring(node) or ''

                    signature = _ast_format_function_signature(node.args)
                    
                    functions.append({
                        'name': func_name,
                        'doc': docstring,
                        'signature': signature
                    })
        except SyntaxError as e:
            # Fallback to regex extraction
            pattern = r'def\s+(\w+)\s*\([^)]*\)\s*:'
            for match in re.finditer(pattern, code):
                func_name = match.group(1)
                if filter_seq_prefix and not (func_name.startswith('seq_') or func_name == 'main'):
                    continue
                functions.append({
                    'name': func_name,
                    'doc': '',
                    'signature': match.group(0)
                })
        
        return functions
    
    def extract_function_parameters_noexec(self, file_path, function_name, code=None):
        """
        Extract parameters AND docstring from a function using AST only — no module import.
        Reads the file from the Pyodide VFS (or uses ``code`` when provided) and parses with
        ast.parse, so module-level side-effects (e.g. 'import pypulseq') are never triggered.

        Args:
            file_path: Absolute or root-relative VFS path (e.g. '/built_in_seq/mr0_tse_2d_seq.py')
            function_name: Name of the function to extract from
            code: Optional source text (user protocols kept in JS memory / Pyodide VFS for the session)

        Returns:
            Dict {'params': [...], 'doc': str}
            params items: {'name': str, 'default': value, 'type': str}
        """
        import ast, math, operator as op_mod

        if code is None:
            # Resolve path — prepend '/' if needed
            if not os.path.isabs(file_path):
                file_path = '/' + file_path.lstrip('/')
            if not os.path.exists(file_path):
                raise FileNotFoundError(f"VFS file not found: {file_path}")
            with open(file_path, 'r', encoding='utf-8', errors='replace') as fh:
                code = fh.read()

        tree = ast.parse(code)

        # Find the target function (top-level only)
        func_node = None
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == function_name:
                func_node = node
                break
        if func_node is None:
            raise AttributeError(f"Function '{function_name}' not found in {file_path}")

        # Extract docstring
        doc = ast.get_docstring(func_node) or ''
        params = _ast_function_params(func_node.args)

        return {'params': params, 'doc': doc}

    def extract_function_parameters(self, module_path, function_name):
        """
        Extract parameters from a function using inspect (requires import).
        
        Args:
            module_path: Full module path (e.g., 'mrseq.scripts.t1_inv_rec_gre_single_line')
            function_name: Name of the function
            
        Returns:
            List of parameter dictionaries with 'name', 'default', 'type'
        """
        import numpy as np
        import os
        import sys
        
        params = []
        try:
            func = None
            
            if module_path:
                # Ensure filesystem root is on path so /built_in_seq, /pypulseq_examples, etc. can be imported
                _root = os.path.abspath(os.path.sep)
                if _root not in sys.path:
                    sys.path.insert(0, _root)
                module = importlib.import_module(module_path)
                func = getattr(module, function_name, None)
            else:
                raise ValueError("module_path must be provided")
            
            if func is None:
                raise AttributeError(f"Function '{function_name}' not found")
            
            # Extract parameters using inspect
            sig = inspect.signature(func)
            for name, p in sig.parameters.items():
                if name == 'system':
                    continue
                
                d = p.default
                val = d
                type_name = type(d).__name__
                
                if isinstance(d, np.ndarray):
                    val = d.tolist()
                    type_name = 'ndarray'
                elif isinstance(d, (tuple, list)):
                    val = list(d)
                    type_name = 'list'
                elif d is inspect._empty:
                    val = None
                    type_name = 'None'
                
                # Override type for typing.Annotated[str, "file"] or Annotated[str, "url"]
                if hasattr(p, 'annotation') and p.annotation is not inspect.Parameter.empty:
                    ann = p.annotation
                    origin = get_origin(ann)
                    if origin is not None:  # Annotated has a non-None origin in 3.9+
                        args = get_args(ann)
                        if len(args) >= 2 and args[1] in ('file', 'url'):
                            type_name = args[1]
                
                params.append({
                    'name': name,
                    'default': val,
                    'type': type_name
                })
            
            return params
        except (AttributeError, ValueError) as e:
            # Re-raise our clear "function not found" / "invalid args" messages as-is
            raise
        except Exception as e:
            raise Exception(f"Failed to extract parameters: {e}")
    
    def convert_notebook_to_python(self, notebook_json):
        """
        Convert Jupyter notebook JSON to Python code.
        
        Args:
            notebook_json: JSON string or dict of notebook
            
        Returns:
            Python code string with Colab/notebook commands removed
        """
        if isinstance(notebook_json, str):
            notebook = json.loads(notebook_json)
        else:
            notebook = notebook_json
        
        # Extract code from all code cells
        code_cells = []
        for cell in notebook.get('cells', []):
            if cell.get('cell_type') == 'code':
                # Join source lines (can be array of strings or single string)
                source = cell.get('source', '')
                if isinstance(source, list):
                    source = ''.join(source)
                
                # Clean up Colab/notebook-specific commands
                lines = source.split('\n')
                cleaned_lines = []
                for line in lines:
                    trimmed = line.strip()
                    # Skip empty lines, shell commands (!), magic commands (%), and help commands (?)
                    if trimmed and not trimmed.startswith('!') and not trimmed.startswith('%') and not trimmed.startswith('?'):
                        # Remove inline magic commands (e.g., "code %matplotlib inline")
                        cleaned_line = re.sub(r'\s*%\w+.*$', '', line)
                        if cleaned_line.strip():
                            cleaned_lines.append(cleaned_line)
                
                if cleaned_lines:
                    code_cells.append('\n'.join(cleaned_lines))
        
        return '\n\n'.join(code_cells)
    
    def execute_function(self, module_path, function_name, args_dict=None):
        """
        Execute a function with given arguments.
        
        Args:
            module_path: Full module path (for module-based sources)
            function_name: Name of the function to execute
            args_dict: Dictionary of argument name -> Python expression string (will be evaluated)
            
        Returns:
            Result of function execution (as JSON-serializable string)
        """
        import __main__
        import os
        import sys
        import importlib
        from types import ModuleType

        # Ensure filesystem root is on path so /built_in_seq can be imported
        # (protocols wrapping built-in sequences use "from built_in_seq.xxx import seq_xxx")
        _root = os.path.abspath(os.path.sep)
        if _root not in sys.path:
            sys.path.insert(0, _root)
        
        # Clear last sequence to avoid stale data from previous runs
        SourceManager._last_sequence = None
        if hasattr(__main__, 'seq'):
            __main__.seq = None
        
        # Remove any mock modules that might interfere with real imports
        for module_name in ['pypulseq', 'mrseq', 'ismrmrd']:
            if module_name in sys.modules:
                mod = sys.modules[module_name]
                # Check if it's a mock (simple ModuleType without __file__ or proper structure)
                is_mock = (
                    hasattr(mod, '__class__') and 
                    mod.__class__.__name__ == 'ModuleType' and
                    not hasattr(mod, '__file__') and
                    len(dir(mod)) < 10  # Mocks have very few attributes
                )
                if is_mock:
                    del sys.modules[module_name]
                    # Also remove any submodules
                    keys_to_remove = [k for k in list(sys.modules.keys()) if k.startswith(module_name + '.')]
                    for k in keys_to_remove:
                        del sys.modules[k]
        
        # Force reimport of packages to ensure real modules are loaded
        try:
            if 'pypulseq' not in sys.modules or not hasattr(sys.modules.get('pypulseq', None), 'opts'):
                if 'pypulseq' in sys.modules:
                    del sys.modules['pypulseq']
                for key in list(sys.modules.keys()):
                    if key.startswith('pypulseq.'):
                        del sys.modules[key]
                try:
                    import pypulseq
                    if not hasattr(pypulseq, 'opts'):
                        raise ImportError("pypulseq is not properly installed")
                except ImportError:
                    pass
        except Exception:
            pass
        
        # Get the function
        func = None
        if module_path:
            module = importlib.import_module(module_path)
            func = getattr(module, function_name, None)
            if func is None:
                raise AttributeError(f"Function '{function_name}' not found in module '{module_path}'")
        else:
            raise ValueError("module_path must be provided")
        
        # Build arguments from args_dict
        # args_dict contains Python expression strings that need to be evaluated
        import numpy as np
        converted_args = {}
        if args_dict:
            for key, value_expr in args_dict.items():
                # value_expr is a Python expression string (e.g., "True", "42", '"hello"', "np.array([1,2,3])")
                try:
                    # Evaluate the expression in a safe namespace
                    eval_globals = {'__builtins__': __builtins__, 'np': np}
                    eval_globals.update(__main__.__dict__)
                    converted_args[key] = eval(value_expr, eval_globals)
                except Exception as e:
                    raise ValueError(f"Failed to evaluate argument '{key}': {value_expr}. Error: {e}")
        
        # Call the function
        try:
            result = func(**converted_args)
            
            # Store the result in __main__.seq if it looks like a sequence object
            # This is critical for plotting - the caller expects to find the sequence in __main__.seq
            # Use multiple approaches to ensure it's accessible from the calling context
            
            # Helper to check if something is a sequence
            def is_seq(obj):
                return obj is not None and hasattr(obj, 'plot') and hasattr(obj, 'check_timing')

            seq_to_store = None
            if is_seq(result):
                seq_to_store = result
            elif isinstance(result, (list, tuple)) and len(result) > 0 and is_seq(result[0]):
                seq_to_store = result[0]
            
            if seq_to_store:
                __main__.seq = seq_to_store
                # Also store via sys.modules to ensure it's accessible
                sys.modules['__main__'].seq = seq_to_store
                # Store in a class variable that SourceManager can access
                SourceManager._last_sequence = seq_to_store
            
            # Return result as string (for JSON serialization)
            return json.dumps({'result': 'SUCCESS', 'message': f"Function executed successfully. Result type: {type(result).__name__}"})
        except ValueError:
            raise
        except Exception as e:
            msg = str(e).strip() or type(e).__name__
            raise RuntimeError(f"Error executing function '{function_name}': {msg}") from e
