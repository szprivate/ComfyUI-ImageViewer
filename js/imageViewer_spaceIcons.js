// imageViewer_spaceIcons.js
// The spaces' icons - Viewer, Edit, Paint, Motion, Comp, 3D - one family drawn for
// the viewer on Lucide's rules (24 grid, stroke 2, round caps and joins): a
// circle with one plain glyph inside, so a space never looks like a tool
// (Paint's Brush is Lucide's paintbrush, Edit's Split its scissors). The same
// icon stands on the space's tab and on its group in the lower bar.
//
// Fixed shapes only; nothing from the user goes into them.

const RING = '<circle cx="12" cy="12" r="10"/>';

export const SPACE_ICON_SHAPES = {
    // A picture: a mountain line (no sun - with one, it read as a face at 16 px).
    viewer: RING + '<path d="m6 15 3.5-4.5 3 3.5 2-2 3.5 3"/>',
    // Clips on two tracks with the playhead through them.
    edit: RING + '<path d="M12 6v12"/><path d="M6 10h3"/><path d="M15 10h3"/><path d="M6 14h3"/><path d="M15 14h1.5"/>',
    // A brush stroke.
    paint: RING + '<path d="M6.5 15c2-4.5 3.5.5 5-2.5s3-3.5 6-4.5"/>',
    // A ball with speed lines.
    motion: RING + '<circle cx="14" cy="12" r="3"/><path d="M5.5 12h3"/><path d="M6.5 8.5h2.5"/><path d="M6.5 15.5h2.5"/>',
    // Two nodes merging into one: a node graph.
    comp: RING + '<circle cx="8.5" cy="9" r="1.5"/><circle cx="15.5" cy="9" r="1.5"/><circle cx="12" cy="15.5" r="1.5"/>'
        + '<path d="m9.3 10.4 1.9 3.7"/><path d="m14.7 10.4-1.9 3.7"/>',
    // A cube.
    "3d": RING + '<path d="m12 6.5 5 2.75v5.5L12 17.5l-5-2.75v-5.5Z"/><path d="M12 12v5.5"/><path d="m7 9.25 5 2.75 5-2.75"/>',
};

/** The icon of a space as SVG markup, or "" for a kind that has none. */
export function spaceIconSvg(kind, size = 24) {
    const inner = SPACE_ICON_SHAPES[kind];
    if (!inner) return "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + inner + "</svg>";
}

// The emoji the spaces' tab labels have carried in front of the name. The
// labels keep them (they are saved, and agentY reads them); the tab draws the
// icon in their place.
const SPACE_EMOJI = ["\u{1F5BC}️", "\u{1F5BC}", "✂️", "✂", "\u{1F58C}️", "\u{1F58C}", "\u{1F3AC}", "\u{1F39E}\u{FE0F}", "\u{1F39E}", "\u{1F9CA}"];

/** A space tab's label without the emoji in front of it. */
export function stripSpaceEmoji(label) {
    const s = String(label == null ? "" : label);
    for (const e of SPACE_EMOJI) if (s.startsWith(e)) return s.slice(e.length).replace(/^\s+/, "");
    return s;
}
