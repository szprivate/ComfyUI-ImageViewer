# Dependencies

[Home](../index.md)

Shows a file's provenance as a graph: inputs above, files derived from it below. Open it with right-click on a History thumbnail ▸ **Show dependencies**.

![The Dependencies tab of a lookdev frame, with prompts and the renders made from it](../images/dependencies-tab.jpg)

The Send To Image Viewer node and agentY record the inputs of every file they write. For files from other save nodes that embed the workflow (Save Image, Save Video, VHS Video Combine), the graph is reconstructed the first time the file is opened. Everything runs inside ComfyUI; agentY is not required.

- Each node is a file. Stills have a green frame, videos a blue one; the caption names the model used (hover for the full list). Files without an embedded graph show what their C2PA manifest or download metadata reports.
- Prompts are shown above the files they produced, with a **Copy** button. A file built from an older version of its input is flagged **out of date**.

| Action | Input |
|---|---|
| Open / centre a file | Click / double-click |
| Create a loader node on the canvas | Right-click ▸ **Drop into canvas** |
| Load the workflow that produced it | Right-click ▸ **Open its workflow** |
| Select several | Drag a box; <kbd>Ctrl</kbd>+click toggles |
| Pan / fit | Middle drag or <kbd>Space</kbd>+drag / <kbd>F</kbd> |
| Pick up files written before recording started | **Look in folder** |

The records are small JSON files in an `agent_metadata` folder next to the media; agentY reads the same files.
