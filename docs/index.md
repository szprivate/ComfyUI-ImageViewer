# ComfyUI Image Viewer

A viewer panel for ComfyUI. It shows what a workflow produces and adds the tools to work with the results directly: a comparison viewer, an OTIO timeline, a layer-based paint editor, a node compositor and a 3D scene for previz, all inside the ComfyUI page.

![The Viewer with the History panel and the file browser](images/viewer.jpg)

## Getting started

1. Click **Image Viewer** in ComfyUI's top bar.
2. Connect an image, mask, video or 3D model to a **Send To Image Viewer** node.
3. Queue the workflow. The result appears in the Viewer.
4. Hover the panel and press <kbd>?</kbd> to list the hotkeys.

## Spaces

Each tab of the viewer belongs to a space. The Viewer space is for looking at media; every other space edits one kind of document. The lower bar has a menu per space, and its first entry (**Open Edit…**, **Open Paint…** and so on) brings up the open document, otherwise the last one you used, otherwise a new one.

| Space | Document | Used for |
|---|---|---|
| [Viewer](pages/viewer.md) | – | Stills, sequences, video and audio: zoom, wipe and contact-sheet compare, exposure, OCIO input, roto / SAM3 / annotation |
| [Edit](pages/edit.md) | `.otio` | Editing on a multi-track timeline with sound, titles and effects |
| [Paint](pages/paint.md) | `.ora`, `.psd` | Layered image editing with masks, adjustment layers and generative fills |
| [3D](pages/3d.md) | scene `.json` | Models, cameras, lights, rigs and animation; renders back into the workflow |
| [Motion](pages/motion.md) | `.mgscene.json` | Motion graphics scenes written by an agent |
| [Comp](pages/comp.md) | `.comp.json` | Node-based compositing in linear float |

## Panels

Panels are independent of the space. They dock to the left, right or bottom rail, stack as tabs and are saved with a layout ([Panels & workspace](pages/workspace.md)).

| Panel | Shows |
|---|---|
| [History](pages/history.md) | Every render, sorted into groups |
| [File browser](pages/workspace.md#file-browser) | ComfyUI's input / output / temp folders and any folder you allow |
| [Parameters](pages/workspace.md#parameters) | The widgets of the selected node, the active tool's options, or the 3D Channel Box |
| [Agent code](pages/agent-code.md) | Code produced by agentY |
| [Dataset](pages/dataset.md) | A LoRA training set and its training run |

Space-specific panels (the Edit timeline, Paint's Layers, the 3D Outliner and so on) are described on the page of their space.

## Further pages

- [Dependencies](pages/dependencies.md): the graph of what a file was made from and what was made from it
- [Working with agentY](pages/agentY.md): groups, tags, approvals and the chat panel
- [Nodes](pages/nodes.md): Send To Image Viewer, Roto, SAM3 Collector, 3D Scene
- [Hotkeys](pages/hotkeys.md): default keys and how to rebind them
- [Reference](pages/reference.md): allowed folders, environment variables, HTTP routes

Design notes: [Motion graphics format](pages/dev/motion-graphics-design.md) · [Dataset files and routes](pages/dev/lora-dataset-design.md) · [Worlds usage](pages/worlds/USAGE.md) · [Worlds plan](pages/worlds/PLAN.md)
