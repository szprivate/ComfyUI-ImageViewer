# Edit

[Home](../index.md)

Cuts films on a timeline, as an NLE does. A cut is an OpenTimelineIO file (`.otio`) and plays in its own tab before anything is rendered.

![A cut: the Source viewer and the timeline viewer above, the Edit timeline below](../images/edit.png)

## Opening a cut

- **Open Edit…** in the lower bar's Timeline menu.
- **Open cut…** (<kbd>Ctrl</kbd>+<kbd>O</kbd> on the timeline, or the folder button on its bar), or double-click a `.otio` in the file browser.
- A film with a `.otio` beside it lights the timeline button in the transport.

The space's panels show only on a cut's tab: **Edit** (the timeline), **Inspector** (the selection's numbers), **Effects** (transitions, titles, colours, sound effects) and **Mixer**.

## Tracks

| Track | Holds |
|---|---|
| V1 | The cut: shots one after another, with dissolves and gaps |
| V2 and up | Clips placed at a time, over what is under them. Titles go here |
| A1 | The music bed |
| Sound tracks | Sound clips placed at a time |

Each header has a switch, solo, lock and the Auto Track Selector. Shift + wheel makes tracks taller or lower.

## Adding clips

- Drag History thumbnails, file browser rows, desktop files or canvas nodes onto the timeline.
- **Add ▸ Files…** / **Selected canvas nodes** inserts at the playhead.
- Drop above the top track or below the bottom one for a new track.

## Cutting

| Mode | Key | An edge… | The body… |
|---|---|---|---|
| Selection | <kbd>A</kbd> | trims, leaving a gap | moves the clip over what is there |
| Trim | <kbd>T</kbd> | ripples | slips (upper half), slides (lower half) |
| Blade | <kbd>B</kbd> | | cuts where you click |
| Dynamic trim | <kbd>W</kbd> | <kbd>J</kbd> / <kbd>L</kbd> move the selected edit as if playing | |

The middle of a cut rolls it. <kbd>,</kbd> / <kbd>.</kbd> nudge a frame. <kbd>N</kbd> turns snapping on and off. In Trim mode the two frames beside the cut are shown over the picture.

| To | Do |
|---|---|
| Cut at the playhead | <kbd>Ctrl</kbd>+<kbd>B</kbd> |
| Delete with a gap / closing it | <kbd>Del</kbd> / <kbd>Shift</kbd>+<kbd>Del</kbd> (with an in and out and nothing selected: lift / extract the range) |
| Switch a clip off | <kbd>D</kbd> |
| Set in / out | <kbd>I</kbd> / <kbd>O</kbd>, <kbd>X</kbd> around a clip |
| Retime / loop | <kbd>Alt</kbd>+drag an edge / <kbd>Ctrl</kbd>+drag the out edge |
| Match frame / back | <kbd>F</kbd> / <kbd>Shift</kbd>+<kbd>F</kbd> |
| Marker | <kbd>M</kbd> (on a marker: name, colour, notes) |
| Swap with the neighbour | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>,</kbd> / <kbd>.</kbd> |
| Select forward | <kbd>Y</kbd> (<kbd>Alt</kbd>: all tracks) |
| Paste a clip's look | <kbd>Ctrl</kbd>+<kbd>C</kbd>, then <kbd>Alt</kbd>+<kbd>V</kbd> |
| Undo / redo | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> |

A clip's right-click menu also has freeze frame, reverse, compound clip, unlink / link sound, colours and takes. Press <kbd>?</kbd> on a cut's tab for every key.

## Source viewer and three-point editing

One monitor display, single or dual (the toggle at the top right of the right-hand viewer; <kbd>Q</kbd> swaps a single one). Click a History thumbnail, or drop a clip on the Source viewer, to load it. Mark its in and out, then:

| Edit | Key |
|---|---|
| Insert | <kbd>F9</kbd> |
| Overwrite | <kbd>F10</kbd> |
| Replace | <kbd>F11</kbd> |
| Place on top | <kbd>F12</kbd> |
| Ripple overwrite / fit to fill / append | <kbd>Shift</kbd>+<kbd>F10</kbd> / <kbd>F11</kbd> / <kbd>F12</kbd> |

The patch boxes at the left of the track headers say which tracks the source goes to.

## Look, titles, transitions

- **Inspector**: zoom, position, rotation, crop, opacity, volume and speed. The ◇ keys a row at the playhead; with several clips selected a change goes to all.
- **Titles** (Effects): drop one on a video track and type in the Inspector's Title tab.
- **Transitions** (Effects): cross dissolve, dip to black / white, wipe. Drop one on a cut.

## Sound

- The speaker on the bar mutes the cut (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>); <kbd>Shift</kbd>+<kbd>M</kbd> scrubs sound.
- A sound clip's volume line: drag it, <kbd>Alt</kbd>+click adds a point. The corner squares are fades. <kbd>Shift</kbd>+<kbd>T</kbd> crossfades at a cut.
- Sound effects (EQ, compressor, reverb …) from Effects onto a clip or a track header.
- **Mixer**: a strip per track and the master, with meter, fader, pan, mute and solo.

## Saving and exporting

| | |
|---|---|
| Save cut (<kbd>Ctrl</kbd>+<kbd>S</kbd>) / Save cut as… | Writes the `.otio`; the bar says where |
| Export film… | Renders picture and sound as the next version, never over the film the cut came from |
| Export to Resolve… | A folder with the media, FCPXML, EDL and OTIO for DaVinci Resolve |

## With agentY

**Auto edit…** (the wand menu) cuts on the beat, to a rhythm or to each shot's best part; **Detect cuts** finds cuts inside a film; **Ask agentY…** and a clip's **Recreate with changes…** hand the cut to the agent, whose new versions come back as takes.
