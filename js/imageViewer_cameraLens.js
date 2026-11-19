// imageViewer_cameraLens.js
// A camera's lens and film back, and its own framing mask (Sebastian 2026-11-19: "add to the camera's
// parameters the aperture size, focal length, fov ..."; "add the mask as a parameter of the camera").
// Pure data and arithmetic, no DOM, no three.js (tests/test_camera_lens.mjs). Clean-room: the usual
// pinhole camera of any textbook - a film back of W x H millimetres behind a lens of focal length f
// sees 2 atan(W / 2f) across.
//
// What is stored, on a camera item:
//   fov       the vertical field of view of the camera's PICTURE (its resolution's shape), in degrees -
//             as it always was; the one lens number that is keyed. The focal length and the horizontal
//             field of view are read off it, and typing one of them writes it.
//   lens      { aperture: [w, h] mm, fit, shift: [x, y], near, far } - absent = the defaults below.
//             fit says how the film back meets a picture of another shape:
//               "fill"        the picture lies inside the film back, as large as fits (the default)
//               "horizontal"  the film back's width is the picture's width
//               "vertical"    the film back's height is the picture's height
//             shift moves the picture across the film back, as a share of the picture's width (x) and
//             height (y), y up; near / far are the clipping planes in scene units, 0 = chosen from the
//             scene's size.
//   mask      { on, key, custom, opacity, line, label } - the framing mask drawn in this camera's gate
//             (imageViewer_frameMasks.js's state); absent or off = the viewer's own mask.
import { FRAME_MASKS, cleanState as cleanMaskState, maskOf } from "./imageViewer_frameMasks.js";

/** Film backs a camera is often given: [label, width mm, height mm]. */
export const FILM_BACKS = [
    ["Full frame 35 mm", 36, 24],
    ["Super 35", 24.89, 18.66],
    ["APS-C", 23.6, 15.6],
    ["Micro Four Thirds", 17.3, 13],
    ["Academy 35 mm", 21.95, 16],
    ["Super 16", 12.52, 7.41],
    ["1 inch", 13.2, 8.8],
    ["Phone main camera", 7.89, 5.26],
];

export const SENSOR_FITS = ["fill", "horizontal", "vertical"];

export const DEFAULT_LENS = Object.freeze({ aperture: [36, 24], fit: "fill", shift: [0, 0], near: 0, far: 0 });

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round = (v, k = 1e4) => Math.round(v * k) / k;
const RAD = Math.PI / 180;

/** A lens as stored: missing or out of range is the default's. Never null. */
export function lensSettings(itemOrLens) {
    const raw = itemOrLens && itemOrLens.kind ? itemOrLens.lens : itemOrLens;
    const out = { aperture: DEFAULT_LENS.aperture.slice(), fit: DEFAULT_LENS.fit, shift: [0, 0], near: 0, far: 0 };
    if (!raw || typeof raw !== "object") return out;
    if (Array.isArray(raw.aperture) && raw.aperture.length === 2) {
        const [w, h] = raw.aperture.map((v) => num(v, 0));
        if (w > 0.1 && h > 0.1 && w < 500 && h < 500) out.aperture = [round(w), round(h)];
    }
    if (SENSOR_FITS.includes(raw.fit)) out.fit = raw.fit;
    if (Array.isArray(raw.shift) && raw.shift.length === 2) {
        out.shift = raw.shift.map((v) => Math.min(2, Math.max(-2, round(num(v, 0)))));
    }
    const near = num(raw.near, 0), far = num(raw.far, 0);
    out.near = near > 0 ? near : 0;
    out.far = far > 0 ? far : 0;
    if (out.near && out.far && out.far <= out.near) out.far = 0;
    return out;
}

/** The lens to keep on the item: null when it is the default in every part (so old scenes stay as they are). */
export function cleanLens(raw) {
    if (!raw || typeof raw !== "object") return null;
    const l = lensSettings(raw);
    const d = DEFAULT_LENS;
    const same = l.aperture[0] === d.aperture[0] && l.aperture[1] === d.aperture[1] && l.fit === d.fit
        && !l.shift[0] && !l.shift[1] && !l.near && !l.far;
    return same ? null : l;
}

/**
 * The part of the film back a picture of `aspect` (width / height) takes, in millimetres: [w, h].
 */
export function gateFilm(lens, aspect) {
    const l = lensSettings(lens);
    const [aw, ah] = l.aperture;
    const ar = aspect > 0 ? aspect : aw / ah;
    let fit = l.fit;
    if (fit === "fill") fit = ar >= aw / ah ? "horizontal" : "vertical";
    return fit === "horizontal" ? [aw, aw / ar] : [ah * ar, ah];
}

/** The focal length (mm) that gives vertical field of view `fov` (degrees) to a picture of `aspect`. */
export function focalFromFov(lens, aspect, fov) {
    const h = gateFilm(lens, aspect)[1];
    const t = Math.tan(Math.min(179, Math.max(0.01, num(fov, 35))) * RAD / 2);
    return h / 2 / t;
}

/** The vertical field of view (degrees) a focal length `mm` gives a picture of `aspect`. */
export function fovFromFocal(lens, aspect, mm) {
    const h = gateFilm(lens, aspect)[1];
    const f = Math.max(0.01, num(mm, 35));
    return 2 * Math.atan(h / 2 / f) / RAD;
}

/** Horizontal field of view (degrees) from the vertical one, for a picture of `aspect`. */
export function horizontalFov(aspect, fov) {
    return 2 * Math.atan(Math.tan(num(fov, 35) * RAD / 2) * aspect) / RAD;
}

/** The vertical field of view from a horizontal one. */
export function verticalFov(aspect, hfov) {
    return 2 * Math.atan(Math.tan(num(hfov, 50) * RAD / 2) / (aspect > 0 ? aspect : 1)) / RAD;
}

/**
 * A new film back that keeps what the camera sees (its field of view does not change: the focal length
 * reads differently), as a camera body changed behind the same picture.
 */
export function withAperture(lens, aperture) {
    return { ...lensSettings(lens), aperture: aperture.slice() };
}

/**
 * The lens shift written into a perspective projection matrix (column-major, three.js's `elements`):
 * moving the picture by `shift` (shares of the picture's width / height) inside a view whose drawn
 * picture is `fx` x `fy` of the whole view (1 x 1 when the view IS the picture; the gate's share when
 * the view is wider than the shot). Returns the two entries to ADD: [e8, e9].
 */
export function shiftTerms(shift, fx = 1, fy = 1) {
    const [sx, sy] = Array.isArray(shift) ? shift : [0, 0];
    // NDC spans 2 across the view; the picture's width is fx of it. x_ndc = ... - e8, so a positive x
    // shift moves the picture's content left (the camera looks further right), as a shifted lens does,
    // and a positive y shift moves it down (the camera looks further up).
    return [2 * num(sx, 0) * fx, 2 * num(sy, 0) * fy];
}

// ── the camera's own framing mask ────────────────────────────────────────────

/** A camera's mask as stored: null when it has none of its own. */
export function cleanCameraMask(raw) {
    if (!raw || typeof raw !== "object") return null;
    const st = cleanMaskState(raw);
    return st.on ? st : null;
}

/** The mask to draw in a camera's gate: its own when it has one, else the viewer's state `viewer`. */
export function gateMask(item, viewer) {
    const own = item && cleanCameraMask(item.mask);
    if (own) return { st: own, mask: maskOf(own), own: true };
    return { st: viewer || null, mask: maskOf(viewer), own: false };
}

/** The mask presets a camera row offers: [value, label]; "" = none of its own. */
export function maskChoices() {
    return [["", "the viewer's"], ...FRAME_MASKS.map((m) => [m.key, m.label]), ["custom", "custom…"]];
}
