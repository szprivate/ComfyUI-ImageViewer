# Paint

[Home](index.md)

A small picture editor: layers, brushes, selections, masks, adjustment layers, text, and AI fills through agentY.

![A Paint tab: tools on the left, Layers and Properties on the right](images/paint.png)

## Opening a picture

- **Open Paint…** in the lower bar's Paint menu: the open canvas, else the last picture, else a new white 1920 × 1080 canvas.
- Right-click a History thumbnail ▸ **Edit in Paint**.
- Open an `.ora` or `.psd` from the file browser.

Its three panels, **Layers**, **Properties** and **History**, show only on a Paint tab. The row under the menus holds the current tool's options.

## Tools

| Key | Tool |
|---|---|
| <kbd>V</kbd> | Transform: move, scale, rotate, shear (<kbd>Ctrl</kbd>+<kbd>T</kbd>). <kbd>Enter</kbd> applies, <kbd>Esc</kbd> cancels |
| <kbd>M</kbd> / <kbd>Shift</kbd>+<kbd>M</kbd> | Rectangle / ellipse select |
| <kbd>L</kbd> | Lasso |
| <kbd>W</kbd> | Magic wand |
| <kbd>C</kbd> | Crop |
| <kbd>B</kbd> | Brush (reads pen pressure) |
| <kbd>S</kbd> | Clone stamp: <kbd>Alt</kbd>+click sets the source |
| <kbd>E</kbd> | Eraser |
| <kbd>G</kbd> | Paint bucket |
| <kbd>I</kbd> | Eyedropper |
| <kbd>T</kbd> | Text |
| <kbd>H</kbd> or hold <kbd>Space</kbd> | Hand |

<kbd>X</kbd> swaps the two colours, <kbd>D</kbd> resets them.

## Layers

- Pixel, text and **adjustment** layers (Levels, Curves, Brightness/Contrast, Exposure, Hue/Saturation, Grade, Invert, Threshold), with blend modes and opacity.
- **Masks**: white shows, black hides. Click the mask's thumbnail to paint on it.
- Double-click a name to rename. **Layer** menu: duplicate (<kbd>Ctrl</kbd>+<kbd>J</kbd>), merge down (<kbd>Ctrl</kbd>+<kbd>E</kbd>), flip, rotate, scale, lock.
- The **History** panel lists every step; click one to go back to it.

## Generate

The **Generate** menu: **Fill from the surroundings**, **Extend the canvas** and **Upscale** work right here. **Generative fill**, **Remove object**, **Remove background** and **Select subject** ask agentY and put its answer back as one undo step.

## Saving

| | |
|---|---|
| **Save** (<kbd>Ctrl</kbd>+<kbd>S</kbd>) | An `.ora` is saved over itself. A picture, a `.psd` or a new canvas is saved as the next version, never over the original |
| **Export…** | PNG, JPEG, WebP, TIFF or PSD. Adjustment layers are baked into a PSD |

`.ora` (OpenRaster) opens in Krita and GIMP too. agentY can edit an open picture as well; it waits while you have unsaved changes.
