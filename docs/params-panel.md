# Parameter Panel

The parameter panel is a live mirror of any ComfyUI node you select on the canvas. Read values, tweak settings, and queue a new generation — all without leaving the viewer.

← [Back to index](index.md)

---

![Parameter panel on the right side](screenshot_03.png)
*The parameter panel (right column) showing the bEpic Send To Image Viewer node's widgets.*

## How It Works

The viewer monitors the ComfyUI canvas selection using `requestAnimationFrame`. When you click a node on the canvas, the parameter panel automatically populates with that node's widget values. No button click required.

If no node is selected on the canvas, the panel falls back to showing the source node of the active viewer tab (i.e. the bEpicSendToViewer node that generated the current image).

## Widget Types Displayed

| Widget type | Displayed as |
|---|---|
| Toggle / Boolean | Checkbox |
| Combo / Dropdown | Select dropdown |
| Number (INT / FLOAT) | Numeric input |
| String / Text | Single-line text input |
| Multiline string | Textarea |
| Connected inputs | Shown but greyed out / disabled |

> [!NOTE]
> Connected widget inputs (e.g. a seed wired from another node) are displayed as disabled fields — you can see the current value but cannot edit it directly in the viewer. To change a connected value, edit the source node instead.

## Editing Values

Click any editable field and type a new value. Changes take effect in the ComfyUI node immediately (the widget is updated live). On your next queue, the modified value is used.

> [!TIP]
> This is particularly powerful with the **seed** widget on a KSampler node — lock the param panel to the KSampler, iterate through history snapshots to find a result you like, then tweak its seed or steps directly in the panel without clicking around the canvas.

## Locking the Panel

By default the panel tracks whatever node is selected. Click the **padlock** icon in the panel's header to lock it to the currently displayed node. While locked:

- Selecting other nodes on the canvas will **not** update the panel.
- The padlock icon changes to a closed-lock indicator.
- Click the padlock again to unlock and resume tracking canvas selection.

## Docking the Panel

By default the parameter panel docks on the **right** side of the viewport. Click the **dock** button (arrows icon) to move it to the **left** side — useful if your canvas is on the right side of your screen.

## Resizing the Panel

Drag the panel's inner edge (the thin 10 px resize handle) to widen or narrow it.

## Multi-Node Selection

In ComfyUI, you can <kbd>Shift</kbd>+click multiple nodes to select them simultaneously. The parameter panel will display the widgets of **all selected nodes** stacked vertically — each group prefixed with the node's title. Handy for adjusting related settings across multiple nodes in one view.

## Queuing a New Prompt

After editing parameters in the panel, press <kbd>Alt</kbd>+<kbd>Enter</kbd> while hovering the viewer to queue a new prompt. This closes the loop:

```
Inspect → Tweak params in panel → Alt+Enter → Re-generate → Inspect
```

---

← [Channels & Exposure](channels-exposure.md) | Next: [Advanced Features](advanced.md)
