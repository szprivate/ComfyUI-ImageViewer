# Paint

[Home](index.md)

A small picture editor: layers, brushes, selections, masks, adjustment layers, text, and AI fills through agentY.

![A Paint tab: tools on the left, the brush's options above, Layers, Properties and History on the right](images/paint.png)

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

- **Pick several**: <kbd>Shift</kbd>+click picks every row between, <kbd>Ctrl</kbd>+click adds or takes away one, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> picks them all. Opacity, blend mode, lock, the eye, delete, duplicate, drag and the Move tool then work on all of them. <kbd>Ctrl</kbd>+<kbd>E</kbd> merges them into one.
- **Groups**: <kbd>Ctrl</kbd>+<kbd>G</kbd> puts the picked layers into a group, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> takes them out again, and the folder button makes an empty one. The arrow folds a group. Drag a layer onto the middle of a group's row to put it inside. A group has its own opacity, mask and blend mode. **Pass Through** lets its layers mix with what is under the group as if they weren't grouped. Any other mode lays the group's layers together first, so an adjustment layer inside only changes the group. <kbd>Ctrl</kbd>+<kbd>E</kbd> on a group merges it into one layer. Groups are saved in `.ora` and `.psd` files and read back from them.
- **Clipping masks**: <kbd>Alt</kbd>+click a layer (or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>) to clip it to the layer under it, so it only shows where that layer is. Do the same again to release it. Clip an adjustment layer like this and it changes only that one layer. A clipped row is indented with an arrow, and the name of the layer it is clipped to is underlined.
- Pixel, text and **adjustment** layers (Levels, Curves, Brightness/Contrast, Exposure, Hue/Saturation, Grade, Invert, Threshold), with blend modes and opacity.
- **Masks**: white shows, black hides. Click the mask's thumbnail to paint on it; while the mask is picked, Fill, Delete and the bucket work on the mask too. <kbd>Alt</kbd>+click the mask's thumbnail to see the mask alone (<kbd>Esc</kbd> or another <kbd>Alt</kbd>+click goes back), <kbd>Shift</kbd>+click switches it off and on. <kbd>Ctrl</kbd>+click a thumbnail makes a selection from the layer's pixels or from its mask (with <kbd>Shift</kbd> it adds, with <kbd>Alt</kbd> it takes away). Properties has the mask's **Density** (how much the black hides) and **Feather** (a soft edge), which change nothing in the mask's pixels; a `.psd` gets them baked in.
- **Quick Mask** (<kbd>Q</kbd>, or the button under the tools): the selection is shown as a red tint and painted with the brush, eraser, bucket or Fill. Black takes away, white adds. <kbd>Q</kbd> again turns it back into a selection.
- Double-click a name to rename. **Layer** menu: duplicate (<kbd>Ctrl</kbd>+<kbd>J</kbd>), merge down (<kbd>Ctrl</kbd>+<kbd>E</kbd>), flip, rotate, scale, lock.
- The **History** panel lists every step; click one to go back to it.

## Filters

The **Filter** menu works on every picked pixel layer, and only inside the selection when there is one: Gaussian blur, Motion blur, Sharpen, Unsharp Mask, High Pass, Median (despeckle), Add Noise, Pixelate, and the adjustments baked into the pixels. Each one previews live on the picture while you change its numbers. **Cancel** undoes the preview, and **OK** keeps it as one undo step.

## Generate

The **Generate** menu: **Fill from the surroundings**, **Extend the canvas** and **Upscale** work right here. **Generative fill**, **Remove object**, **Remove background** and **Select subject** ask agentY and put its answer back as one undo step.

## Saving

| | |
|---|---|
| **Save** (<kbd>Ctrl</kbd>+<kbd>S</kbd>) | An `.ora` is saved over itself. A picture, a `.psd` or a new canvas is saved as the next version, never over the original |
| **Export…** | PNG, JPEG, WebP, TIFF or PSD. Adjustment layers are baked into a PSD |

`.ora` (OpenRaster) opens in Krita and GIMP too. agentY can edit an open picture as well; it waits while you have unsaved changes.
