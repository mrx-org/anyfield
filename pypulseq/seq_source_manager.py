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
    
    def extract_function_parameters(self, module_path=None, function_name=None, code=None):
        """
        Extract parameters from a function using AST first, then inspect as fallback.
        
        Args:
            module_path: Full module path (e.g., 'mrseq.scripts.t1_inv_rec_gre_single_line')
            function_name: Name of the function
            code: Optional source code (for file-based sources)
            
        Returns:
            List of parameter dictionaries with 'name', 'default', 'type'
        """
        import numpy as np
        import __main__
        
        params = []
        
        # Try AST-based extraction first (doesn't require execution)
        if code and function_name:
            try:
                tree = ast.parse(code)
                for node in ast.walk(tree):
                    if isinstance(node, ast.FunctionDef) and node.name == function_name:
                        # Found the function in AST, extract signature
                        num_args = len(node.args.args)
                        num_defaults = len(node.args.defaults)
                        default_start_idx = num_args - num_defaults
                        
                        for arg_index, arg in enumerate(node.args.args):
                            param_name = arg.arg
                            if param_name == 'system':
                                continue
                            
                            # Try to get default value
                            val = None
                            type_name = 'None'
                            if arg_index >= default_start_idx:
                                default_val = node.args.defaults[arg_index - default_start_idx]
                                try:
                                    # Use ast.literal_eval for simple literals
                                    val = ast.literal_eval(default_val)
                                    type_name = type(val).__name__
                                    if isinstance(val, (list, tuple)):
                                        type_name = 'list'
                                        val = list(val)
                                except:
                                    # For complex expressions, can't evaluate - use None
                                    val = None
                                    type_name = 'None'
                            
                            params.append({
                                'name': param_name,
                                'default': val,
                                'type': type_name
                            })
                        
                        return params  # Successfully extracted from AST
            except Exception as e:
                # AST parsing failed, fall back to execution method
                pass
        
        # Fallback: Use inspect (requires execution)
        try:
            func = None
            
            if module_path:
                module = importlib.import_module(module_path)
                func = getattr(module, function_name, None)
            elif code:
                # Create a clean namespace for execution
                exec_globals = {'__name__': '__main__', '__builtins__': __builtins__}
                exec_globals.update(__main__.__dict__)
                
                # Execute the code
                try:
                    exec(code, exec_globals)
                except Exception as exec_err:
                    # If execution fails, try to continue - function might still be defined
                    pass
                
                # Get the function from the execution namespace
                func = exec_globals.get(function_name, None)
                
                # Also check __main__ in case it was set there
                if func is None:
                    func = getattr(__main__, function_name, None)
                
                # If still not found, try executing in __main__ directly
                if func is None:
                    try:
                        __main__.__name__ = '__main__'
                        exec(code, __main__.__dict__)
                        func = getattr(__main__, function_name, None)
                    except Exception:
                        pass
                
                if func is None:
                    # Last resort: search all defined functions
                    all_funcs = {k: v for k, v in exec_globals.items() if inspect.isfunction(v)}
                    if function_name in all_funcs:
                        func = all_funcs[function_name]
                    else:
                        available = [k for k in all_funcs.keys() if not k.startswith('_')]
                        raise AttributeError(f"Function '{function_name}' not found in code. Available functions: {available}")
            else:
                raise ValueError("Either module_path or code must be provided")
            
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
                
                params.append({
                    'name': name,
                    'default': val,
                    'type': type_name
                })
            
            return params
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
    
    def execute_function(self, module_path=None, function_name=None, code=None, args_dict=None):
        """
        Execute a function with given arguments.
        
        Args:
            module_path: Full module path (for module-based sources)
            function_name: Name of the function to execute
            code: Python code string (for file-based sources)
            args_dict: Dictionary of argument name -> Python expression string (will be evaluated)
            
        Returns:
            Result of function execution (as JSON-serializable string)
        """
        import __main__
        import sys
        import importlib
        from types import ModuleType
        
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
        elif code:
            # Execute the code to make the function available
            # First, check if code has necessary imports and add them if missing
            # This is especially important for user-edited code that may be missing imports
            code_lines = code.split('\n')
            # Find where actual Python code starts (after TOML preamble)
            code_start_idx = 0
            for i, line in enumerate(code_lines):
                stripped = line.strip()
                # Skip TOML preamble (lines with #, """, or empty)
                if stripped and not stripped.startswith('#') and not stripped.startswith('"""') and stripped != '"""':
                    code_start_idx = i
                    break
            
            # Check for imports in the actual code (not in TOML preamble)
            has_imports = any(line.strip().startswith(('import ', 'from ')) for line in code_lines[code_start_idx:code_start_idx+50])
            
            # If no imports found, try to add common ones based on what's used in the code
            if not has_imports:
                # Check what's used in the code (more comprehensive detection)
                needs_pypulseq = any(keyword in code for keyword in ['pp.', 'pp.Opts', 'pp.Sequence', 'pypulseq', 'Sequence(', 'Opts('])
                needs_numpy = any(keyword in code for keyword in ['np.', 'np.ndarray', 'np.array', 'numpy', 'ndarray', 'array('])
                needs_mrseq = any(keyword in code for keyword in ['mrseq.', 'sys_defaults', 't1_inv_rec', 'add_t1_inv'])
                needs_path = 'Path(' in code or 'Path.' in code or 'from pathlib' in code.lower()
                needs_sys = 'sys.' in code or '__file__' in code
                
                # Build import block
                import_block = []
                if needs_pypulseq:
                    import_block.append('import pypulseq as pp')
                if needs_numpy:
                    import_block.append('import numpy as np')
                if needs_mrseq:
                    import_block.append('from mrseq.utils.system_defaults import sys_defaults')
                    # Try to import common mrseq functions
                    if 't1_inv_rec_gre_single_line_kernel' in code:
                        import_block.append('from mrseq.scripts.t1_inv_rec_gre_single_line import t1_inv_rec_gre_single_line_kernel')
                if needs_path:
                    import_block.append('from pathlib import Path')
                if needs_sys:
                    import_block.append('import sys')
                
                if import_block:
                    # Insert imports after TOML preamble but before function definition
                    if code_start_idx > 0:
                        # Split code into preamble and actual code
                        preamble = '\n'.join(code_lines[:code_start_idx])
                        actual_code = '\n'.join(code_lines[code_start_idx:])
                        code = preamble + '\n\n' + '\n'.join(import_block) + '\n\n' + actual_code
                    else:
                        code = '\n'.join(import_block) + '\n\n' + code
            
            try:
                __main__.__name__ = '__main__'
                # Set __file__ for code execution (needed for Path(__file__) and similar)
                # Create execution globals with __file__ set
                exec_globals = dict(__main__.__dict__)
                # Set __file__ to a meaningful filename
                # Try to extract filename from TOML metadata if available
                filename = f'user_edited_{function_name}.py'
                if '_source_config_toml' in code:
                    try:
                        import re
                        toml_match = re.search(r'name = "([^"]+)"', code)
                        if toml_match:
                            filename = toml_match.group(1)
                    except:
                        pass
                exec_globals['__file__'] = filename
                exec(code, exec_globals)
                # Update __main__ with any new definitions
                __main__.__dict__.update(exec_globals)
            except Exception as e:
                raise RuntimeError(f"Failed to execute code: {e}")
            
            func = getattr(__main__, function_name, None)
            if func is None:
                raise AttributeError(f"Function '{function_name}' not found in code")
        else:
            raise ValueError("Either module_path or code must be provided")
        
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
            if result is not None and hasattr(result, 'plot') and hasattr(result, 'check_timing'):
                __main__.seq = result
                # Also store via sys.modules to ensure it's accessible
                sys.modules['__main__'].seq = result
                # Store in a class variable that SourceManager can access
                SourceManager._last_sequence = result
            
            # Return result as string (for JSON serialization)
            return json.dumps({'result': 'SUCCESS', 'message': f"Function executed successfully. Result type: {type(result).__name__}"})
        except Exception as e:
            raise RuntimeError(f"Error executing function '{function_name}': {e}")
