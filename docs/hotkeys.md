# Hotkeys

[Home](index.md)

Keys work while the pointer is over the viewer, and not while you type in a field. <kbd>?</kbd> shows the keys bound right now, including the current space's.

## Viewer

| Key | Action |
|---|---|
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | A frame back / on (<kbd>Ctrl</kbd>: first / last) |
| <kbd>↑</kbd> <kbd>↓</kbd> | Newer / older History snapshot |
| <kbd>1</kbd>–<kbd>9</kbd> | Switch tab |
| <kbd>F</kbd> | Fit to screen |
| <kbd>S</kbd> | Toggle overlays |
| <kbd>Shift</kbd>+<kbd>F</kbd> | Full screen (<kbd>Esc</kbd> leaves) |
| <kbd>C</kbd> | Compare on / off, then through the modes |
| <kbd>R</kbd> <kbd>G</kbd> <kbd>B</kbd> | One channel (again for RGB) |
| <kbd>E</kbd> + drag | Exposure |
| <kbd>Shift</kbd>+<kbd>Delete</kbd> | Remove the selected snapshots |
| <kbd>Shift</kbd>+<kbd>D</kbd> | Dock / float the viewer |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Queue the workflow (also from the undocked window) |
| <kbd>?</kbd> | Show the keys |

## In the spaces

Each space has keys of its own, active only on its tab:

- [Editor](editor.md#cutting): <kbd>A</kbd> <kbd>T</kbd> <kbd>B</kbd> modes, <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd>, <kbd>I</kbd> / <kbd>O</kbd>, <kbd>Ctrl</kbd>+<kbd>B</kbd>, <kbd>N</kbd> snapping…
- [Paint](paint.md#tools): one letter per tool, <kbd>Ctrl</kbd>+<kbd>Z</kbd>, <kbd>Ctrl</kbd>+<kbd>T</kbd>…
- [3D](3d.md#moving-around): <kbd>Q</kbd> <kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd>, <kbd>Alt</kbd>+drag, <kbd>Ctrl</kbd>+<kbd>Z</kbd>…
- [Dependencies](dependencies.md): <kbd>F</kbd> fits the graph

So <kbd>R</kbd> is scale on a 3D tab and the red channel on a picture.

## Changing them

Every action is a ComfyUI command:

1. **Settings ▸ Keybinding**, search for `Image Viewer`.
2. Double-click a row and press the new combo.

A combo you set yourself works anywhere in ComfyUI while the viewer is open. If another extension already owns a default key, the row shows no key but the key still works over the viewer; the browser console lists those keys at start.
