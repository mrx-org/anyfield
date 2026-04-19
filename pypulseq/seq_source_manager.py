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


def parse_toml_config(toml_string):
    """
    Parse TOML preamble string (e.g. from _source_config_toml in sequence files).
    Returns a JSON string with keys 'dependencies' and 'metadata' for consumption by JS.
    """
    data = tomllib.loads(toml_string)
    dependencies = data.get("dependencies", {})
    metadata = data.get("metadata", {})
    return json.dumps({"dependencies": dependencies, "metadata": metadata})


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
            
            # Try as Python code
            try:
                # First, try to compile to catch syntax errors early
                try:
                    compile(config_path_or_code, '<config>', 'exec')
                except SyntaxError as syn_err:
                    # Provide helpful syntax error message with line number
                    line_num = syn_err.lineno or 'unknown'
                    line_text = syn_err.text or ''
                    raise ValueError(f"Python syntax error at line {line_num}: {syn_err.msg}\nLine: {line_text.strip()}")
                
                # Execute in a clean namespace
                namespace = {}
                exec(config_path_or_code, namespace)
                
                # Look for sources variable or get_sources function
                if 'sources' in namespace:
                    return namespace['sources']
                elif 'get_sources' in namespace:
                    return namespace['get_sources']()
                else:
                    raise ValueError("Python config must define 'sources' list or 'get_sources()' function")
            except ValueError:
                # Re-raise ValueError as-is (already has good message)
                raise
            except Exception as e:
                raise ValueError(f"Failed to parse config: {type(e).__name__}: {e}")
        else:
            raise ValueError("Config must be a string (Python code or JSON)")
    
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
                    
                    # Build signature string
                    args = []
                    for arg in node.args.args:
                        arg_str = arg.arg
                        if arg.annotation:
                            try:
                                arg_str += f": {ast.unparse(arg.annotation)}"
                            except:
                                pass
                        args.append(arg_str)
                    
                    # Handle defaults
                    defaults = node.args.defaults
                    if defaults:
                        for i, default in enumerate(defaults):
                            idx = len(args) - len(defaults) + i
                            try:
                                default_val = ast.unparse(default)
                                args[idx] += f" = {default_val}"
                            except:
                                pass
                    
                    signature = f"({', '.join(args)})"
                    
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
    
    def extract_function_parameters_noexec(self, file_path, function_name):
        """
        Extract parameters AND docstring from a function using AST only — no module import.
        Reads the file from the Pyodide VFS and parses it with ast.parse, so module-level
        side-effects (e.g. 'import pypulseq') are never triggered.

        Args:
            file_path: Absolute or root-relative VFS path (e.g. '/built_in_seq/mr0_tse_2d_seq.py')
            function_name: Name of the function to extract from

        Returns:
            Dict {'params': [...], 'doc': str}
            params items: {'name': str, 'default': value, 'type': str}
        """
        import ast, math, operator as op_mod

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

        # Build arg-index → default-node mapping
        args_list = func_node.args.args
        defaults = func_node.args.defaults
        n = len(args_list)
        d = len(defaults)
        default_map = {n - d + i: defaults[i] for i in range(d)}

        # numpy constant substitutions (covers common seq defaults)
        NP = {'pi': math.pi, 'e': math.e, 'inf': math.inf, 'nan': float('nan'),
              'pi_2': math.pi / 2}

        def _eval(node):
            """Recursively evaluate a simple AST expression."""
            if isinstance(node, ast.Constant):
                return node.value
            if isinstance(node, (ast.Tuple, ast.List)):
                return [_eval(el) for el in node.elts]
            if isinstance(node, ast.UnaryOp):
                v = _eval(node.operand)
                return -v if isinstance(node.op, ast.USub) else +v
            if isinstance(node, ast.BinOp):
                lv, rv = _eval(node.left), _eval(node.right)
                ops = {ast.Add: op_mod.add, ast.Sub: op_mod.sub,
                       ast.Mult: op_mod.mul, ast.Div: op_mod.truediv,
                       ast.Pow: op_mod.pow, ast.Mod: op_mod.mod}
                fn = ops.get(type(node.op))
                if fn is None:
                    raise ValueError
                return fn(lv, rv)
            if isinstance(node, ast.Attribute):
                if isinstance(node.value, ast.Name) and node.value.id in ('np', 'numpy', 'math'):
                    v = getattr(math, node.attr, NP.get(node.attr))
                    if v is None:
                        raise ValueError
                    return v
            if isinstance(node, ast.Name):
                if node.id in ('True', 'False', 'None'):
                    return {'True': True, 'False': False, 'None': None}[node.id]
                if node.id in NP:
                    return NP[node.id]
            raise ValueError(f"Cannot evaluate: {ast.dump(node)}")

        def _type_name(val):
            if isinstance(val, bool):   return 'bool'
            if isinstance(val, int):    return 'int'
            if isinstance(val, float):  return 'float'
            if isinstance(val, str):    return 'str'
            if isinstance(val, (list, tuple)): return 'list'
            return type(val).__name__

        params = []
        for i, arg in enumerate(args_list):
            name = arg.arg
            if name == 'system':
                continue

            val, type_name = None, 'None'

            if i in default_map:
                try:
                    val = _eval(default_map[i])
                    if isinstance(val, (list, tuple)):
                        val = list(val)
                    type_name = _type_name(val)
                except Exception:
                    try:
                        val = ast.unparse(default_map[i])
                        type_name = 'unknown'
                    except Exception:
                        val = None

            # Check for Annotated[str, "file"] / Annotated[str, "url"] type hints
            if arg.annotation is not None:
                try:
                    ann_src = ast.unparse(arg.annotation)
                    if 'Annotated' in ann_src:
                        if '"file"' in ann_src or "'file'" in ann_src:
                            type_name = 'file'
                        elif '"url"' in ann_src or "'url'" in ann_src:
                            type_name = 'url'
                except Exception:
                    pass

            params.append({'name': name, 'default': val, 'type': type_name})

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
        except Exception as e:
            raise RuntimeError(f"Error executing function '{function_name}': {e}")
