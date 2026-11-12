// imageViewer_outlinerIcons.js
// The 3D Outliner's icons: Lucide's (ISC licence), a fixed table of shapes built
// as SVG DOM - nothing from the user goes into them. CSS: .ol-icon.
const P = (d) => ["path", { d }];
const C = (cx, cy, r) => ["circle", { cx, cy, r }];
const R = (x, y, width, height, rx) => ["rect", { x, y, width, height, rx }];

export const OUTLINER_ICONS = {
    // box
    model: [P("M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"),
            P("m3.3 7 8.7 5 8.7-5"), P("M12 22V12")],
    // shapes
    primitive: [P("M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"),
                R(3, 14, 7, 7, 1), C(17.5, 17.5, 3.5)],
    // video
    camera: [P("m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"), R(2, 6, 14, 12, 2)],
    // image
    imageplane: [R(3, 3, 18, 18, 2), C(9, 9, 2), P("m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21")],
    // folder
    group: [P("M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z")],
    // locate-fixed
    control: [["line", { x1: 2, x2: 5, y1: 12, y2: 12 }], ["line", { x1: 19, x2: 22, y1: 12, y2: 12 }],
              ["line", { x1: 12, x2: 12, y1: 2, y2: 5 }], ["line", { x1: 12, x2: 12, y1: 19, y2: 22 }],
              C(12, 12, 7), C(12, 12, 3)],
    // lightbulb
    light: [P("M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"),
            P("M9 18h6"), P("M10 22h4")],
    // mountain
    world: [P("m8 3 4 8 5-5 5 15H2L8 3z")],
    // bone
    bones: [P("M17 10c.7-.7 1.69 0 2.5 0a2.5 2.5 0 1 0 0-5 .5.5 0 0 1-.5-.5 2.5 2.5 0 1 0-5 0c0 .81.7 1.8 0 2.5l-7 7c-.7.7-1.69 0-2.5 0a2.5 2.5 0 0 0 0 5c.28 0 .5.22.5.5a2.5 2.5 0 1 0 5 0c0-.81-.7-1.8 0-2.5Z")],
    // eye
    eye: [P("M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"), C(12, 12, 3)],
    // eye-off
    eyeOff: [P("M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"),
             P("M14.084 14.158a3 3 0 0 1-4.242-4.242"),
             P("M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"),
             P("m2 2 20 20")],
    // search
    search: [P("m21 21-4.34-4.34"), C(11, 11, 8)],
    // funnel
    filter: [P("M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z")],
    // chevron-right
    chevron: [P("m9 18 6-6-6-6")],
    // x
    clear: [P("M18 6 6 18"), P("m6 6 12 12")],
    // scan-eye (look through a camera)
    look: [P("M3 7V5a2 2 0 0 1 2-2h2"), P("M17 3h2a2 2 0 0 1 2 2v2"), P("M21 17v2a2 2 0 0 1-2 2h-2"),
           P("M7 21H5a2 2 0 0 1-2-2v-2"), C(12, 12, 1),
           P("M18.944 12.33a1 1 0 0 0 0-.66 7.5 7.5 0 0 0-13.888 0 1 1 0 0 0 0 .66 7.5 7.5 0 0 0 13.888 0")],
    // chevrons-down-up / chevrons-up-down (fold / unfold all)
    foldAll: [P("m7 20 5-5 5 5"), P("m7 4 5 5 5-5")],
    unfoldAll: [P("m7 15 5 5 5-5"), P("m7 9 5-5 5 5")],
};

/** An <svg> of the named icon, from `doc`. */
export function outlinerIcon(doc, name, cls = "") {
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    const attrs = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round",
                    "stroke-linejoin": "round", "aria-hidden": "true", class: `ol-icon${cls ? " " + cls : ""}` };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    for (const [tag, at] of OUTLINER_ICONS[name] || OUTLINER_ICONS.model) {
        const n = doc.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(at)) n.setAttribute(k, String(v));
        svg.append(n);
    }
    return svg;
}
