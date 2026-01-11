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
            except Exception as e:
                raise ValueError(f"Failed to parse config: {e}")
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
            List of function dictionaries
        """
        import ast
        
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
                            arg_str += f": {ast.unparse(arg.annotation)}"
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
            # Fallback to regex or execution-based extraction
            import re
            # Simple regex fallback
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
    
    def extract_function_parameters(self, module_path, function_name, code=None):
        """
        Extract parameters from a function using inspect or AST.
        
        Args:
            module_path: Full module path (e.g., 'mrseq.scripts.t1_inv_rec_gre_single_line')
            function_name: Name of the function
            code: Optional source code (for file-based sources)
            
        Returns:
            List of parameter dictionaries
        """
        import numpy as np
        
        try:
            # Try to import and inspect
            if module_path:
                module = importlib.import_module(module_path)
                func = getattr(module, function_name)
            elif code:
                # Execute code and extract function
                namespace = {}
                exec(code, namespace)
                func = namespace.get(function_name)
                if not func:
                    raise AttributeError(f"Function '{function_name}' not found in code")
            else:
                raise ValueError("Either module_path or code must be provided")
            
            sig = inspect.signature(func)
            params = []
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
    
    def load_source(self, source, filter_seq_prefix=False):
        """
        Load sequences from a source.
        
        Args:
            source: Source dictionary with type, path, etc.
            filter_seq_prefix: Whether to filter for seq_ or main functions
            
        Returns:
            Dictionary of sequences (filename -> {functions, source, code})
        """
        sequences = {}
        
        if source['type'] == 'pyodide_module':
            # Load from installed package
            all_functions = self.get_functions_from_package(
                source['module'],
                filter_seq_prefix=filter_seq_prefix
            )
            
            if 'error' in all_functions:
                raise Exception(all_functions['error'])
            
            for module_name, module_data in all_functions.items():
                fileName = f"{module_name}.py"
                sequences[fileName] = {
                    'functions': module_data['functions'],
                    'source': {**source, 'moduleName': module_name, 'fullModulePath': module_data['full_module_path']},
                    'code': None  # Not available for module sources
                }
        
        elif source['type'] in ['local_file', 'github_raw']:
            # For file-based sources, code should be provided
            # This would be handled by JavaScript fetching the file
            # Python would then parse it
            pass
        
        return sequences


# Example sources configuration
EXAMPLE_SOURCES = """
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
        'type': 'local_file',
        'path': 'mr0_rare_2d_seq.py',
        'dependencies': ['pypulseq']
    }
]
"""
