# No-field Scanner Specification

## Intent
Unified MRI laboratory dashboard that synchronizes spatial FOV planning with pulse sequence timing and verification.

## Core Functionality
- **Dual-Mode Shell**:
  - **Planning**: Prioritizes 3D anatomical orientation and FOV box positioning.
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
| [NiivueModule     |   +-------------------------------+     |
|  Controls (Tabs)] |   |      NiivueModule Viewer      |     |
|                   |   |              OR               |     |
|                   |   |     SequenceExplorer Plot     |     |
|                   |   +-------------------------------+     |
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
- **FOV dragging without Ctrl**: When the FOV checkbox is enabled, single-finger touch directly drags the FOV box position (no Ctrl key required, unlike desktop).
  - Touch centers the FOV at the initial touch point
  - Dragging moves the FOV in the slice plane
  - This mirrors how Niivue's crosshair responds to touch on mobile

### CSS Overrides
Mobile-specific styles are defined in `no_field_mobile.css`:
- Footer cards use `scroll-snap` for smooth card-based navigation
- Dot indicators are visible and interactive on mobile
- Various spacing and sizing adjustments for touch-friendly targets
