# Node Reference

Complete specification for the custom nodes provided by bEpic ImageViewer.

← [Back to index](index.md)

---

## bEpic Send To Image Viewer

The primary node. Acts as a pass-through router — it accepts image or mask tensors from upstream nodes, converts them to PNG, and sends them to the viewer panel via WebSocket. The tensor data is **not modified**; the node is purely for display.

```
                 ┌─────────────────────────────┐
                 │  bEpic Send To Image Viewer  │
  IMAGE / MASK ──┤  input                       │  (no outputs)
  STRING      ──┤  tab_name                    │
                 └─────────────────────────────┘
                         OUTPUT_NODE
```

### Category

`image/bEpic`

### Inputs

| Input | Type | Required | Description |
|---|---|---|---|
| `input` | `IMAGE` or `MASK` | Yes | The image or mask tensor to display. Accepts standard ComfyUI tensors `[B, H, W, C]`. Batches (B > 1) are fully supported — all frames appear in the timeline. |
| `tab_name` | `STRING` | No (default `""`) | Custom label for the viewer tab. If left empty, the node's unique ID is used. Special characters are sanitised. Example: `vae_decode`, `upscaled`, `mask_out`. |
| `unique_id` | `UNIQUE_ID` | Hidden / automatic | Internal node identifier injected by ComfyUI. Used to route the image to the correct viewer tab and generate temp-file names. Not visible in the node UI. |

### Outputs

This node has **no outputs**. It is marked as an `OUTPUT_NODE` — ComfyUI treats it as a terminal node (like SaveImage) that produces a side effect rather than a tensor to pass forward.

### Behaviour

1. Receives the tensor from `input`. Detects the number of channels: 3-channel tensors are treated as RGB; single-channel tensors are treated as greyscale masks.
2. Converts each frame in the batch to a PNG and writes it to ComfyUI's `temp/` directory:
   ```
   bEpic_S_{unique_id}_{safe_label}_{frame_index}_{random_hex}.png
   ```
3. Sends a `bepic.viewer.update` WebSocket message containing the tab name, frame paths, and batch size to all connected browser clients.
4. The viewer panel receives the message and creates or updates the named tab with the new images.

### Tensor Shape Handling

| Tensor shape | Interpretation |
|---|---|
| `[B, H, W, 3]` | RGB image batch |
| `[B, H, W, 4]` | RGBA image batch (alpha preserved) |
| `[B, H, W, 1]` or `[B, H, W]` | Greyscale / mask |

### Example Usage

```
KSampler → VAE Decode → bEpic Send To Image Viewer   (tab_name: "final")

ControlNet Apply → bEpic Send To Image Viewer         (tab_name: "controlnet_hint")

MaskToImage      → bEpic Send To Image Viewer         (tab_name: "mask")
```

> [!TIP]
> Place bEpicSendToViewer nodes at multiple stages of your pipeline so you can switch between tabs in the viewer to compare intermediate and final outputs without disconnecting and reconnecting nodes.

---

## Backend API Endpoints

The extension registers the following HTTP routes on the ComfyUI server. These are used internally by the viewer frontend but can also be called directly.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/bepic/open_path` | Open a folder path in the OS file explorer |
| GET | `/bepic/raw_view?path=…` | Serve a bEpic temp PNG securely |
| GET | `/bepic/view_file?path=…` | Serve an external image file |
| GET | `/bepic/pick_folder` | Open a native folder picker dialog |
| GET | `/bepic/clear_cache` | Delete all `bEpic_*` temp files |
| GET | `/bepic/viewer` | Standalone viewer-only HTML page |
| GET | `/bepic/health` | Health check — returns 200 if running |

---

← [Advanced Features](advanced.md) | Next: [Keyboard Shortcuts](hotkeys.md)
