"""The app's single debug/e2e seam.

`index.html`'s bootstrap publishes its `AppContext` -- the registry holding the
live module instances -- as `window.anyfield`. Application code never reads it;
the modules all receive the same context by constructor injection. It exists so
the browser console and these tests can inspect app state, and it replaced the
eight ad-hoc `window.nvModule` / `window.seqExplorer` / ... globals the modules
used to reach each other through.
"""

CONTEXT_JS = "window.anyfield"
EXPLORER_JS = f"{CONTEXT_JS}?.explorer"
# The NiivueModule: viewer, volumeGroups, the Pyodide handle and the JSON/Execute tab.
NV_JS = f"{CONTEXT_JS}?.nv"
