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
- **Entry**: `index.html`
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
- **Activation**: URL `?pro=1` (or `true`/`yes`). Parsed in `index.html` and `viewer.html`; stored as `window.pro` for use by any module.
- **When on**: OPTIONS-tab debug block (volume/FOV/cursor info), PHANTOMS **Execute**, and **SCAN▶▶** (rapisim). Phantom JSON editor (Save / edit) is always on the PHANTOMS tab. No persistence; reload without `?pro=1` to turn off.

## Chat assistant (optional)

Fourth header view — LLM sequence assistant. Backend: `chat/backend/`. See [SPEC_chat_assistant.md](SPEC_chat_assistant.md).