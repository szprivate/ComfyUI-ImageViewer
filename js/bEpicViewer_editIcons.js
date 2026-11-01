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
