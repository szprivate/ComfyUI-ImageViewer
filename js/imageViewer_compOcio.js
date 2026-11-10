// OpenColorIO in Comp, the page's half. The config lives on the server (src/comp_ocio.py); the page gets each
// transform as a 3D LUT behind a shaper and applies it here (`applyLut`), the render applies the transform
// itself. Pure, imports nothing; the numpy twins are `shaper_forward`, `apply_lut` and `ocio_image` in
// src/comp_model.py (tests/test_comp_parity.py runs both through the same LUT).

/** "log2:lo:hi" (log2 of the value, lo..hi) or "lin:lo:hi" -> {kind, lo, hi}. */
export function parseShaper(s) {
    const [kind, lo, hi] = String(s || "lin:0:1").split(":");
    return { kind: kind === "log2" ? "log2" : "lin", lo: Number(lo) || 0, hi: Number(hi) || 1 };
}
export function shaperForward(sh, x) {
    let u;
    if (sh.kind === "log2") u = x > 0 ? (Math.log2(x) - sh.lo) / (sh.hi - sh.lo) : 0;
    else u = (x - sh.lo) / (sh.hi - sh.lo);
    return u < 0 ? 0 : u > 1 ? 1 : u;
}
/** One straight colour through the LUT (trilinear on the shaper's grid): [r, g, b]. */
export function lutColor(lut, r, g, b) {
    if (lut.shaper === "matrix") {   // a plain 3 x 3 and offset: exact
        const m = lut.data;
        return [m[0] * r + m[1] * g + m[2] * b + m[9], m[3] * r + m[4] * g + m[5] * b + m[10], m[6] * r + m[7] * g + m[8] * b + m[11]];
    }
    const N = lut.size, L = lut.data, sh = lut.sh || (lut.sh = parseShaper(lut.shaper));
    const at = (x) => { const u = shaperForward(sh, x) * (N - 1); let i = Math.floor(u); if (i > N - 2) i = N - 2; if (i < 0) i = 0; return [i, u - i]; };
    const [ri, rf] = at(r), [gi, gf] = at(g), [bi, bf] = at(b);
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        const v = (i, j, k) => L[((i * N + j) * N + k) * 3 + c];
        const b00 = v(ri, gi, bi) + (v(ri, gi, bi + 1) - v(ri, gi, bi)) * bf;
        const b01 = v(ri, gi + 1, bi) + (v(ri, gi + 1, bi + 1) - v(ri, gi + 1, bi)) * bf;
        const b10 = v(ri + 1, gi, bi) + (v(ri + 1, gi, bi + 1) - v(ri + 1, gi, bi)) * bf;
        const b11 = v(ri + 1, gi + 1, bi) + (v(ri + 1, gi + 1, bi + 1) - v(ri + 1, gi + 1, bi)) * bf;
        const g0 = b00 + (b01 - b00) * gf, g1 = b10 + (b11 - b10) * gf;
        out[c] = g0 + (g1 - g0) * rf;
    }
    return out;
}
/** A comp picture (premultiplied) through a colour function: divided by its alpha first when `unpremult`. */
export function ocioImage(img, fn, unpremult) {
    const s = img.data, out = { w: img.w, h: img.h, data: new Float32Array(s.length) }, o = out.data;
    for (let i = 0; i < s.length; i += 4) {
        const a = s[i + 3];
        o[i + 3] = a;
        if (unpremult) {
            if (a <= 0) { o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; continue; }
            const c = fn(s[i] / a, s[i + 1] / a, s[i + 2] / a);
            o[i] = c[0] * a; o[i + 1] = c[1] * a; o[i + 2] = c[2] * a;
        } else {
            const c = fn(s[i], s[i + 1], s[i + 2]);
            o[i] = c[0]; o[i + 1] = c[1]; o[i + 2] = c[2];
        }
    }
    return out;
}
/** The transform a node asks for: a colourspace conversion, or a display and view ("*" = the config's default). */
export function ocioSpec(type, p) {
    if (type === "ocio_display") return { src: p.in_space || "", display: p.display || "*", view: p.view || "*" };
    return { src: p.in_space || "", dst: p.out_space || "" };
}
export const ocioKey = (spec) => JSON.stringify([spec.src || "", spec.dst || "", spec.display || "", spec.view || ""]);
