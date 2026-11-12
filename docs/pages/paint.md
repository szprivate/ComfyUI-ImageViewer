# Paint

[Home](../index.md)

A picture editor in layers: brushes, selections, masks, adjustment layers, text, filters, and AI fills from ready-made ComfyUI workflows.

![A Paint tab: tools on the left, the tool's options above, Layers and Properties on the right](../images/paint.png)

## Opening

- **Open Paint…** in the lower bar's Paint menu: the open canvas, else the last picture, else a white 1920 × 1080 canvas.
- Right-click a History thumbnail ▸ **Edit in Paint**, or open an `.ora` / `.psd` from the file browser.

Panels (Paint tab only): **Layers**, **History**, and as tabs of one place **Properties**, **Tool options**, **Effects** and **Generate**.

## Tools

| Key | Tool |
|---|---|
| <kbd>V</kbd> / <kbd>Shift</kbd>+<kbd>V</kbd> | Transform (<kbd>Ctrl</kbd>+<kbd>T</kbd>) / transform selection. <kbd>Enter</kbd> applies, <kbd>Esc</kbd> cancels |
| <kbd>M</kbd> <kbd>L</kbd> <kbd>W</kbd> | Rectangle / ellipse select, lasso, magic wand |
| <kbd>C</kbd> | Crop |
| <kbd>B</kbd> <kbd>E</kbd> | Brush (pen pressure, flow, tips), eraser |
| <kbd>S</kbd> | Clone stamp (<kbd>Alt</kbd>+click sets the source) |
| <kbd>J</kbd> / <kbd>Shift</kbd>+<kbd>J</kbd> | Spot healing, healing brush, patch |
| <kbd>G</kbd> / <kbd>Shift</kbd>+<kbd>G</kbd> | Bucket / gradient |
| <kbd>O</kbd> <kbd>R</kbd> <kbd>Shift</kbd>+<kbd>R</kbd> | Dodge, burn, sponge; smudge; blur brush |
| <kbd>U</kbd> | Shapes (rectangle, rounded, ellipse, polygon, line) |
| <kbd>P</kbd> <kbd>A</kbd> | Pen paths and the path tools |
| <kbd>I</kbd> <kbd>T</kbd> <kbd>H</kbd> | Eyedropper (drag for an average), text, hand (or hold <kbd>Space</kbd>) |

<kbd>X</kbd> swaps the colours, <kbd>D</kbd> resets them. Hold <kbd>B</kbd> and drag on the canvas to change a brush's size (sideways) and opacity (up and down; <kbd>Shift</kbd>: hardness). Tools of one kind share a toolbar place: right-click it for the others.

## Layers

- Pixel, text, group and **adjustment** layers (Levels, Curves, Brightness/Contrast, Exposure, Hue/Saturation, Grade, Invert, Threshold), with blend modes and opacity. Adjustment panels show a histogram.
- <kbd>Shift</kbd> / <kbd>Ctrl</kbd>+click picks several; <kbd>Ctrl</kbd>+<kbd>G</kbd> groups, <kbd>Ctrl</kbd>+<kbd>E</kbd> merges, <kbd>Ctrl</kbd>+<kbd>J</kbd> duplicates.
- <kbd>Alt</kbd>+click a layer clips it to the one under it. <kbd>Alt</kbd>+click an eye solos.
- **Masks**: click the thumbnail to paint on it; <kbd>\</kbd> shows it on the canvas. Drag a layer onto another's row to make it that layer's mask. **Quick Mask** (<kbd>Q</kbd>) paints the selection.
- **Layer styles** (shadow, glow, stroke, colour overlay), **smart filters** and **smart layers** (a placed picture that keeps its full resolution) stay editable.
- **Lock transparency** paints only where the layer already has pixels.

## Selecting, transforming, filtering

- **Select ▸** Expand, Contract, Smooth, Border, Colour range. Rulers (<kbd>Ctrl</kbd>+<kbd>R</kbd>), guides and snapping.
- **Layer ▸** Distort, Perspective, Warp. **Filter ▸ Liquify** (<kbd>Shift</kbd>+<kbd>Ctrl</kbd>+<kbd>X</kbd>).
- **Filter**: blurs, sharpen, noise, pixelate and the adjustments into the pixels, each with a live preview.
- <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd> work with other programs' clipboard too.

## Generate

The Generate panel and menu run a ready-made ComfyUI workflow on the selection and bring the result back as a new layer, one undo step:

| Action | Models |
|---|---|
| Generative fill, Remove object, Extend, Edit, Extend empty areas | FLUX Fill and Kontext, Qwen Image Edit, GPT Image, Nano Banana, Seedream and more, local or API |
| Remove background, Select foreground | BiRefNet, Bria, Recraft, the ComfyUI-RMBG models |
| Select objects | SAM 3.1, by words or the selection's box |
| Upscale | Upscale models, SeedVR2, Magnific, Crystal, Recraft, Topaz |

Only workflows whose nodes this ComfyUI has are offered. Missing model files are named, and downloaded from Hugging Face only after you say so. **Generate ▸ Workflows…** (or Settings ▸ ComfyUI Image Viewer ▸ Paint) picks a workflow per action, or takes your own.

## Saving

| | |
|---|---|
| Save (<kbd>Ctrl</kbd>+<kbd>S</kbd>) | An `.ora` over itself; a picture, `.psd` or new canvas as the next version |
| Save as… | A name, `.ora` or `.psd`, and a folder |
| Export… | PNG, JPEG, WebP, TIFF or PSD (adjustments baked) |

A new `.ora` / `.psd` joins the History. agentY can edit the open picture too, unsaved changes included.

Paint is a clean-room implementation: see the README.
