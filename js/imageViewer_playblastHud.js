// imageViewer_playblastHud.js
// The heads-up display a playblast carries: what the shot is, which camera,
// which frame - burnt into every picture, so a film passed round still says
// what it shows. Pure: `hudFields` is plain data (tested in
// tests/test_playblast_hud.mjs) and `drawHud` only needs a 2D context.
//
// The layout is the usual one for dailies: two bands, top and bottom, text in
// the four corners and the middle of the bottom band.

// The 35 mm still frame's height, which focal lengths are quoted against
// (the same aperture usd_io.py uses for its cameras).
export const APERTURE_V = 24;

/** Focal length in mm of a vertical field of view in degrees. */
export function focalOf(fovDeg) {
    const half = (Math.max(1, Math.min(179, Number(fovDeg) || 35)) * Math.PI) / 360;
    return APERTURE_V / 2 / Math.tan(half);
}

/** HH:MM:SS:FF of a frame at a rate (a fractional rate rounds its frame count, as a timecode does). */
export function timecode(frame, fps) {
    const r = Math.max(1, Math.round(Number(fps) || 24));
    const f = Math.max(0, Math.round(frame));
    const ff = f % r, s = Math.floor(f / r);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

/**
 * What each corner says.
 * info: { shot, camera, fov, frame, start, end, fps, width, height, date, note, user }
 */
export function hudFields(info = {}) {
    const fps = Number(info.fps) || 24;
    const cam = info.camera || "Free view";
    const lens = info.fov !== undefined && info.fov !== null ? ` · ${focalOf(info.fov).toFixed(1)} mm` : "";
    const size = info.width && info.height ? `${info.width}×${info.height}` : "";
    const d = info.date instanceof Date ? info.date : new Date(info.date || Date.now());
    const p = (n) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return {
        topLeft: info.shot || "shot",
        topRight: `${cam}${lens}`,
        bottomLeft: `Frame ${Math.round(info.frame || 0)}  [${Math.round(info.start || 0)}–${Math.round(info.end || 0)}]`,
        bottomCenter: [info.note, info.user].filter(Boolean).join(" · ") || day,
        bottomRight: `${timecode(info.frame || 0, fps)} · ${+fps.toFixed(3)} fps${size ? ` · ${size}` : ""}`,
        date: day,
    };
}

/** Write the display onto a 2D context of a w x h picture. */
export function drawHud(ctx, w, h, fields) {
    const size = Math.max(10, Math.round(h / 34));
    const band = Math.round(size * 1.8);
    const pad = Math.round(size * 0.7);
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, w, band);
    ctx.fillRect(0, h - band, w, band);
    ctx.font = `${size}px "DejaVu Sans Mono", Consolas, Menlo, monospace`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f2f2f2";
    const put = (text, x, y, align) => {
        if (!text) return;
        ctx.textAlign = align;
        ctx.fillText(String(text), x, y);
    };
    put(fields.topLeft, pad, band / 2, "left");
    put(fields.topRight, w - pad, band / 2, "right");
    put(fields.bottomLeft, pad, h - band / 2, "left");
    put(fields.bottomCenter, w / 2, h - band / 2, "center");
    put(fields.bottomRight, w - pad, h - band / 2, "right");
    ctx.restore();
    return { size, band };
}
