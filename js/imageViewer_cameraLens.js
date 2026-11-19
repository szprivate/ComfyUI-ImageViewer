// imageViewer_cameraLens.js
// A scene camera's lens and film back, as plain numbers (Sebastian 2026-11-19:
// "add to the camera's parameters: the aperture size of the camera, amongst
// the other important attributes"). Pure: no DOM, no three.js; tested under
// node (tests/test_camera_lens.mjs). Clean-room: the list of attributes is what
// a camera has in any package, the arithmetic is the pinhole camera's.
//
// The camera's `fov` stays what it always was - the vertical field of view of
// its picture, the one number that is keyed and drawn. Everything here is read
// from it and the picture's shape, or written back into it:
//   filmback  [width, height] of the camera's aperture in mm (absent = 36 x 24)
//   filmFit   how the picture lies on the film back (absent = "horizontal"):
//               horizontal  the picture's width is the film's width
//               vertical    the picture's height is the film's height
//               fill        the picture as large as fits inside the film back
//               overscan    the film back inside the picture
//   clip      [near, far] in scene units (absent = the viewer's own 0.1 / 10000)
// The focal length is then (picture height on the film / 2) / tan(fov / 2).

export const FILMBACK_DEFAULT = [36, 24];
export const FILM_FITS = ["horizontal", "vertical", "fill", "overscan"];
export const FILM_FIT_LABELS = { horizontal: "Horizontal", vertical: "Vertical", fill: "Fill", overscan: "Overscan" };
export const CLIP_DEFAULT = [0.1, 10000];

/** Film backs most often asked for: [label, width, height] in mm, as the makers publish them. */
export const FILMBACK_PRESETS = [
    ["Full frame 35 mm", 36, 24],
    ["Super 35", 24.89, 18.66],
    ["Super 35 16:9", 24.89, 14.0],
    ["Academy 35 mm", 21.95, 16.0],
    ["APS-C", 23.5, 15.6],
    ["Micro Four Thirds", 17.3, 13.0],
    ["ARRI Alexa Mini 16:9", 23.76, 13.37],
    ["ARRI Alexa LF 16:9", 31.68, 17.82],
    ["RED Komodo 6K", 27.03, 14.26],
    ["Super 16", 12.52, 7.41],
    ["1 inch", 13.2, 8.8],
    ["Phone main camera (1/1.7\")", 7.6, 5.7],
];

const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The film back, [w, h] mm, held to 0.1 .. 200. */
export function filmbackOf(item) {
    const fb = item && Array.isArray(item.filmback) && item.filmback.length === 2 ? item.filmback : FILMBACK_DEFAULT;
    return [clamp(num(fb[0], 36), 0.1, 200), clamp(num(fb[1], 24), 0.1, 200)];
}

export function filmFitOf(item) {
    return item && FILM_FITS.includes(item.filmFit) ? item.filmFit : "horizontal";
}

/** [near, far], far always beyond near. */
export function clipOf(item) {
    const c = item && Array.isArray(item.clip) && item.clip.length === 2 ? item.clip : CLIP_DEFAULT;
    const near = clamp(num(c[0], CLIP_DEFAULT[0]), 1e-5, 1e7);
    const far = clamp(num(c[1], CLIP_DEFAULT[1]), near * 1.0001, 1e9);
    return [near, far];
}

/** The picture's [w, h] on the film back in mm, for a picture of aspect `aspect` (width / height). */
export function pictureOnFilm(item, aspect) {
    const [W, H] = filmbackOf(item);
    const a = aspect > 0 ? aspect : W / H;
    switch (filmFitOf(item)) {
        case "vertical": return [H * a, H];
        case "fill": return W / H > a ? [H * a, H] : [W, W / a];
        case "overscan": return W / H > a ? [W, W / a] : [H * a, H];
        default: return [W, W / a];
    }
}

const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

/** Focal length in mm of a camera whose picture (of `aspect`) has vertical field of view `fov`. */
export function focalOf(item, fov, aspect) {
    const f = clamp(num(fov, 35), 0.01, 179.99);
    const [, ph] = pictureOnFilm(item, aspect);
    return (ph / 2) / Math.tan(rad(f) / 2);
}

/** The vertical field of view that a focal length (mm) gives. */
export function fovFromFocal(item, focal, aspect) {
    const [, ph] = pictureOnFilm(item, aspect);
    const f = Math.max(1e-3, num(focal, 35));
    return clamp(deg(2 * Math.atan((ph / 2) / f)), 0.01, 179.99);
}

/** Horizontal field of view from the vertical one and the picture's shape. */
export function horizontalFov(fov, aspect) {
    const f = clamp(num(fov, 35), 0.01, 179.99);
    return clamp(deg(2 * Math.atan(Math.tan(rad(f) / 2) * (aspect > 0 ? aspect : 1))), 0.01, 179.99);
}

/** The vertical field of view that a horizontal one gives. */
export function fovFromHorizontal(hfov, aspect) {
    const h = clamp(num(hfov, 50), 0.01, 179.99);
    return clamp(deg(2 * Math.atan(Math.tan(rad(h) / 2) / (aspect > 0 ? aspect : 1))), 0.01, 179.99);
}

/** The lens fields as a scene keeps them (only what differs from the defaults), or null each. */
export function readLensFields(raw) {
    const out = {};
    if (raw && Array.isArray(raw.filmback) && raw.filmback.length === 2) out.filmback = filmbackOf(raw);
    if (raw && FILM_FITS.includes(raw.filmFit) && raw.filmFit !== "horizontal") out.filmFit = raw.filmFit;
    if (raw && Array.isArray(raw.clip) && raw.clip.length === 2) out.clip = clipOf(raw);
    return out;
}

/**
 * A camera's own framing mask (imageViewer_frameMasks.js draws it while the
 * camera is looked through, in place of the viewer's): {on, key, custom,
 * opacity, line, label}, the same fields as the viewer's mask. Absent = the
 * camera shows the viewer's mask. Kept lightly here (the key is checked where
 * it is drawn, by the frame masks' own table).
 */
export function readCameraMask(raw) {
    if (!raw || typeof raw !== "object") return null;
    const op = Number(raw.opacity);
    return {
        on: raw.on !== false,
        key: typeof raw.key === "string" && raw.key ? raw.key.slice(0, 12) : "2.39",
        custom: typeof raw.custom === "string" ? raw.custom.slice(0, 20) : "",
        opacity: Number.isFinite(op) ? clamp(op, 0, 1) : 0.75,
        line: raw.line !== false,
        label: raw.label !== false,
    };
}
