# Installation & Setup

Get bEpic ImageViewer running in ComfyUI in under two minutes using either ComfyUI Manager (recommended) or a manual clone.

← [Back to index](index.md)

---

## Requirements

| Requirement | Details |
|---|---|
| ComfyUI | Any recent build (the extension uses the standard custom-node API) |
| Python | 3.8+ (same as ComfyUI) |
| Browser | Chrome 90+, Edge 90+, Firefox 90+ (Web Components / Shadow DOM required) |
| Python packages | `torch`, `numpy`, `Pillow` — all standard ComfyUI dependencies |

## Method 1 — ComfyUI Manager (Recommended)

1. Open ComfyUI in your browser and click the **Manager** button in the top menu.
2. Go to **Install Custom Nodes** and search for `bEpic ImageViewer`.
3. Click **Install** and restart ComfyUI when prompted.
4. After restart, the **Toggle bEpic Image Viewer** button appears in the action bar.

## Method 2 — Manual Clone

1. Open a terminal and navigate to your ComfyUI `custom_nodes` folder:
   ```bash
   cd /path/to/ComfyUI/custom_nodes
   ```
2. Clone the repository:
   ```bash
   git clone https://github.com/szprivate/ComfyUI-ImageViewer.git
   ```
3. Install any Python dependencies (none beyond standard ComfyUI requirements):
   ```bash
   pip install -r ComfyUI-ImageViewer/requirements.txt
   ```
4. Restart ComfyUI.

> [!NOTE]
> The extension registers backend API routes automatically on startup via `viewer_api.py`. No manual configuration is required.

## Opening the Viewer

Once installed, the viewer panel is toggled from the ComfyUI action bar. Look for the **Toggle bEpic Image Viewer** button — clicking it shows or hides the floating panel.

The panel opens at a default position (top-right, 30 vw × 30 vh). You can resize it by dragging any of its eight edges or corners, and move it by dragging its title bar area.

## Your First Workflow

1. In the ComfyUI node editor, right-click and search for **bEpic Send To Image Viewer**. Add it to your canvas.
2. Connect the `IMAGE` output of any node (e.g. a VAE Decode) to the `input` pin of the bEpicSendToViewer node.
3. Optionally type a name in the `tab_name` field — this becomes the tab label in the viewer (e.g. `final_output`).
4. Click **Queue Prompt** (or press <kbd>Alt</kbd>+<kbd>Enter</kbd> while hovering the viewer). The image appears in a new tab immediately.

> [!TIP]
> You can add multiple bEpicSendToViewer nodes to the same workflow — each with a different `tab_name` — to monitor several stages of your pipeline simultaneously (e.g. `latent`, `upscale`, `final`).

## Verifying the Backend

The extension exposes a health-check endpoint. Navigate to:

```
http://127.0.0.1:8188/bepic/health
```

You should receive a `200 OK` response. If you get a 404, the extension did not load — check your ComfyUI console for import errors.

## Updating

If you installed via Manager, use the **Update Custom Nodes** option. For a manual install:

```bash
cd /path/to/ComfyUI/custom_nodes/ComfyUI-ImageViewer
git pull
```

Then restart ComfyUI.

---

Next: [Viewer Interface](interface.md)
