# Playback Controls

The viewer treats every tab as a potential sequence. Use the timeline and playback controls to review image batches, frame-by-frame outputs, and folder-loaded sequences at any speed.

← [Back to index](../index.md)

---

![Viewer with playback toolbar](../screenshot_01.png)
*Viewer showing the playback toolbar at the bottom — transport buttons, timeline slider, FPS input, and loop mode selector.*

## Transport Buttons

| Button | Keyboard | Action |
|---|---|---|
| ⏮ Rewind | <kbd>Ctrl</kbd>+<kbd>←</kbd> | Jump to frame 1 |
| ◁ Step Back | <kbd>←</kbd> | Go back one frame |
| ▶ / ⏸ Play/Pause | <kbd>Space</kbd> | Start or stop playback |
| ▷ Step Forward | <kbd>→</kbd> | Advance one frame |
| ⏭ End | <kbd>Ctrl</kbd>+<kbd>→</kbd> | Jump to last frame |

> [!TIP]
> Keyboard shortcuts only activate when your mouse cursor is hovering over the viewer panel. Move your cursor inside the viewer before pressing keys.

---

## The Timeline

The timeline slider stretches across most of the playback toolbar. It shows major and minor tick marks as visual reference.

### Scrubbing

Click anywhere on the timeline to jump to that frame. Click and drag to scrub through frames interactively — the fastest way to review a long sequence.

### Selecting a Playback Sub-Range

Hold <kbd>Ctrl</kbd> while dragging on the timeline to define a sub-range. The selected region is highlighted in orange. Playback will loop only within this range.

```
[════════[▓▓▓▓▓▓▓▓▓▓▓]════════════]
         ↑ range start  ↑ range end
         Ctrl+drag to select
```

To clear the sub-range and return to full-sequence playback, <kbd>Ctrl</kbd>+click outside the selection.

---

## FPS Control

The **FPS** input box sets the playback speed (default: `25`). Click the number and type a new value, or scroll the mouse wheel over it.

| FPS | Use case |
|---|---|
| 1–4 | Very slow step-through for debugging individual frames |
| 12–15 | Anime / stop-motion style |
| 24–25 | Film / broadcast standard (default) |
| 60 | Smooth game-engine style preview |

---

## Loop Modes

| Mode | Behaviour |
|---|---|
| **Loop** | Wraps back to the first frame and continues playing. |
| **Ping-Pong** | Reverses direction at each end — plays forwards then backwards continuously. |
| **Once** | Stops at the last frame and pauses. |

---

## Working with Batches

When a bEpicSendToViewer node receives a batch of images (tensor shape `[N, H, W, 3]` where N > 1), all N frames are loaded into the tab automatically. The tensor shape overlay will read `[N, H, W, 3]` instead of `[1, H, W, 3] [Still Frame]`.

Use the timeline or <kbd>←</kbd>/<kbd>→</kbd> keys to step through individual batch frames, or press <kbd>Space</kbd> to play them as an animation.

## Frame Counter

A small frame counter on the timeline shows the current frame number and total frame count (e.g. `5 / 24`).

---

← [Image Comparison](comparison.md) | Next: [Channels & Exposure](channels-exposure.md)
