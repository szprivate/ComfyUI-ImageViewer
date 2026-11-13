# Panels & workspace

[Home](../index.md)

## The viewer window

- **Image Viewer** in ComfyUI's top bar shows or hides the viewer.
- **Floating**: drag the tab bar to move it, the edges to resize.
- **Docked** (<kbd>Shift</kbd>+<kbd>D</kbd>): attached to the left, right or bottom of the ComfyUI page; the canvas shrinks to make room.
- **Undocked**: opens in a separate browser window or tab, e.g. for a second monitor. All hotkeys work there.

## Panels

Panels sit in three rails: left, right and bottom.

- Drag a panel by its title bar onto a rail edge, above or below another panel, or onto the middle of a panel to stack both as tabs.
- The button left of the panel name switches what that slot shows.
- The buttons next to **✕** collapse the panel to its title bar or maximise it over the viewer.
- The **layout** menu saves the current arrangement under a name and can set it as default.

The lower bar holds the transport and one menu per area: **ComfyUI** (History, Parameters, Agent code, Dataset, agentY), **3D**, **Motion**, **Paint**, **Comp** and **Timeline**.

## File browser

<img src="../images/file-browser.png" alt="The file browser on a project folder with a preview" width="300" align="right">

Opened with the folder button in the lower bar.

- **Filter** accepts wildcards (`*.exr`, `hero_??.png`) and persists while you change folders; **Kind** limits the list to images, video, audio, 3D and so on.
- Double-click opens a file. Rows can be dragged onto the picture, the canvas (creates a loader node), a cut or the agentY chat.
- Numbered images are folded into one sequence.

Accessible folders are ComfyUI's input, output and temp folders plus those added under **Settings ▸ ComfyUI Image Viewer ▸ Folders** (see [Reference](reference.md#folders)).

## Parameters

Shows the widgets of the node selected on the canvas; the padlock pins it to one node. While a drawing tool is active it shows the tool's options instead, on a 3D tab the Channel Box, and on a Comp tab the selected comp nodes.

## Settings

**Settings ▸ ComfyUI Image Viewer** holds the allowed folders and the defaults for playback, compare, History, annotation, 3D and docking. Settings are stored per OS user (`~/.comfyui_image_viewer/settings.json`), so they carry over between ComfyUI installs. **Colours** offers presets (by default the viewer follows ComfyUI's palette) and every individual colour. Hotkeys are under **Settings ▸ Keybinding** ([Hotkeys](hotkeys.md)).
