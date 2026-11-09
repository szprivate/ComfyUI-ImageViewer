# Editor

[Home](index.md)

The Editor cuts films on a timeline, the way an NLE does. A cut is an OpenTimelineIO file (`.otio`); it plays in its own tab before anything is rendered.

![A cut: the Edit panel below with a title on V2, three shots on V1 and music on A2, Effects on the left, the Inspector on the right](images/editor.png)

## Opening a cut

- **Open Edit…** in the lower bar's Timeline menu: the open cut, else the last one, else an empty one.
- On a film with a `.otio` beside it (agentY writes one), the timeline button lights up. Click it.
- **Open cut…** (<kbd>Ctrl</kbd>+<kbd>O</kbd>, or the folder button on the Edit bar), or double-click a `.otio` in the file browser.

Three panels belong to a cut and show only on its tab: **Edit** (the timeline), **Inspector** (the selected clip's numbers) and **Effects** (transitions, titles, colours, sound effects).

## Tracks

| Track | Holds |
|---|---|
| **V1** | The cut: one shot after another, with dissolves and gaps |
| **V2 and up** | Clips placed at a time. They cover what is under them, picture and sound. Titles live here |
| **A1** | The music bed under the whole film |
| **Sound tracks** | Sound clips placed at a time |

The film runs until the last picture or the last sound ends, whichever is later. Past the last picture it is black.

## Adding clips

- Drag files from the file browser, thumbnails from the History, or nodes off the canvas onto the timeline.
- **Add ▸ Files…** or **Add ▸ Selected canvas nodes** inserts at the playhead: the shot there is split and what follows moves on.
- Drag above the top video track or below the bottom sound track for a new track.

## Cutting

| Mode | Key | An edge… | The body… |
|---|---|---|---|
| **Select** | <kbd>A</kbd> | trims that edge, leaving a gap | moves the clip over what is there |
| **Trim** | <kbd>T</kbd> | ripples (what follows moves) | upper half slips, lower half slides |
| **Blade** | <kbd>B</kbd> | | cuts the clip where you click |

The middle of a cut rolls it in both modes. Double-click a cut (either side of it, its middle, or a dissolve) to go into the Trim mode with that edit selected: <kbd>,</kbd> / <kbd>.</kbd> then ripple or roll it a frame. <kbd>N</kbd> turns snapping on and off. While trimming, the two frames either side of the cut are shown over the picture.

| To | Do |
|---|---|
| Cut at the playhead | <kbd>Ctrl</kbd>+<kbd>B</kbd> |
| Delete, leaving a gap / closing it | <kbd>Del</kbd> / <kbd>Shift</kbd>+<kbd>Del</kbd> |
| Switch a clip off | <kbd>D</kbd> |
| Retime a clip | <kbd>Alt</kbd>+drag an edge |
| Loop a clip longer than its source | <kbd>Ctrl</kbd>+drag its out edge |
| Set in / out | <kbd>I</kbd> / <kbd>O</kbd>, or <kbd>X</kbd> around the clip |
| Copy a clip's look onto others | <kbd>Ctrl</kbd>+<kbd>C</kbd>, then <kbd>Alt</kbd>+<kbd>V</kbd> (Paste Attributes) |
| Undo / redo | <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> |

## Markers

Press <kbd>M</kbd> to put a marker at the playhead. With a clip selected and the playhead inside it, the marker goes on the clip and moves with its picture; otherwise it goes on the timeline (the ruler). Press <kbd>M</kbd> on a marker, or double-click it, to give it a name, a colour, notes and a duration. Drag a marker to move it, click it and press <kbd>Del</kbd> to remove it, or right-click it for colours and "delete all of this colour". <kbd>Alt</kbd>+<kbd>M</kbd> removes the markers at the playhead; <kbd>Shift</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> jump from marker to marker. Markers are saved in the cut, are snap targets, and go to Resolve with **Export to Resolve…**.

## The in-out range, swapping, selecting forward

- **Lift / extract**: with an in and out set (<kbd>I</kbd> / <kbd>O</kbd>) and nothing selected, <kbd>Del</kbd> takes what lies between them off every track whose Auto Track Selector is on and leaves a gap; <kbd>Shift</kbd>+<kbd>Del</kbd> also closes the gap, so everything after the out moves up. Both are on the ruler's right-click menu too. The music bed (A1) is left as it is.
- **Swap clips**: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>,</kbd> / <kbd>.</kbd> swaps the selected clip with the one before / after it on its track.
- **Select forward**: <kbd>Y</kbd> selects the clips from the playhead on, on the selected clip's track (else V1); <kbd>Alt</kbd>+<kbd>Y</kbd> on every track. <kbd>Shift</kbd>+<kbd>Y</kbd> / <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd> select the ones before it (in Resolve that is <kbd>Ctrl</kbd>+<kbd>Y</kbd>, which is Redo here).

**Transitions**: the Effects panel has Cross Dissolve, Dip to Black, Dip to White and Wipe. Drop one on a cut. Right-click a transition's bar to change its type, or select it to set its length, its dip colour or its wipe direction in the Inspector. The export renders them; Export to Resolve turns dips and wipes into cross dissolves.

**Dynamic trim** (<kbd>W</kbd>, or the ⟨…⟩ button on the bar): with it on, <kbd>J</kbd> / <kbd>L</kbd> move the selected cut backwards / forwards frame by frame, as if playing it, and <kbd>K</kbd> stops. Press <kbd>L</kbd> or <kbd>J</kbd> again for 2×, 4×, 8×. With a clip selected and no cut, the clip slips (Trim mode) or slides (Selection). A whole run is one undo step.

<kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> play backwards, stop and play. Press <kbd>?</kbd> on a cut's tab for every key.

**Proxy playback** (the lightning button on the Edit bar, on by default): films bigger than 720p, or with key frames far apart, play and scrub from a lighter 540p copy, and compressed sounds (MP3 and the like) from a WAV copy, which stays in step with the picture. The server makes each once, in the background; until it is ready the file itself plays. Exports always use the files themselves.

## Sound

- **Sound on / off**: the speaker on the Edit bar (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>). **Scrub sound**: the waveform button (<kbd>Shift</kbd>+<kbd>M</kbd>) plays the sound under the playhead as you drag. Neither changes the export.
- **Volume**: drag a sound clip's volume line. <kbd>Alt</kbd>+click adds a point.
- **Fades**: drag the small squares at a sound clip's top corners.
- **Crossfade**: <kbd>Shift</kbd>+<kbd>T</kbd> at a cut between two sound clips.
- **Sound effects**: drag one from Effects onto a sound clip.
- **A film's own sound**: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>L</kbd> unlinks it onto a sound track, and links it back.

## Look and titles

The **Inspector** has the selected clip's zoom, position, rotation, crop, opacity and volume. The ◇ next to a row keys it at the playhead, so anything there can be animated. With several clips selected, a change goes to all of them.

**Titles** come from Effects: drop one on the timeline and type the words in the Inspector's Title tab (font, size, colour, outline, shadow, box).

## Saving and exporting

| | |
|---|---|
| **Save cut** (<kbd>Ctrl</kbd>+<kbd>S</kbd>) | Writes the `.otio`. The bar says where it went |
| **Save cut as…** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>) | Another name or folder |
| **Export film…** | Renders the film, picture and sound. It never writes over the film the cut came from: it saves the next version |
| **Export to Resolve…** | A folder with the media, an FCPXML, an EDL and an OTIO, ready for DaVinci Resolve |

## With agentY

- **Auto edit…** cuts on the beat of a sound, to an even rhythm, to the rhythm of another film, or to each shot's best part. **Detect cuts** finds the cuts inside a film.
- **Ask agentY…** sends the saved cut and your note to agentY. Its answer opens as a cut you can take in.
- **Recreate with changes…** (a clip's right-click) asks agentY to make the selected shots again. The new versions come back as **takes** of the clip; switch between them from its right-click menu.
