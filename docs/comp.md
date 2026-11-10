# Comp

[Home](index.md)

Comp layers pictures, films and image sequences in a node graph, the way Nuke does: Merge, Transform, Grade and Blur, keyed over time, in linear float. A comp is a file (`*.comp.json`). It has nothing to do with ComfyUI's workflow: its nodes live in the comp, never on the canvas, and Run does not touch them.

![A comp: the picture, its Properties and Layers, and the Node Graph under it](images/comp.png)

## Opening

- **Open Comp…** in the lower bar's Comp menu: the open comp, else the last one, else a tab that offers **New comp** and **Open…**.
- **New comp** in the same menu: a new file in your shot's `comps` folder when the canvas names a sequence and shot, else in `output/imageviewer/comps/`. It starts as a black background going into an Output.
- Double-click a `*.comp.json` in the file browser, or let agentY show it.

## The node graph

The **Node Graph** panel is up when a comp opens. The picture runs from top to bottom: a node's inputs are on its top edge, its output at the bottom.

- **Tab** opens a list of nodes to add; type to narrow it. With a node selected, the new one goes in under it.
- Drag a node to move it. Drag on empty space to select several, or Alt-drag or middle-drag to pan. The wheel zooms.
- Drag from an output to an input to connect them. Drag a connected input away to take the wire off.
- **1** shows the selected node in the picture (a red mark on its left), **D** switches it off, **Del** deletes it (what read it reads its first input instead), **F** frames the whole graph.
- Drop History thumbnails or file browser rows on the graph to make Read nodes. A frame of a numbered sequence brings the whole sequence (`shot.####.exr`).

| Node | What it does |
|---|---|
| Read | A picture, a film or a numbered sequence. *Offset* slides it in time; *Colourspace* auto treats EXR and HDR as linear, everything else as sRGB; *Fit* lays a picture of another size into the comp |
| Constant | A colour over the whole frame |
| Merge | Lays A over B (or plus, multiply, screen, in, out, atop, mask, stencil, and the rest of Nuke's operations), with a mix and an optional mask input |
| Transform | Moves, rotates and scales about a centre |
| Grade | Black and white point, lift, gain, multiply, offset, gamma, saturation, mix |
| Blur | A Gaussian blur, its size in pixels of the comp |
| Output | What the comp renders |

## Properties

The selected node's values at the playhead. They work as in Motion: the stopwatch animates a value, and changing an animated value sets a key there. With nothing selected the panel holds the comp's size, frame rate and length.

## Layers

The **Layers** panel (Comp menu ▸ Layers) shows the same graph as a stack of layers. Each Merge on the main pipe is a layer, its A branch is the layer's picture, and what is at the top of the pipe is the background. Reorder, switch off, change the operation or the mix, or add footage or a solid on top: each one is a change to the graph, so the two views always agree. A branch with a Merge of its own shows as a group.

## The picture and time

The picture fills the canvas. **Proxy** draws it smaller while you work (it is always rendered full size), **A** shows the alpha, **Fit** fits it in the window. The viewer's own transport plays the comp; its fps box and last-frame number edit the comp's rate and length.

## In ComfyUI's bottom panel

ComfyUI's bottom panel (the strip under the canvas with the Terminal and the Logs) has a **Comp** tab. It shows the node graph of the comp the viewer is on, with play, step, the frame and a button that brings the viewer up. It is the same graph, moved there while the tab is open, so you can work on the comp beside your workflow. Drag the panel's edge up to give it room. **Show it here** in the viewer's Node Graph panel takes it back.

## Rendering

**Render…** opens the export dialog: PNG, EXR (linear half float) or TIFF frames, or an MP4, MOV (ProRes or H.264) or WebM film; all frames, the in-out range, or just this frame. It saves the comp first and renders it on the server at full size, by the same arithmetic as the preview. The result lands where every export goes (versioned, in the shot's folder when there is one), joins the History, and is put on the ComfyUI canvas as a loader node, ready to wire into a workflow.
