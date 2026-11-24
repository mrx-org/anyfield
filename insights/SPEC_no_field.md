# No-field Scanner Specification

## Intent
Unified MRI laboratory dashboard that synchronizes spatial FOV planning with pulse sequence timing and verification.

## Core Functionality
- **Dual-Mode Shell**:
  - **Planning**: Prioritizes 3D anatomical orientation and FOV box positioning. Main viewer (**A**) may share `slot-main` with scan preview (**B**) and, when opened, compare (**C**); see `insights/SPEC_niivue.md` (lazy compare pane, B↔C sync).
  - **Sequence**: Prioritizes pulse sequence waveform visualization and parameter tuning.
- **Auto-Mode Switching**: The app intelligently switches modes based on user interaction (viewing scans, interacting with the viewer, or generating sequences).
- **Live Link**: Automatic injection of Niivue FOV coordinates into pulse sequence parameters via `EventHub`.
- **Scan Management**: Integrated `ScanModule` for executing simulations and managing a session-based result queue.
- **Slot System**: CSS Grid "Slot" architecture for dynamic component swapping between sidebar, main, and footer areas.
- **View Management**: `ViewManager` state machine for orchestrating module placement and tracking current mode.

## Architecture
- **Entry**: `index.html` — markup and the module-container cache only. The startup
  sequence is `app_bootstrap.js` (`bootstrap()`) and the slot/mode machine is
  `view_manager.js`; modules reach each other through the `AppContext` in `app_context.js`.
- **Communication**: Pub/Sub `EventHub` for decoupled module interaction.
- **Layout**: Compact header (36px) and responsive grid.

## UI Layout (CSS Grid Architecture)
The dashboard uses a "Slot" system to dynamically swap components between `Planning` and `Sequence` modes.

```
+-------------------------------------------------------------+
|                        Header (36px)                        |
| [No-field Scanner]                                          |
+-------------------------------------------------------------+
|                   |                                         |
|   slot-sidebar    |               slot-main                 |
|                   |                                         |
| [NiivueModule     |   Planning: A | B [| C] (flex row)   |
|  Controls (Tabs)] |   Sequence: SequenceExplorer plot |
|                   |   (see SPEC_niivue.md for B/C)   |
|                   |                                         |
+-------------------------------------------------------------+
|                slot-footer (Full Width)                     |
| +-------------------+----------+--------------------------+ |
| | col-tree          | col-scan | col-params               | |
| | [SequenceExplorer | [Scan    | [SequenceExplorer        | |
| |  Sequences]       |  Module] |  Protocol]               | |
| +-------------------+----------+--------------------------+ |
+-------------------------------------------------------------+
```

## Mobile Adaptations

The dashboard includes specific adaptations for mobile devices (viewport ≤768px).

### Layout Changes
- **Sidebar collapsed by default**: On mobile, the viewer pane (sidebar) starts collapsed to maximize screen space for the main content.
- **Footer card navigation**: The three footer columns (Sequences, Scan, Protocol) become horizontally scrollable cards with dot indicators.

### Touch Interactions
- **Footer dot swiping**: The dot indicator area responds to swipe gestures to navigate between footer cards.
- **FOV touch dragging**: When the FOV checkbox is enabled, single-finger touch directly drags the FOV box position.
  - Touch centers the FOV at the initial touch point
  - Dragging moves the FOV in the slice plane
  - Works on any touch-enabled device (not limited to mobile viewport)
  - Desktop still uses Ctrl + mouse drag

### CSS Overrides
Mobile-specific styles are defined in `no_field_mobile.css`:
- Footer cards use `scroll-snap` for smooth card-based navigation
- Dot indicators are visible and interactive on mobile
- Various spacing and sizing adjustments for touch-friendly targets


## Pro mode
- **Activation**: URL `?pro=1` (or `true`/`yes`). Written to `window.pro` by `app_bootstrap.js`
  (for `index.html`) and by `viewer.html`; the same write toggles the `.pro-user` class on
  `<html>`, which is load-bearing CSS in `no_field.css` and `scan_module.css`. Every *read*
  goes through `isProUser()` in `pro_mode.js`, which re-parses the URL as a fallback because
  `paper_plot/launch.js` reads the flag before the page has set it.
- **When on**: OPTIONS-tab debug block (volume/FOV/cursor info), PHANTOMS **Execute**, and **SCAN▶▶** (compare backend, default PDGv2). Phantom JSON editor (Save / edit) is always on the PHANTOMS tab. No persistence; reload without `?pro=1` to turn off.
- **The accepted values are wider than they look, and this is known.** All three sites use
  the regex `/^1|true|yes$/i`, in which `|` has lower precedence than the anchors, so it
  reads as `(^1)` or `(true)` or `(yes$)` — not as "the whole value is one of 1/true/yes".
  In practice pro mode turns on for any value *starting* with `1`, any value *containing*
  `true`, and any value *ending* in `yes`: `?pro=1`, `?pro=true`, `?pro=yes` as intended, but
  also `?pro=1abc`, `?pro=untrue`, `?pro=truthy` and `?pro=maybe-yes`. Values with none of
  those shapes (`?pro=0`, `?pro=no`, `?pro=`) correctly leave it off.
- **Why it is left alone:** pro mode is a UI-affordance flag, not a privilege boundary.
  Everything it gates is client-side code the browser has already downloaded, and the
  simulation backends it exposes enforce nothing about it, so a loose match grants no access
  that a determined user did not already have. Tightening the regex would change which URLs
  people currently rely on, so it is documented rather than fixed. If it is ever
  changed, all three copies must change together.