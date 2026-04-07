# Channels & Exposure

The viewer's exposure and channel controls let you inspect image data the way a VFX artist would — adjusting brightness non-destructively and isolating individual colour channels to spot artefacts, clipping, or bias.

← [Back to index](../index.md)

---

![Exposure slider and channel selector](../screenshot_07.png)
*The exposure bar centred at the top of the viewport — slider, EV readout, and channel dropdown.*

## Exposure Control

The exposure slider ranges from **−4 EV** to **+4 EV** and adjusts display brightness using a CSS `brightness()` filter — the underlying image data is **never modified**.

### Using the Slider

Drag the slider knob or click on the track to set an EV value. The readout on the right updates in real time (e.g. `+1.5 EV`).

### Interactive E-Drag

Hold <kbd>E</kbd> while dragging the mouse **horizontally** anywhere over the viewer to scrub exposure interactively. Release <kbd>E</kbd> to lock the value in place.

### Resetting Exposure

**Right-click** the exposure control (slider or label) to instantly reset to **0.0 EV**.

---

## Channel Isolation

The channel selector dropdown (to the right of the EV readout) switches the viewport between to display only the Red - Green - Blue channels. 

---


← [Playback Controls](playback.md) | Next: [Parameter Panel](params-panel.md)
