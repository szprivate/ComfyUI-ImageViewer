# Viewer

[Home](../index.md)

The **🖼 Viewer** tab displays stills, image sequences, video and audio. Anything that is only being looked at opens here; documents such as cuts or Paint canvases get their own tab in their space.

![The Viewer with the History panel](../images/viewer.jpg)

## Loading media

- **Send To Image Viewer** node: each run adds its output to the [History](history.md), in the group named by the node's `group` input.
- Right-click a node ▸ **Send to Image Viewer**. A loader node opens its file directly; any other node runs its branch first. With several nodes selected, all of them are sent.
- Double-click or drag files in the [file browser](workspace.md#file-browser), or drop them from the desktop.

A new render replaces the image on screen only while the newest History item is displayed. Otherwise it is added to the History and you stay where you are.

## Viewing

| Action | Input |
|---|---|
| Fit / zoom / pan | <kbd>F</kbd> / zoom menu / drag |
| Full screen | <kbd>Shift</kbd>+<kbd>F</kbd>, <kbd>Esc</kbd> to leave |
| Exposure (±4 EV) | Slider in the top bar, or hold <kbd>E</kbd> and drag; right-click resets |
| Single channel | <kbd>R</kbd> <kbd>G</kbd> <kbd>B</kbd>, press again for RGB |
| Input colourspace | OCIO menu at the end of the exposure bar |
| Hide overlays | <kbd>S</kbd> |
| Framing mask (16:9, 2.39:1, custom …) | <kbd>Shift</kbd>+<kbd>G</kbd>; the ▾ next to the button sets ratio and opacity |

Exposure, channel and colourspace only affect the display, never the file.

## Comparing

| Action | Input |
|---|---|
| Wipe between two items | <kbd>Shift</kbd>+click two thumbnails or tabs, drag the divider |
| Contact sheet (up to 16) | <kbd>Ctrl</kbd>+click the items in the History, then <kbd>C</kbd> |
| Cycle modes / exit | <kbd>C</kbd> |

Videos in a comparison play frame-locked. A second source of a different size is scaled to the first one's frame.

<p>
<img src="../images/compare-wipe.jpg" alt="Wipe between two renders" width="49%">
<img src="../images/contact-sheet.jpg" alt="Six renders on a contact sheet" width="49%">
</p>

## Playback

| Action | Input |
|---|---|
| Play / pause | <kbd>Space</kbd> |
| Step one frame | <kbd>←</kbd> <kbd>→</kbd> (<kbd>Ctrl</kbd>: first / last frame) |
| Loop a range | <kbd>Ctrl</kbd>+drag on the timeline |
| Drop the current frame onto the graph | <kbd>Shift</kbd>+drag the timeline onto the canvas (creates a Load Image node) |

Audio files show their waveform; click it to seek.

## Drawing tools

The toolbar at the top left of the image holds **Roto** (writes mattes to a Roto node), **SAM3 points / boxes** (writes prompts to a SAM3 Collector node) and **Annotate** (text, arrows, boxes and strokes, stored next to the file as `<name>.annotations.json`). Tool options appear in the Parameters panel. See [Nodes](nodes.md#roto-and-sam3-collector).
