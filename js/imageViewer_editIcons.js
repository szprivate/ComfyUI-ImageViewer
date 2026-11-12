// imageViewer_editIcons.js
// The icons of the Edit panel's bar: Lucide's, a fixed table of shapes built as
// SVG DOM (nothing from the user goes into them), at the bar's icon size (CSS: .edit-icon).
const P = (d) => ["path", { d }];
const C = (cx, cy, r) => ["circle", { cx, cy, r }];
const L = (x1, x2, y1, y2) => ["line", { x1, x2, y1, y2 }];

export const EDIT_ICONS = {
    // chevrons-left-right-ellipsis (dynamic trim, W)
    dynamic: [P("M12 12h.01"), P("M16 12h.01"), P("m17 7 5 5-5 5"), P("m7 7-5 5 5 5"), P("M8 12h.01")],
    // mouse-pointer-2
    select: [P("M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z")],
    // scissors-line-dashed
    blade: [P("M5.42 9.42 8 12"), C(4, 8, 2), P("m14 6-8.58 8.58"), C(4, 16, 2), P("M10.8 14.8 14 18"), P("M16 12h-2"), P("M22 12h-2")],
    // scissors
    split: [C(6, 6, 3), P("M8.12 8.12 12 12"), P("M20 4 8.12 15.88"), C(6, 18, 3), P("M14.8 14.8 20 20")],
    // margin-vertical
    trim: [["rect", { x: 9, y: 9, width: 6, height: 6, rx: 1 }], P("M3 21h18"), P("M3 3h18")],
    // magnet
    snap: [P("m12 15 4 4"), P("M2.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.029-6.029a1 1 0 1 1 3 3l-6.029 6.029a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.365-6.367A1 1 0 0 0 8.716 4.282z"), P("m5 8 4 4")],
    // audio-lines
    beats: [P("M2 10v3"), P("M6 6v11"), P("M10 3v18"), P("M14 8v7"), P("M18 5v13"), P("M22 10v3")],
    // zoom-out
    zoomOut: [C(11, 11, 8), L(21, 16.65, 21, 16.65), L(8, 14, 11, 11)],
    // zoom-in
    zoomIn: [C(11, 11, 8), L(21, 16.65, 21, 16.65), L(11, 11, 8, 14), L(8, 14, 11, 11)],
    // scan-search
    // volume-2
    volume: [P("M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"),
             P("M16 9a5 5 0 0 1 0 6"), P("M19.364 18.364a9 9 0 0 0 0-12.728")],
    // volume-x
    volumeOff: [P("M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"),
                L(22, 16, 9, 15), L(16, 22, 9, 15)],
    // zap: proxy playback
    proxy: [P("M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z")],
    // audio-waveform
    scrub: [P("M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2")],
    // The Inspector's title tools: bold, italic, underline, strikethrough, case-upper,
    // text-align-start / -center / -end / -justify, align-vertical-justify-start / -center / -end
    bold: [P("M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8")],
    italic: [L(19, 10, 4, 4), L(14, 5, 20, 20), L(15, 9, 4, 20)],
    underline: [P("M6 4v6a6 6 0 0 0 12 0V4"), L(4, 20, 20, 20)],
    strike: [P("M16 4H9a3 3 0 0 0-2.83 4"), P("M14 12a4 4 0 0 1 0 8H6"), L(4, 20, 12, 12)],
    caps: [P("m3 15 4-8 4 8"), P("M4 13h6"), P("M15 11h4.5a2 2 0 0 1 0 4H15V7h4a2 2 0 0 1 0 4")],
    alignLeft: [P("M21 5H3"), P("M15 12H3"), P("M17 19H3")],
    alignCenter: [P("M21 5H3"), P("M17 12H7"), P("M19 19H5")],
    alignRight: [P("M21 5H3"), P("M21 12H9"), P("M21 19H7")],
    alignJustify: [P("M3 5h18"), P("M3 12h18"), P("M3 19h18")],
    valignTop: [["rect", { x: 5, y: 16, width: 14, height: 6, rx: 2 }], ["rect", { x: 7, y: 6, width: 10, height: 6, rx: 2 }], P("M2 2h20")],
    valignMiddle: [["rect", { x: 5, y: 16, width: 14, height: 6, rx: 2 }], ["rect", { x: 7, y: 2, width: 10, height: 6, rx: 2 }], P("M2 12h20")],
    valignBottom: [["rect", { x: 5, y: 12, width: 14, height: 6, rx: 2 }], ["rect", { x: 7, y: 2, width: 10, height: 6, rx: 2 }], P("M2 22h20")],
    // lock
    lock: [["rect", { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }], P("M7 11V7a5 5 0 0 1 10 0v4")],
    // lock-open
    lockOpen: [["rect", { width: 18, height: 11, x: 3, y: 11, rx: 2, ry: 2 }], P("M7 11V7a5 5 0 0 1 9.9-1")],
    // square-dashed-mouse-pointer (the Auto Track Selector)
    autoSel: [P("M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"),
              P("M5 3a2 2 0 0 0-2 2"), P("M19 3a2 2 0 0 1 2 2"), P("M5 21a2 2 0 0 1-2-2"), P("M9 3h1"), P("M9 21h2"), P("M14 3h1"),
              P("M3 9v1"), P("M21 9v2"), P("M3 14v1")],
    // The sound effects of the Effects panel: sliders-vertical (EQ), fold-vertical (compressor), shield (limiter),
    // waves (reverb), repeat (delay), volume-2 (gain), move-horizontal (pan)
    afxEq: [P("M4 21v-7"), P("M4 10V3"), P("M12 21v-9"), P("M12 8V3"), P("M20 21v-5"), P("M20 12V3"), P("M2 14h4"), P("M10 8h4"), P("M18 16h4")],
    afxComp: [P("M12 22v-6"), P("M12 8V2"), P("M4 12H2"), P("M10 12H8"), P("M16 12h-2"), P("M22 12h-2"), P("m15 19-3-3-3 3"), P("m15 5-3 3-3-3")],
    afxLimit: [P("M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z")],
    afxReverb: [P("M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"),
                P("M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"),
                P("M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1")],
    afxDelay: [P("m17 2 4 4-4 4"), P("M3 11v-1a4 4 0 0 1 4-4h14"), P("m7 22-4-4 4-4"), P("M21 13v1a4 4 0 0 1-4 4H3")],
    afxGain: [P("M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"),
              P("M16 9a5 5 0 0 1 0 6"), P("M19.364 18.364a9 9 0 0 0 0-12.728")],
    afxPan: [P("m18 8 4 4-4 4"), P("M2 12h20"), P("m6 8-4 4 4 4")],
    // The Source viewer's edits (Resolve's insert / overwrite / replace ... buttons). Drawn for this bar in
    // Lucide's manner (24 grid, 2 px strokes): the piece is the block, the track the line under it; a FILLED
    // block lies over what is there, an outlined one goes in between.
    srcInsert: [P("M12 2v7"), P("m9 6 3 3 3-3"), ["rect", { x: 9, y: 13, width: 6, height: 8, rx: 1 }],
                P("M1 17h5"), P("m4 15-2 2 2 2"), P("M18 17h5"), P("m20 15 2 2-2 2")],
    srcOverwrite: [P("M12 2v7"), P("m9 6 3 3 3-3"), ["rect", { x: 8, y: 13, width: 8, height: 8, rx: 1, fill: "currentColor" }],
                   P("M2 17h6"), P("M16 17h6")],
    // lucide replace
    srcReplace: [P("M14 4a1 1 0 0 1 1-1"), P("M15 10a1 1 0 0 1-1-1"), P("M21 4a1 1 0 0 0-1-1"), P("M21 9a1 1 0 0 1-1 1"),
                 P("m3 7 3 3 3-3"), P("M6 10V5a2 2 0 0 1 2-2h2"), ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1 }]],
    srcPlace: [P("M12 1v6"), P("m9 4 3 3 3-3"), ["rect", { x: 7, y: 10, width: 10, height: 5, rx: 1, fill: "currentColor" }],
               P("M2 20h20")],
    srcRipple: [P("M8 2v7"), P("m5 6 3 3 3-3"), ["rect", { x: 4, y: 13, width: 8, height: 8, rx: 1, fill: "currentColor" }],
                P("M12 17h10"), P("m17 14-3 3 3 3")],
    srcFit: [["rect", { x: 2, y: 13, width: 20, height: 8, rx: 1 }], P("M6 17h12"), P("m8 15-2 2 2 2"), P("m16 15 2 2-2 2"),
             P("M12 2v7"), P("m9 6 3 3 3-3")],
    srcAppend: [P("M17 2v7"), P("m14 6 3 3 3-3"), ["rect", { x: 13, y: 13, width: 8, height: 8, rx: 1 }], P("M2 17h8"), P("M10 14v6")],
    // tv-minimal-play (the Source viewer), columns-2 (dual viewer), square (single viewer)
    srcViewer: [P("M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z"),
                P("M7 21h10"), ["rect", { width: 20, height: 14, x: 2, y: 3, rx: 2 }]],
    dualViewer: [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }], P("M12 3v18")],
    singleViewer: [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }]],
    // film (the timeline in a single viewer), x (put away)
    timelineView: [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }], P("M7 3v18"), P("M3 7.5h4"), P("M3 12h18"), P("M3 16.5h4"),
                   P("M17 3v18"), P("M17 7.5h4"), P("M17 16.5h4")],
    // wand-sparkles: the cut tools' menu (split, Auto edit, Detect cuts, undo / redo)
    wand: [P("m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"),
           P("m14 7 3 3"), P("M5 6v4"), P("M19 14v4"), P("M10 2v2"), P("M7 8H3"), P("M21 16h-4"), P("M11 3H9")],
    close: [P("M18 6 6 18"), P("m6 6 12 12")],
    fit: [P("M3 7V5a2 2 0 0 1 2-2h2"), P("M17 3h2a2 2 0 0 1 2 2v2"), P("M21 17v2a2 2 0 0 1-2 2h-2"), P("M7 21H5a2 2 0 0 1-2-2v-2"), C(12, 12, 3), P("m16 16-1.9-1.9")],
    // a frame with letterbox bars: the Viewer's framing mask (imageViewer_frameMasks.js)
    frameMask: [["rect", { width: 20, height: 16, x: 2, y: 4, rx: 2 }], P("M2 8.5h20"), P("M2 15.5h20")],
};

/** Put icon `name` on button `b`, in place of its text. */
export function setEditIcon(b, name) {
    const NS = "http://www.w3.org/2000/svg";
    const doc = b.ownerDocument;
    const svg = doc.createElementNS(NS, "svg");
    const attrs = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round",
                    "stroke-linejoin": "round", "aria-hidden": "true", class: "edit-icon" };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    for (const [tag, at] of EDIT_ICONS[name]) {
        const n = doc.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(at)) n.setAttribute(k, String(v));
        svg.append(n);
    }
    b.replaceChildren(svg);
    b.dataset.icon = name;
    b.classList.add("edit-iconbtn");
    if (b.title) b.setAttribute("aria-label", b.title.split(/[:(]/)[0].trim());
}
