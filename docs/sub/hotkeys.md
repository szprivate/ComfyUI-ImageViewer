# Keyboard Shortcuts

All hotkeys are active only when the mouse cursor is **hovering over the viewer panel** (except <kbd>E</kbd>-drag and <kbd>Alt</kbd>+<kbd>Enter</kbd>). Typing in an input or textarea field inside the parameter panel temporarily suspends hotkeys.

← [Back to index](../index.md)

> [!TIP]
> Press `?` while hovering the viewer to open the built-in hotkey overlay without leaving the browser.

---

## Frame Navigation

| Key | Action |
|---|---|
| <kbd>←</kbd> | Step back one frame |
| <kbd>→</kbd> | Step forward one frame |
| <kbd>Ctrl</kbd>+<kbd>←</kbd> | Jump to first frame (Rewind) |
| <kbd>Ctrl</kbd>+<kbd>→</kbd> | Jump to last frame (End) |
| <kbd>Space</kbd> | Play / Pause |

## History

| Key / Interaction | Action |
|---|---|
| <kbd>↑</kbd> | Go to previous history snapshot (newer) |
| <kbd>↓</kbd> | Go to next history snapshot (older) |
| <kbd>Shift</kbd>+click thumbnail | Select two history items for side-by-side comparison |
| Right-click thumbnail | Context menu — Copy Path / Remove snapshot |

## Tabs

| Key / Interaction | Action |
|---|---|
| <kbd>1</kbd>–<kbd>9</kbd> | Switch to tab 1–9 (in display order) |
| <kbd>Shift</kbd>+click tab | Select tab as comparison source; Shift-click another to open split view |

## Viewport

| Key | Action |
|---|---|
| <kbd>F</kbd> | Toggle fit-to-screen zoom |
| <kbd>S</kbd> | Toggle tensor shape overlay |
| <kbd>C</kbd> | Toggle compare / split-view mode |

## Channels & Exposure

| Key / Interaction | Action |
|---|---|
| <kbd>R</kbd> | Isolate Red channel (press again to return to RGB) |
| <kbd>G</kbd> | Isolate Green channel |
| <kbd>B</kbd> | Isolate Blue channel |
| <kbd>E</kbd>+drag | Hold E and drag horizontally to scrub exposure (−4 EV to +4 EV) |
| Right-click exposure control | Reset exposure to 0.0 EV |

## Timeline

| Key / Interaction | Action |
|---|---|
| Click timeline | Jump to frame at that position |
| Drag timeline | Scrub through frames |
| <kbd>Ctrl</kbd>+drag timeline | Define a playback sub-range (highlighted in orange) |

## Workflow

| Key | Action |
|---|---|
| <kbd>Alt</kbd>+<kbd>Enter</kbd> | Queue prompt (run ComfyUI workflow) — works while hovering the viewer |
| <kbd>?</kbd> | Open / close the in-viewer hotkey help overlay |

## Mouse Interactions

| Interaction | Action |
|---|---|
| Drag viewport | Pan image (when zoomed beyond fit-to-screen) |
| Drag compare divider | Adjust the split position in comparison mode |
| Drag panel edge / corner | Resize the viewer panel |
| Drag tab bar (empty area) | Move the entire viewer panel |
| Drag parameter panel edge | Resize the parameter panel width |
| Drag history strip edge | Resize the history strip |

---

## Hotkey Conditions

| Condition | Effect on hotkeys |
|---|---|
| Mouse outside viewer panel | All hotkeys disabled (except <kbd>Alt</kbd>+<kbd>Enter</kbd>) |
| Cursor inside an input / textarea | Hotkeys suspended while typing |
| Viewer undocked to popout window | Hotkeys active in the popout window |

---

← [Node Reference](nodes.md) | [Back to index](../index.md)
