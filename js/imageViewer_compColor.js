// Comp's ColorCorrect, laid out as a colour corrector is (After Effects' Color Finesse rather than Nuke's
// ColorCorrect): the primaries per luma range - Master, Shadows, Midtones, Highlights - as HSL (hue,
// saturation, brightness, contrast), RGB (gain, gamma, pedestal, each for all channels and for red, green,
// blue), and hue offsets (a colour wheel per range); the luma ranges themselves; two secondaries, each a
// colour qualified by hue, saturation and luma and corrected on its own; a mix and views of every matte.
//
// Pure, imports nothing. Its numpy twin is `color_correct_image` in src/comp_model.py: the same operations in
// the same order (no `**`, explicit products) - change one, change the other (tests/test_comp_parity.py).

export const CC_RANGES = ["master", "shadows", "midtones", "highlights"];
export const CC_SECONDARIES = ["secA", "secB"];
export const CC_VIEWS = ["result", "shadows", "midtones", "highlights", "secondary A", "secondary B"];
const LUM = [0.2126, 0.7152, 0.0722];
const CH = ["", "_r", "_g", "_b"];

/** The node's parameters, in the order the panel shows them: { name: spec } with `tab` and `range` for the editor. */
export function ccParams() {
    const P = {};
    for (const R of CC_RANGES) {
        const add = (name, spec) => { P[`${R}_${name}`] = { ...spec, key: true, range: R }; };
        add("hue", { kind: "num", def: 0, step: 1, tab: "hsl", label: "Hue", help: "Turns every colour round the colour wheel, in degrees" });
        add("saturation", { kind: "num", def: 100, min: 0, step: 1, tab: "hsl", label: "Saturation", help: "100 as it is, 0 grey" });
        add("brightness", { kind: "num", def: 0, step: 0.01, tab: "hsl", label: "Brightness", help: "Added to every channel" });
        add("contrast", { kind: "num", def: 100, min: 0, step: 1, tab: "hsl", label: "Contrast", help: "100 as it is: about the contrast centre" });
        for (const [name, def, min, label] of [["gain", 1, undefined, "Gain"], ["gamma", 1, 0.01, "Gamma"], ["pedestal", 0, undefined, "Pedestal"]]) {
            CH.forEach((c, k) => add(name + c, { kind: "num", def, min, step: 0.01, tab: "rgb", label: k ? `${label} ${"RGB"[k - 1]}` : label,
                help: { gain: "Multiplies", gamma: "Above 1 lighter in the middle", pedestal: "Added before the gamma" }[name] }));
        }
        add("tint_hue", { kind: "num", def: 0, step: 1, tab: "offsets", label: "Offset hue", help: "Which way the wheel pushes, in degrees (0 red, 120 green, 240 blue)" });
        add("tint", { kind: "num", def: 0, min: 0, max: 100, step: 1, tab: "offsets", label: "Offset", help: "How far the wheel pushes" });
        for (const k of Object.keys(P)) if (P[k].min === undefined) delete P[k].min;
    }
    P.contrast_centre = { kind: "num", def: 0.18, min: 0.001, key: true, step: 0.01, tab: "hsl", range: "master", label: "Contrast centre", help: "The value contrast turns about (linear; 0.18 is middle grey)" };
    P.shadow_end = { kind: "num", def: 0.5, min: 0.01, max: 1, key: true, step: 0.01, tab: "luma", label: "Shadows end", help: "Where the shadows have faded out (luma as shown, 0..1)" };
    P.highlight_start = { kind: "num", def: 0.5, min: 0, max: 0.99, key: true, step: 0.01, tab: "luma", label: "Highlights start", help: "Where the highlights begin to fade in" };
    for (const [S, name] of [["secA", "A"], ["secB", "B"]]) {
        const add = (n, spec) => { P[`${S}_${n}`] = { ...spec, tab: "secondary", range: S }; };
        add("on", { kind: "enum", def: "off", choices: ["off", "on"], label: `Secondary ${name}` });
        add("color", { kind: "color", def: S === "secA" ? [0.6, 0.12, 0.05, 1] : [0.05, 0.25, 0.6, 1], label: "Colour", help: "The colour it corrects (⌖ takes it from the picture)" });
        add("hue_tol", { kind: "num", def: 15, min: 0, max: 180, key: true, step: 1, label: "Hue tolerance", help: "Degrees either side taken whole" });
        add("hue_soft", { kind: "num", def: 20, min: 0, max: 180, key: true, step: 1, label: "Hue softness", help: "Degrees further over which it fades" });
        add("sat_tol", { kind: "num", def: 0.3, min: 0, max: 1, key: true, step: 0.01, label: "Saturation tolerance" });
        add("lum_tol", { kind: "num", def: 0.4, min: 0, max: 1, key: true, step: 0.01, label: "Luma tolerance" });
        add("soft", { kind: "num", def: 0.15, min: 0, max: 1, key: true, step: 0.01, label: "Softness", help: "Of the saturation and luma tolerances" });
        add("hue", { kind: "num", def: 0, key: true, step: 1, label: "Hue", help: "Turns the qualified colour, in degrees" });
        add("saturation", { kind: "num", def: 100, min: 0, key: true, step: 1, label: "Saturation" });
        add("brightness", { kind: "num", def: 0, key: true, step: 0.01, label: "Brightness" });
    }
    P.mix = { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.01, tab: "general", label: "Mix" };
    P.view = { kind: "enum", def: "result", choices: CC_VIEWS, tab: "general", label: "View", help: "Shows a luma range or a secondary's matte as grey" };
    return P;
}

function smooth(e0, e1, x) {
    if (!(e1 > e0)) return x < e0 ? 0 : 1;
    let t = (x - e0) / (e1 - e0);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return t * t * (3 - 2 * t);
}
const lumaOf = (r, g, b) => { const l = LUM[0] * r + LUM[1] * g + LUM[2] * b; return l > 0 ? Math.pow(l, 1 / 2.2) : 0; };
/** HSV's hue (degrees) and saturation of a colour (linear numbers taken as they are). */
function hueSat(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    let h = 0;
    if (c > 0) {
        if (mx === r) h = 60 * ((g - b) / c);
        else if (mx === g) h = 60 * ((b - r) / c + 2);
        else h = 60 * ((r - g) / c + 4);
        if (h < 0) h += 360;
    }
    return [h, mx > 0 ? c / mx : 0];
}
/** The luma ranges' weights at luma Y: [shadows, midtones, highlights], adding up to 1. */
export function rangeWeights(Y, se, hs) {
    let ws = 1 - smooth(0, se, Y), wh = smooth(hs, 1, Y);
    let wm = 1 - ws - wh;
    if (wm < 0) wm = 0;
    const sum = ws + wm + wh;
    return [ws / sum, wm / sum, wh / sum];
}
const hueTurn = (deg) => { const th = (deg * Math.PI) / 180, co = Math.cos(th), si = Math.sin(th); return [co + (1 - co) / 3, (1 - co) / 3 - si / Math.sqrt(3), (1 - co) / 3 + si / Math.sqrt(3)]; };
const tintOf = (deg, amount) => {
    const a = (deg * Math.PI) / 180;
    const v = [Math.cos(a), Math.cos(a - (2 * Math.PI) / 3), Math.cos(a + (2 * Math.PI) / 3)];
    const l = LUM[0] * v[0] + LUM[1] * v[1] + LUM[2] * v[2];
    return v.map((x) => (amount / 100) * (x - l));
};

export function colorCorrectImage(img, p) {
    const w = img.w, h = img.h, s = img.data, out = { w, h, data: new Float32Array(w * h * 4) }, o = out.data;
    const v = (R, n) => p[`${R}_${n}`];
    const hue = CC_RANGES.map((R) => v(R, "hue")), sat = CC_RANGES.map((R) => v(R, "saturation") / 100);
    const bri = CC_RANGES.map((R) => v(R, "brightness")), con = CC_RANGES.map((R) => v(R, "contrast") / 100);
    const gain = [1, 2, 3].map((k) => CC_RANGES.map((R) => v(R, "gain") * v(R, "gain" + CH[k])));
    const gam = [1, 2, 3].map((k) => CC_RANGES.map((R) => v(R, "gamma") * v(R, "gamma" + CH[k])));
    const ped = [1, 2, 3].map((k) => CC_RANGES.map((R) => v(R, "pedestal") + v(R, "pedestal" + CH[k])));
    const tint = CC_RANGES.map((R) => tintOf(v(R, "tint_hue"), v(R, "tint")));
    const cc = p.contrast_centre, se = p.shadow_end, hs = p.highlight_start, mix = p.mix, view = p.view || "result";
    const secs = CC_SECONDARIES.filter((X) => p[`${X}_on`] === "on").map((X) => {
        const k = p[`${X}_color`] || [0, 0, 0, 1], [kh, ks] = hueSat(k[0], k[1], k[2]);
        return { X, kh, ks, kY: lumaOf(k[0], k[1], k[2]), ht: p[`${X}_hue_tol`], hsft: p[`${X}_hue_soft`], st: p[`${X}_sat_tol`], lt: p[`${X}_lum_tol`],
            soft: p[`${X}_soft`], turn: hueTurn(p[`${X}_hue`]), sat: p[`${X}_saturation`] / 100, bri: p[`${X}_brightness`] };
    });
    // Worked once instead of per pixel where the ranges leave them alone (the same numbers either way): the
    // hue turn when only the master turns, and powers of exactly 1.
    const hueFixed = hue[1] === 0 && hue[2] === 0 && hue[3] === 0 ? hueTurn(hue[0] + 0) : null;
    const conOne = con[0] === 1 && con[1] === 1 && con[2] === 1 && con[3] === 1;
    for (let i = 0; i < w * h * 4; i += 4) {
        const a = s[i + 3];
        if (a <= 0) { o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; o[i + 3] = a; continue; }
        const r0 = s[i] / a, g0 = s[i + 1] / a, b0 = s[i + 2] / a;
        let r = r0, g = g0, b = b0;
        const [ws, wm, wh] = rangeWeights(lumaOf(r, g, b), se, hs);
        // HSL
        const hu = hue[0] + (ws * hue[1] + wm * hue[2] + wh * hue[3]);
        const [t0, t1, t2] = hueFixed || hueTurn(hu);
        let nr = t0 * r + t1 * g + t2 * b, ng = t2 * r + t0 * g + t1 * b, nb = t1 * r + t2 * g + t0 * b;
        r = nr; g = ng; b = nb;
        const sa = sat[0] * (ws * sat[1] + wm * sat[2] + wh * sat[3]);
        const l = LUM[0] * r + LUM[1] * g + LUM[2] * b;
        r = l + (r - l) * sa; g = l + (g - l) * sa; b = l + (b - l) * sa;
        const br = bri[0] + (ws * bri[1] + wm * bri[2] + wh * bri[3]);
        r = r + br; g = g + br; b = b + br;
        const ct = con[0] * (ws * con[1] + wm * con[2] + wh * con[3]);
        if (conOne && ct === 1) { /* x^1: the number as it is */ } else {
        if (r > 0) r = cc * Math.pow(r / cc, ct);
        if (g > 0) g = cc * Math.pow(g / cc, ct);
        if (b > 0) b = cc * Math.pow(b / cc, ct);
        }
        // hue offsets: master, midtones and highlights tint as a balance, shadows as a lift
        const c = [r, g, b];
        for (let k = 0; k < 3; k++) {
            const mul = 1 + (tint[0][k] + (wm * tint[2][k] + wh * tint[3][k]));
            c[k] = c[k] * mul + ws * tint[1][k] * 0.1;
        }
        // RGB
        for (let k = 0; k < 3; k++) {
            const G = gain[k], Ga = gam[k], Pe = ped[k];
            const gk = G[0] * (ws * G[1] + wm * G[2] + wh * G[3]);
            const ak = Ga[0] * (ws * Ga[1] + wm * Ga[2] + wh * Ga[3]);
            const pk = Pe[0] + (ws * Pe[1] + wm * Pe[2] + wh * Pe[3]);
            let x = c[k] * gk + pk;
            if (x > 0 && ak !== 1) x = Math.pow(x, 1 / ak);
            c[k] = x;
        }
        // secondaries
        let qA = 0, qB = 0;
        for (const q of secs) {
            const [ph, ps] = hueSat(c[0], c[1], c[2]);
            let dh = Math.abs(ph - q.kh);
            if (dh > 180) dh = 360 - dh;
            const m = (1 - smooth(q.ht, q.ht + q.hsft, dh)) * (1 - smooth(q.st, q.st + q.soft, Math.abs(ps - q.ks)))
                * (1 - smooth(q.lt, q.lt + q.soft, Math.abs(lumaOf(c[0], c[1], c[2]) - q.kY)));
            if (q.X === "secA") qA = m; else qB = m;
            if (m <= 0) continue;
            const [u0, u1, u2] = q.turn;
            let xr = u0 * c[0] + u1 * c[1] + u2 * c[2], xg = u2 * c[0] + u0 * c[1] + u1 * c[2], xb = u1 * c[0] + u2 * c[1] + u0 * c[2];
            const ll = LUM[0] * xr + LUM[1] * xg + LUM[2] * xb;
            xr = ll + (xr - ll) * q.sat + q.bri; xg = ll + (xg - ll) * q.sat + q.bri; xb = ll + (xb - ll) * q.sat + q.bri;
            c[0] = c[0] + (xr - c[0]) * m; c[1] = c[1] + (xg - c[1]) * m; c[2] = c[2] + (xb - c[2]) * m;
        }
        if (view !== "result") {
            const m = view === "shadows" ? ws : view === "midtones" ? wm : view === "highlights" ? wh : view === "secondary A" ? qA : qB;
            o[i] = m; o[i + 1] = m; o[i + 2] = m; o[i + 3] = 1;
            continue;
        }
        o[i] = (r0 + (c[0] - r0) * mix) * a; o[i + 1] = (g0 + (c[1] - g0) * mix) * a; o[i + 2] = (b0 + (c[2] - b0) * mix) * a; o[i + 3] = a;
    }
    return out;
}
