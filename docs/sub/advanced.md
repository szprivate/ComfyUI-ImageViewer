# Advanced Features

Beyond basic image display, bEpic ImageViewer offers a file browser for external images, pop-out undocking for multi-monitor setups, named layout presets, and cache management.

← [Back to index](../index.md)

---

## File Browser

You can load any folder of images from your computer into the viewer — no ComfyUI workflow needed.

1. Click the **Open Folder** button in the playback toolbar (folder icon).
2. A native OS folder picker dialog opens. Navigate to the folder containing your images.
3. The viewer scans the folder for supported image types: `jpg`, `jpeg`, `png`, `webp`, `gif`, `bmp`, `tiff`, `avif`.
4. A new tab labelled `folder_<name>` is created containing all found images as a sequence.
5. Use the timeline and playback controls to browse the sequence.

### Path Bar Overlay

When viewing an externally loaded image, a **path bar** appears at the bottom of the viewport showing the file's path. Click it to expand and see the full path — useful when comparing many similarly-named files.

> [!TIP]
> Load a folder of renders from a previous session to compare them against a new generation — use tab comparison (<kbd>Shift</kbd>+click tabs) for a side-by-side diff.

---

## Undocking — Multi-Monitor Mode

Click the **Undock** button (detach icon, top-right of the viewer) to pop the viewer into its own dedicated browser window.

- All styles, CSS variables, and state are copied to the new window.
- Move the window to a second monitor for a full-screen image review experience.
- The button icon switches to a "dock" icon — click it in the popout to restore the viewer to the main panel.
- If you close the popout window manually, the viewer auto-restores to the main ComfyUI tab.
- Keyboard events in the popout are fully supported — all hotkeys work there too.

> [!NOTE]
> Some browsers block popups by default. If clicking Undock does nothing, check your browser's popup-blocker settings and allow popups from `localhost:8188` (or your ComfyUI address).

---

## Layout Presets

Layouts let you save and restore the viewer's panel configuration — position, size, panel visibility, and dock positions — with a single click.

### Saving a Layout

1. Arrange the viewer panels exactly as you want them.
2. Click the **Layouts** button in the toolbar (grid icon).
3. Choose *Save Layout* and give it a name.
4. The layout is stored in ComfyUI's user data directory as `bEpicViewer_layouts.json`.

### Applying a Layout

1. Click the **Layouts** button.
2. Select any saved layout from the dropdown list.
3. The viewer snaps to the saved configuration immediately.

### Factory Default

Designate one layout as the **Factory Default** — the configuration applied on first launch or after a reset. Click *Set as Factory Default* from the Layouts menu.

### Managing Layouts

The **Manage Panel** dialog (from the Layouts menu) lets you:

- **Rename** a layout.
- **Delete** a layout.
- View the saved configuration values.

---

## Cache Management

Every image received by bEpicSendToViewer nodes is saved as a temporary PNG in ComfyUI's `temp/` directory, prefixed with `bEpic_`. These accumulate over long sessions.

### Clearing the Cache

1. Click the **Clear Cache** button in the playback toolbar (trash icon).
2. A confirmation dialog appears — this is irreversible.
3. Confirm to delete all `bEpic_*` temp files and wipe all history thumbnails.
4. The viewer resets to an empty state (all tabs closed, history cleared).

> [!WARNING]
> Cache clearing removes the actual PNG files from disk. Always copy any images you want to keep using the right-click *Copy Image Path* option before clearing.

---

## Hotkey Help Overlay

Press the **?** button in the toolbar, or hover the viewer and press <kbd>?</kbd>, to display a full hotkey reference overlay directly inside the viewer. Click anywhere on the overlay to dismiss it.

See also: [Keyboard Shortcuts](hotkeys.md)

---

## Open in File Explorer

The extension integrates with the OS file explorer via the `/bepic/open_path` API endpoint. This lets you quickly reveal the raw output files for further processing outside ComfyUI.

---

← [Parameter Panel](params-panel.md) | Next: [Node Reference](nodes.md)
