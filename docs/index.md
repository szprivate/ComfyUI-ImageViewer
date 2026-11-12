# ComfyUI Image Viewer

A panel for ComfyUI to look at what a workflow makes, compare it, cut it, paint on it, comp it and stage 3D shots, without leaving the graph.

![The Viewer with the History beside it](images/viewer.jpg)

## Getting started

1. Click **Image Viewer** in ComfyUI's top bar.
2. Wire an image, mask, video or 3D model into a **Send To Image Viewer** node.
3. Run the workflow. The result shows up in the Viewer.
4. Hover the panel and press <kbd>?</kbd> for the keys.

## Spaces

A space is a kind of tab: the Viewer for looking, and one per kind of document. Each space has a menu in the lower bar whose first entry opens it (**Open Edit…**, **Open Paint…** …): the open one, else the last file used there, else an empty one.

| Space | For |
|---|---|
| [Viewer](pages/viewer.md) | Pictures, videos and sounds: zoom, compare, play, exposure, channels, drawing tools |
| [Edit](pages/edit.md) | Cutting films on a timeline, with sound, titles and effects |
| [Paint](pages/paint.md) | A picture in layers, with AI fills |
| [3D](pages/3d.md) | Models, previz shots, rigs and animation, rendered back into the workflow |
| [Motion](pages/motion.md) | Motion graphics scenes an agent wrote |
| [Comp](pages/comp.md) | Pictures, films and sequences layered in a node graph |

## Panels

Panels sit beside the picture in any space. They can be docked, stacked as tabs and saved in layouts: see [Panels & workspace](pages/workspace.md).

| Panel | For |
|---|---|
| [History](pages/history.md) | Every render, in groups |
| [File browser](pages/workspace.md#file-browser) | ComfyUI's folders and the ones you allow |
| [Parameters](pages/workspace.md#parameters) | The selected node's widgets; the drawing tools' options; the 3D Channel Box |
| [Agent code](pages/agent-code.md) | The code an agent writes |
| [Dataset](pages/dataset.md) | A LoRA training dataset and its training |

Each space also brings its own panels (the Edit timeline, Paint's Layers, the 3D Outliner …); they are on that space's page.

## More

- [Dependencies](pages/dependencies.md): what a file was made from, and what was made from it
- [Working with agentY](pages/agentY.md): groups, tags, approvals, the chat panel
- [Nodes](pages/nodes.md): Send To Image Viewer, Roto, SAM3 Collector, 3D Scene
- [Hotkeys](pages/hotkeys.md): the keys, and how to change them
- [Reference](pages/reference.md): folders, environment variables, routes

Design notes: [Motion graphics format](pages/dev/motion-graphics-design.md) · [Dataset files and routes](pages/dev/lora-dataset-design.md) · [Worlds usage](pages/worlds/USAGE.md) · [Worlds plan](pages/worlds/PLAN.md)
