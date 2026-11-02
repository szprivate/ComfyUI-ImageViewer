// bEpicViewer_editIcons.js
// The icons of the Edit panel's bar: Lucide's, a fixed table of shapes built as
// SVG DOM (nothing from the user goes into them), at the bar's icon size (CSS: .edit-icon).
const P = (d) => ["path", { d }];
const C = (cx, cy, r) => ["circle", { cx, cy, r }];
const L = (x1, x2, y1, y2) => ["line", { x1, x2, y1, y2 }];

export const EDIT_ICONS = {
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
    fit: [P("M3 7V5a2 2 0 0 1 2-2h2"), P("M17 3h2a2 2 0 0 1 2 2v2"), P("M21 17v2a2 2 0 0 1-2 2h-2"), P("M7 21H5a2 2 0 0 1-2-2v-2"), C(12, 12, 3), P("m16 16-1.9-1.9")],
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
