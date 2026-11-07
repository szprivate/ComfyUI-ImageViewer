# ComfyUI Image Viewer

A viewer panel for ComfyUI: look at what your workflow makes, compare it, cut it, paint on it, and stage 3D shots, without leaving the graph.

![The Viewer: a picture on the canvas, the History beside it](images/viewer.png)

## Getting started

1. Click **Image Viewer** in ComfyUI's top bar to show or hide the panel.
2. Add a **Send To Image Viewer** node and wire an image, mask, video or 3D model into it.
3. Run the workflow. The result shows up in the Viewer.
4. Hover the panel and press <kbd>?</kbd> for the keys.

## Spaces

A space is a kind of tab: one for looking at things, and one for each kind of document. Open a space from its menu in the lower bar (**Open Edit…**, **Open Paint…**, **Open Motion…**, **Open 3D…**): you get the open one, else the last file you used there, else an empty one.

| Space | What it is for |
|---|---|
| [Viewer](viewer.md) | Look at pictures, videos and sounds: zoom, compare, play, exposure and channels |
| [Editor](editor.md) | Cut films on a timeline, with sound, titles and effects |
| [Paint](paint.md) | Edit a picture in layers |
| [3D & Previz](3d.md) | View models, build and animate a shot, render it back into the workflow |
| [Motion](motion.md) | Edit motion graphics an agent wrote |
| [Dependencies](dependencies.md) | What a file was made from, and what was made from it (with agentY) |

## Panels

Panels sit beside the picture and can be docked, stacked as tabs and stored in layouts: see [Panels & workspace](workspace.md). Most of them come from the **ComfyUI** menu in the lower bar.

| Panel | What it is for |
|---|---|
| [History](history.md) | Every render, kept in groups |
| [File browser](workspace.md#file-browser) | Open and drag files from ComfyUI's folders and the ones you allow |
| [Parameters](workspace.md#parameters) | The selected node's widgets, and the drawing tools' options |
| [Agent code](agent-code.md) | Read the code an agent writes |
| [Dataset](dataset.md) | Review a LoRA training dataset and watch the training |

Each space brings its own panels too: the Editor's Edit, Inspector and Effects, Paint's Layers, Properties and History, the 3D Outliner, Channel Box and Curve Editor.

## More

- [Working with agentY](agentY.md): tags, approvals, annotations, the chat panel
- [Nodes](nodes.md): Send To Image Viewer, Roto, SAM3 Collector, 3D Scene
- [Hotkeys](hotkeys.md): the viewer's keys and how to change them
- [Reference](reference.md): HTTP routes, folders, temp files, environment variables
