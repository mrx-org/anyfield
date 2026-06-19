# Sequence Explorer Widget

A modular, flexible widget for exploring sequences/protocols organized by file, similar to the PySide UI pattern.

## Features

- **File-based grouping**: Sequences are organized by source file, with functions as children
- **Flexible filtering**: Optional checkbox to filter for functions starting with `seq_`
- **Multiple source types**: Load from local files, GitHub (raw files or folders), Pyodide modules, or custom loaders
- **Modular design**: Can be easily integrated into any HTML page
- **AST parsing**: Uses Pyodide for accurate Python AST parsing (with regex fallback)

## Files

- `seq_explorer.html` - Standalone test page
- `seq_explorer.js` - Main widget class (modular, reusable)
- `seq_explorer.css` - Widget styles

## Usage

### Basic Integration

```html
<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="seq_explorer.css">
    <style>
        :root {
            --bg: #0b1020;
            --panel: #111a33;
            --text: #e8ecff;
            --muted: #a9b3da;
            --border: rgba(255, 255, 255, 0.12);
            --accent: #3b82f6;
        }
    </style>
</head>
<body>
    <div id="my-explorer"></div>
    
    <script src="seq_explorer.js"></script>
    <script>
        const explorer = new SequenceExplorer('my-explorer', {
            onlySeqPrefix: false,
            sources: [
                {
                    name: 'anyseq',
                    type: 'folder',
                    path: 'https://github.com/mrx-org/anyfield/tree/main/pypulseq/anyseq'
                }
            ],
            onSequenceSelect: (sequence) => {
                console.log('Selected:', sequence);
            }
        });
    </script>
</body>
</html>
```

### Configuration Options

```javascript
{
    onlySeqPrefix: false,        // Filter for functions starting with 'seq_'
    sources: [...],              // Array of source configurations
    onSequenceSelect: (seq) => {}, // Callback when sequence is selected
    pyodide: pyodideInstance,    // Optional: Pyodide instance for better parsing and dependency installation
    showRefresh: true,           // Show refresh button
    showFilter: true             // Show filter checkbox
}
```

**Note:** `pyodide` is optional for basic functionality, but **required** if you want to:
- Install dependencies automatically
- Use more accurate AST parsing (falls back to regex without it)

### Source Types

The current registry shape matches `pypulseq/sources.toml`:

#### 1. File
```javascript
{
    name: 'Display Name',
    type: 'file',
    path: 'https://raw.githubusercontent.com/user/repo/main/file.py',
    dependencies: ['numpy', 'pypulseq==1.4.2.post2'],
    micropip_no_deps: ['pypulseq']
}
```

#### 2. Folder
```javascript
{
    name: 'pypulseq_examples',
    type: 'folder',
    path: 'https://github.com/imr-framework/pypulseq/tree/master/examples/scripts',
    dependencies: ['pypulseq==1.4.2.post2'],
    micropip_no_deps: ['pypulseq']
}
```

#### 3. Module
```javascript
{
    name: 'mrseq.scripts',
    type: 'module',
    path: 'mrseq.scripts',
    dependencies: ['numpy>=2.0.0', 'pypulseq==1.4.2.post2', 'mrseq', 'ismrmrd==1.14.2'],
    micropip_no_deps: ['pypulseq', 'mrseq']
}
```

#### 4. Custom Loader
```javascript
{
    type: 'custom',
    loader: async (explorer) => {
        // Custom loading logic
        const code = await fetch('...');
        explorer.parseFile('filename.py', code, source);
    }
}
```

## Dependency Management

Each source can specify `dependencies` that will be automatically installed via Pyodide's micropip before loading:

```javascript
{
    type: 'file',
    path: 'https://raw.githubusercontent.com/user/repo/main/file.py',
    dependencies: [
        'numpy>=2.0.0',           // Version specification
        { name: 'mrseq', deps: false },  // Install without dependency checks
        'ismrmrd==1.14.2'          // Pinned version (Pyodide / micropip)
    ]
}
```

**Features:**
- **Automatic installation**: Dependencies are installed before loading the source
- **Caching**: Already installed packages are skipped
- **Version handling**: Automatically handles numpy version conflicts (uninstalls old version first)
- **Error handling**: Continues with other packages if one fails

## Source Configuration

Default sources are defined in `pypulseq/sources.toml` as a `[[sources]]` array. The "Add Sources" button edits the same TOML shape. Each entry uses the current source types below and may provide registry-level fallback `dependencies` / `micropip_no_deps`.

### Source Types

- `file` - Load a single local/raw Python file or notebook-converted source.
- `folder` - Load all Python files from a GitHub folder source into `<name>_examples.scripts`.
- `module` - Load functions from an installed Python package module (e.g. `mrseq.scripts`).

## API

### Methods

- `loadSequences()` - Reload all sequences from sources
- `addSource(source)` - Add a new source and load it
- `clearSequences()` - Clear all loaded sequences
- `getSelectedSequence()` - Get currently selected sequence
- `renderTree()` - Manually re-render the tree

### Selected Sequence Object

When a sequence is selected, the callback receives:

```javascript
{
    fileName: 'file.py',
    functionName: 'seq_RARE_2D',
    name: 'seq_RARE_2D',
    doc: 'Function docstring...',
    signature: 'seq_RARE_2D(param1, param2=default)',
    source: { /* source configuration */ }
}
```

## Example: Loading Multiple Sources with Dependencies

```javascript
const explorer = new SequenceExplorer('explorer', {
    onlySeqPrefix: true,  // Only show seq_ functions
    pyodide: pyodide,     // Required for dependency installation
    sources: [
        {
            name: 'mrseq.scripts',
            type: 'module',
            path: 'mrseq.scripts',
            dependencies: ['numpy>=2.0.0', 'pypulseq==1.4.2.post2', 'mrseq', 'ismrmrd==1.14.2'],
            micropip_no_deps: ['pypulseq', 'mrseq']
        },
        {
            name: 'pypulseq_examples',
            type: 'folder',
            path: 'https://github.com/imr-framework/pypulseq/tree/master/examples/scripts',
            dependencies: ['pypulseq==1.4.2.post2'],
            micropip_no_deps: ['pypulseq']
        }
    ],
    onSequenceSelect: (sequence) => {
        console.log(`Selected: ${sequence.functionName} from ${sequence.fileName}`);
        // Load and execute the sequence...
    }
});
```

## Styling

The widget uses CSS variables for theming. Ensure these are defined:

```css
:root {
    --bg: #0b1020;
    --panel: #111a33;
    --text: #e8ecff;
    --muted: #a9b3da;
    --border: rgba(255, 255, 255, 0.12);
    --accent: #3b82f6;
}
```

## Testing

Open `seq_explorer.html` in a browser to test the widget. The page includes example initialization code that you can modify.

## Notes

- The widget works without Pyodide, but parsing is less accurate (uses regex fallback)
- GitHub folder loading uses the GitHub API (may be rate-limited)
- File headers are collapsible/expandable
- Functions are clickable and show selection state
