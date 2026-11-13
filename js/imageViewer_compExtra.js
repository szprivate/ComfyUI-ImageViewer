// imageViewer_compExtra.js
// Comp's finishing nodes: keying and matte finishing, time, colour, filters and the AI nodes that run a ComfyUI
// workflow (their arithmetic is imageViewer_compFilters.js). compModel spreads EXTRA_TYPES into NODE_TYPES,
// hands `extraMake` the nodes it does not know and asks `extraReads` / `aiReads` which frames and results a
// node reads. src/comp_extra.py is the numpy twin (the same table, `make` and arithmetic).
//
// AI nodes (Sebastian 2026-11-13, "nodes backed by models"): the picture that comes in is sent to a ComfyUI
// workflow (the one Paint's Generate uses for that action, so Settings › Paint picks the model), the answer is
// saved beside the comp and named in the node's `results` ({frames: {f: file}, keys: {f: what it ran on}}).
// The node then shows that file like a Read (the nearest frame that ran, before f if there is one); until it
// runs it passes its input through. Nothing runs by itself: the Run buttons in Parameters run it.
import * as F from "./imageViewer_compFilters.js";
import { mixExtras } from "./imageViewer_compChannels.js";
import * as GR from "./imageViewer_compGrain.js";
export { F, GR };

const write = { kind: "target", def: "rgba", label: "channel", help: "What it writes into: rgba (its whole picture), one channel, or a layer (its r g b a); the rest of what comes in passes" };
const onOff = (def = "off") => ({ kind: "enum", def, choices: ["off", "on"] });
const hueParams = () => {
    const out = {};
    for (const h of F.HUES) out["sat_" + h] = { kind: "num", def: 1, min: 0, key: true, step: 0.05, label: `sat ${h}`, help: `Saturation of the ${h}s (x)` };
    for (const h of F.HUES) out["hue_" + h] = { kind: "num", def: 0, key: true, step: 1, label: `hue ${h}`, help: `The ${h}s turned by this many degrees` };
    for (const h of F.HUES) out["lum_" + h] = { kind: "num", def: 1, min: 0, key: true, step: 0.05, label: `lum ${h}`, help: `Brightness of the ${h}s (x)` };
    return out;
};
const cdlParams = () => {
    const out = {};
    for (const c of "rgb") out["slope_" + c] = { kind: "num", def: 1, min: 0, key: true, step: 0.01, label: `slope ${c}` };
    for (const c of "rgb") out["offset_" + c] = { kind: "num", def: 0, key: true, step: 0.005, label: `offset ${c}` };
    for (const c of "rgb") out["power_" + c] = { kind: "num", def: 1, min: 0.01, key: true, step: 0.01, label: `power ${c}` };
    out.saturation = { kind: "num", def: 1, min: 0, key: true, step: 0.01 };
    out.direction = { kind: "enum", def: "forward", choices: F.CDL_DIRECTIONS, help: "inverse: undoes the correction" };
    return out;
};
const results = { kind: "ai", def: null, help: "What the workflow made, per frame (Run fills it)" };
/** A grain profile (imageViewer_compGrain.js analyseGrain), filled by the node's Analyse; null: measured each frame. */
const profile = { kind: "grainprofile", def: null, help: "The grain measured by Analyse; none: measured on every frame as it is drawn" };
const vfxResults = { kind: "ai", def: null, help: "The film the workflow made (Render fills it)" };
const prerender = { kind: "enum", def: "on", choices: ["on", "off"],
    help: "on: what comes into the node is rendered to a film first and that goes through the workflow. off: the film of the Read coming in is used as it is (faster; only a Read of a film, with nothing between)" };

export const AI_KINDS = { ai_matte: "matte", ai_depth: "depth", ai_relight: "relight", ai_inpaint: "inpaint", ai_upscale: "upscale" };
/** The VFX nodes: the History's Convert Footage workflows (LTX-2.5, src/clip_vfx.py) on the comp, over its
 *  whole frame range at once (comp_vfx on the server). Their `results` is ONE film or EXR sequence:
 *  {file, offset, first, last, width, height, colorspace, key, prerender}; frames first..last show it, the
 *  others pass the input. */
export const VFX_KINDS = { vfx_alpha: "alpha", vfx_hdr: "hdr", vfx_reframe: "reframe", vfx_upscale: "upscale" };
/** The ones whose picture takes the result's size (the others keep the size that comes in). */
const VFX_SIZED = new Set(["reframe", "upscale"]);
/** The data pictures (read as numbers, not as sRGB colour). */
const AI_DATA = new Set(["matte", "depth"]);

export const EXTRA_TYPES = {
    // ── keying and matte finishing ──
    differencekeyer: { label: "DifferenceKeyer", cat: "Keyer", inputs: ["src", "clean"], params: {
        threshold: { kind: "num", def: 0.05, min: 0, key: true, step: 0.005, help: "Differences below this are the clean plate (transparent)" },
        softness: { kind: "num", def: 0.1, min: 0, key: true, step: 0.005, help: "Over this much more the matte becomes solid" },
        invert: onOff(),
        output: { kind: "enum", def: "premultiplied", choices: F.DIFF_OUTPUTS, help: "matte: the matte as grey" },
        write,
    } },
    despill: { label: "Despill", cat: "Keyer", inputs: ["src"], params: {
        screen: { kind: "enum", def: "green", choices: F.SPILL_SCREENS },
        limit: { kind: "enum", def: "max", choices: ["max", "average"], help: "The screen channel is held to the larger, or the mean, of the other two" },
        amount: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.05 },
        replace: { kind: "enum", def: "none", choices: F.SPILL_REPLACE, help: "What the spill taken out becomes: nothing, grey (keeps the brightness), or the replace colour" },
        replace_color: { kind: "color", def: [0.5, 0.5, 0.5, 1], key: true, label: "replace colour", help: "The colour the spill is turned into (replace: colour)" },
        output: { kind: "enum", def: "despilled", choices: F.SPILL_OUTPUTS, help: "spill: what is taken out, as a matte" },
    } },
    edgeextend: { label: "EdgeExtend", cat: "Keyer", inputs: ["src"], params: {
        size: { kind: "num", def: 6, min: 0, max: 200, key: true, step: 0.5, help: "How far the core's colour is pushed out, pixels of the comp" },
        threshold: { kind: "num", def: 0.95, min: 0, max: 0.999, key: true, step: 0.01, help: "Alpha above this counts as solid (the colour kept)" },
        output: { kind: "enum", def: "premultiplied", choices: F.EXTEND_OUTPUTS, help: "extended: the colour everywhere, alpha 1" },
    } },
    lightwrap: { label: "LightWrap", cat: "Keyer", inputs: ["fg", "bg"], params: {
        width: { kind: "num", def: 10, min: 0, max: 200, key: true, step: 0.5, help: "How far in from the foreground's edge the light reaches" },
        diffuse: { kind: "num", def: 20, min: 0, max: 400, key: true, step: 0.5, help: "How much the background is blurred first" },
        intensity: { kind: "num", def: 1, min: 0, key: true, step: 0.05 },
        threshold: { kind: "num", def: 0, min: 0, key: true, step: 0.05, help: "Only background brighter than this wraps (0: all of it)" },
        output: { kind: "enum", def: "wrapped", choices: F.WRAP_OUTPUTS, help: "wrap only: the light alone, to merge yourself" },
    } },
    coreedge: { label: "CoreEdge", cat: "Keyer", inputs: ["src"], params: {
        size: { kind: "num", def: 3, min: 0, max: 100, key: true, step: 0.5, help: "Pixels in and out from the matte's edge" },
        softness: { kind: "num", def: 1, min: 0, max: 100, key: true, step: 0.5 },
        output: { kind: "enum", def: "edge", choices: F.CORE_OUTPUTS, help: "core: the solid inside; edge: the band along the edge; outside: what is clearly out" },
        write,
    } },
    // ── time ──
    framehold: { label: "FrameHold", cat: "Time", inputs: ["src"], params: {
        frame: { kind: "int", def: 0, help: "The frame shown" },
        every: { kind: "int", def: 0, min: 0, help: "Above 0: a new frame held every this many frames (from 'frame' on)" },
    } },
    framerange: { label: "FrameRange", cat: "Time", inputs: ["src"], params: {
        first: { kind: "int", def: 0 }, last: { kind: "int", def: 47 },
        outside: { kind: "enum", def: "hold", choices: ["hold", "black"], help: "Before first and after last: the end frame held, or nothing" },
    } },
    timeoffset: { label: "TimeOffset", cat: "Time", inputs: ["src"], params: {
        offset: { kind: "int", def: 0, help: "+10 shows the input 10 frames later" },
    } },
    appendclip: { label: "AppendClip", cat: "Time", inputs: ["A", "B"], params: {
        a_first: { kind: "int", def: 0, label: "A first", help: "A's first frame" },
        a_last: { kind: "int", def: 23, label: "A last", help: "A's last frame: B follows it" },
        b_first: { kind: "int", def: 0, label: "B first", help: "B's first frame" },
        dissolve: { kind: "int", def: 0, min: 0, help: "Frames A and B overlap, dissolving" },
    } },
    timeblur: { label: "TimeBlur", cat: "Time", inputs: ["src"], params: {
        shutter: { kind: "num", def: 0.5, min: 0, max: 8, step: 0.05, help: "Frames averaged over" },
        samples: { kind: "int", def: 5, min: 1, max: 32, help: "Moments taken in that time (between frames: the two mixed)" },
        offset: { kind: "enum", def: "centred", choices: ["centred", "start", "end"] },
    } },
    // ── colour ──
    cdl: { label: "CDL", cat: "Color", inputs: ["src"], params: cdlParams() },
    lut: { label: "LUT", cat: "Color", inputs: ["src"], params: {
        file: { kind: "lutfile", def: "", help: "A LUT file (.cube; with OpenColorIO also .3dl, .spi3d, .csp and more)" },
        unpremult: { kind: "enum", def: "on", choices: ["on", "off"], help: "on: through the straight colour (the alpha divided out first)" },
    } },
    huecurves: { label: "HueCurves", cat: "Color", inputs: ["src"], params: hueParams() },
    clamp: { label: "Clamp", cat: "Color", inputs: ["src"], params: {
        minimum: { kind: "num", def: 0, key: true, step: 0.01 }, maximum: { kind: "num", def: 1, key: true, step: 0.01 },
        min_on: { kind: "enum", def: "on", choices: ["on", "off"], label: "clamp low" },
        max_on: { kind: "enum", def: "on", choices: ["on", "off"], label: "clamp high" },
        channels: { kind: "enum", def: "rgb", choices: F.CLAMP_CHANNELS },
    } },
    loglin: { label: "Log2Lin", cat: "Color", inputs: ["src"], params: {
        operation: { kind: "enum", def: "log to lin", choices: F.LOG_DIRECTIONS },
        curve: { kind: "enum", def: "cineon", choices: F.LOG_CURVES, help: "cineon (95 / 685, 0.6), logc3 (EI 800), slog3, acescct" },
    } },
    colormatch: { label: "ColorMatch", cat: "Color", inputs: ["src", "reference"], params: {
        amount: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.05, help: "Each channel's mean and spread made the reference's" },
    } },
    // ── filters ──
    grain: { label: "Grain", cat: "Filter", inputs: ["src", "plate"], params: {
        amount: { kind: "num", def: 0.04, min: 0, key: true, step: 0.005, help: "How strong (with a plate: a share of the grain measured on it, 1 = as much)" },
        size: { kind: "num", def: 1, min: 0, max: 20, key: true, step: 0.1, help: "Grain size, pixels of the comp (0: one pixel)" },
        saturation: { kind: "num", def: 0.3, min: 0, max: 1, key: true, step: 0.05, help: "0: the same grain in every channel; 1: each its own" },
        response: { kind: "num", def: 0.5, min: 0, max: 1, key: true, step: 0.05, help: "1: grain grows with brightness; 0: even" },
        seed: { kind: "int", def: 0 },
        animated: { kind: "enum", def: "on", choices: F.GRAIN_ANIM, help: "on: new grain every frame" },
        profile,
    } },
    degrain: { label: "Degrain", cat: "Filter", inputs: ["src"], params: {
        temporal: { kind: "int", def: 1, min: 0, max: 3, help: "Frames each side averaged in where nothing moves (0: this frame only)" },
        motion: { kind: "num", def: 4, min: 0.5, max: 20, step: 0.25, help: "A neighbouring frame counts as moved where it differs by more than this many times the grain" },
        strength: { kind: "num", def: 1.5, min: 0, max: 10, key: true, step: 0.05, help: "Detail below this many times the grain's spread is taken as grain" },
        fine: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.05, help: "How much of the finest grain (1 pixel) goes" },
        medium: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.05, help: "How much of the 2 pixel grain goes" },
        coarse: { kind: "num", def: 0.5, min: 0, max: 1, key: true, step: 0.05, help: "How much of the coarser grain (4 pixels and up) goes" },
        output: { kind: "enum", def: "degrained", choices: GR.DEGRAIN_OUTPUTS, help: "removed: what was taken out" },
        profile,
    } },
    regrain: { label: "Regrain", cat: "Filter", inputs: ["comp", "plate", "degrained", "new"], params: {
        amount: { kind: "num", def: 1, min: 0, key: true, step: 0.05, help: "1: as strong as the plate's grain at each brightness" },
        fill: { kind: "enum", def: "scatter", choices: GR.REGRAIN_FILLS, help: "Where the comp is new: the plate's grain scattered from elsewhere, grain made from the profile, or the plate's own left in place" },
        detect: { kind: "enum", def: "on", choices: ["on", "off"], help: "on: where the comp differs from the degrained plate counts as new (besides the 'new' input)" },
        threshold: { kind: "num", def: 0.02, min: 0, key: true, step: 0.005, help: "A brightness difference above this is new" },
        softness: { kind: "num", def: 0.02, min: 0, key: true, step: 0.005 },
        cell: { kind: "num", def: 48, min: 4, max: 512, step: 4, help: "Scatter: the size of the pieces the grain is taken in, pixels of the comp" },
        seed: { kind: "int", def: 0 },
        animated: { kind: "enum", def: "on", choices: F.GRAIN_ANIM, help: "on: new scatter / synthesis every frame" },
        output: { kind: "enum", def: "result", choices: GR.REGRAIN_OUTPUTS, help: "grain: the grain alone; new areas: where it was made again; difference: the result less the plate" },
        profile,
    } },
    denoise: { label: "Denoise", cat: "Filter", inputs: ["src"], params: {
        radius: { kind: "num", def: 3, min: 0, max: 30, step: 0.5, help: "Pixels of the comp: the area it averages over" },
        strength: { kind: "num", def: 0.05, min: 0, max: 1, key: true, step: 0.005, help: "Differences below about this are noise (smoothed); above, detail (kept)" },
        mix: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.05 },
    } },
    sharpen: { label: "Sharpen", cat: "Filter", inputs: ["src"], params: {
        amount: { kind: "num", def: 0.5, min: 0, key: true, step: 0.05 },
        size: { kind: "num", def: 2, min: 0, max: 50, key: true, step: 0.25, help: "Detail size, pixels of the comp" },
    } },
    median: { label: "Median", cat: "Filter", inputs: ["src"], params: {
        radius: { kind: "num", def: 1, min: 0, max: F.MEDIAN_MAX, step: 1, help: `Pixels of the comp (up to ${F.MEDIAN_MAX}): takes out specks and dust` },
        channels: { kind: "enum", def: "rgba", choices: F.MEDIAN_CHANNELS },
    } },
    edgedetect: { label: "EdgeDetect", cat: "Filter", inputs: ["src"], params: {
        size: { kind: "num", def: 1, min: 0, max: 50, key: true, step: 0.25, help: "Blur first, pixels of the comp" },
        gain: { kind: "num", def: 1, min: 0, key: true, step: 0.1 },
        source: { kind: "enum", def: "luminance", choices: F.EDGE_SOURCES },
    } },
    edgeblur: { label: "EdgeBlur", cat: "Filter", inputs: ["src"], params: {
        size: { kind: "num", def: 3, min: 0, max: 100, key: true, step: 0.25, help: "The blur along the edge, pixels of the comp" },
        width: { kind: "num", def: 3, min: 0, max: 100, key: true, step: 0.25, help: "How wide the band along the alpha's edge is" },
        amount: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.05 },
    } },
    // ── AI, through ComfyUI ──
    ai_matte: { label: "AI Matte", cat: "AI", inputs: ["src"], params: {
        output: { kind: "enum", def: "premultiplied", choices: ["premultiplied", "matte"], help: "matte: the matte as grey" },
        write, results,
    } },
    ai_depth: { label: "AI Depth", cat: "AI", inputs: ["src"], params: {
        invert: { kind: "enum", def: "off", choices: ["off", "on"], help: "off: near is white" },
        results,
    } },
    ai_relight: { label: "AI Relight", cat: "AI", inputs: ["src"], params: {
        prompt: { kind: "prompt", def: "soft warm light from the left, as late afternoon sun", help: "The light you want" },
        results,
    } },
    ai_inpaint: { label: "AI Inpaint", cat: "AI", inputs: ["src", "mask"], params: {
        prompt: { kind: "prompt", def: "", help: "What to make in the mask's place; empty: take out what is there (a clean plate)" },
        results,
    } },
    ai_upscale: { label: "AI Upscale", cat: "AI", inputs: ["src"], params: {
        factor: { kind: "enum", def: "2", choices: ["2", "4"], help: "The picture this many times larger" },
        results,
    } },
    // ── VFX, LTX-2.5 workflows over the whole range ──
    vfx_alpha: { label: "VFX Alpha Matte", cat: "VFX", inputs: ["src"], params: {
        output: { kind: "enum", def: "premultiplied", choices: ["premultiplied", "matte"], help: "matte: the matte as grey" },
        prerender, results: vfxResults,
    } },
    vfx_hdr: { label: "VFX SDR to HDR", cat: "VFX", inputs: ["src"], params: { prerender, results: vfxResults } },
    vfx_reframe: { label: "VFX Reframe", cat: "VFX", inputs: ["src"], params: {
        width: { kind: "int", def: 1920, min: 256, max: 1920, help: "The new frame's width (snapped to 64)" },
        height: { kind: "int", def: 1088, min: 256, max: 1920, help: "The new frame's height (snapped to 64)" },
        prompt: { kind: "prompt", def: "", help: "Optional: what the new parts of the frame show" },
        prerender, results: vfxResults,
    } },
    vfx_upscale: { label: "VFX Upscale", cat: "VFX", inputs: ["src"], params: {
        mode: { kind: "enum", def: "refine", choices: ["refine", "restore"], help: "refine: stays close to the clip; restore: for damaged or archival footage" },
        size: { kind: "enum", def: "FullHD", choices: ["FullHD", "4K"], help: "4K needs more memory" },
        prompt: { kind: "prompt", def: "", help: "Optional: what the clip shows" },
        prerender, results: vfxResults,
    } },
};
export const EXTRA_ORDER = Object.keys(EXTRA_TYPES);
/** Effects with one picture going through them (the Layers view reads them as a layer's effects). */
export const EXTRA_CHAIN = EXTRA_ORDER.filter((t) => !["appendclip"].includes(t));
/** The per-pixel ones that take a mask input (the last) and a mix, as the other colour / filter / keyer nodes do. */
export const EXTRA_MASKABLE = ["differencekeyer", "despill", "edgeextend", "lightwrap", "coreedge", "cdl", "lut", "huecurves", "clamp",
    "loglin", "colormatch", "grain", "degrain", "denoise", "sharpen", "median", "edgedetect", "edgeblur"];
/** Slow ones: kept between renders. */
export const EXTRA_HEAVY = ["denoise", "median", "timeblur", "degrain", "regrain"];

// ── AI results ───────────────────────────────────────────────────────────────

/** Which frame's result node n shows at f: f's own, else the nearest before it, else the first; null for none. */
export function aiResultFrame(n, f) {
    const fr = n && n.results && n.results.frames;
    if (!fr) return null;
    const ks = Object.keys(fr).filter((k) => fr[k]).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!ks.length) return null;
    if (ks.includes(f)) return f;
    let best = null;
    for (const k of ks) if (k <= f) best = k;
    return best === null ? ks[0] : best;
}
/** The Read standing for an AI node's result at f (its pixels come through the ordinary footage reader). */
export function aiRead(n, f) {
    const rf = aiResultFrame(n, f);
    if (rf === null) return null;
    return { id: `${n.id}#ai${rf}`, type: "read", file: n.results.frames[String(rf)], colorspace: AI_DATA.has(AI_KINDS[n.type]) ? "linear" : "srgb",
        fit: "stretch", offset: 0, inputs: [] };
}
/** The comp frames a VFX node's result covers ([first, last]), or null before it ran. */
export function vfxSpan(n) {
    const r = n && n.results;
    if (!r || !r.file || !Number.isFinite(Number(r.first)) || !Number.isFinite(Number(r.last))) return null;
    return [Number(r.first), Number(r.last)];
}
/** The Read standing for a VFX node's result at f (its film or sequence through the footage reader), or null. */
export function vfxRead(n, f) {
    const sp = vfxSpan(n);
    if (!sp || f < sp[0] || f > sp[1]) return null;
    const r = n.results;
    return { id: `${n.id}#vfx`, type: "read", file: r.file, colorspace: r.colorspace || (VFX_KINDS[n.type] === "alpha" ? "linear" : "auto"),
        fit: "stretch", offset: Number(r.offset) || 0, inputs: [] };
}
/** The size a VFX node's picture has: the result's for reframe / upscale once run, else null (= what comes in). */
export function vfxSize(n) {
    const r = n && !n.disable && n.results;
    if (!r || !r.file || !VFX_SIZED.has(VFX_KINDS[n.type])) return null;
    const w = Math.round(Number(r.width)), h = Math.round(Number(r.height));
    return w > 0 && h > 0 ? { width: w, height: h } : null;
}
/** The factor an AI Upscale makes its picture larger by. */
export function upscaleFactor(n) { return Math.max(1, Number(n && n.factor) || 2); }

// ── time ─────────────────────────────────────────────────────────────────────

/** The input frame a FrameHold shows at f. */
export function holdFrame(n, f) {
    const at = n.frame || 0, every = Math.max(0, Math.round(n.every || 0));
    return every > 0 ? at + Math.floor((f - at) / every) * every : at;
}
/** AppendClip at f: [[input, frame, weight], ...]. */
export function appendParts(n, f) {
    const a0 = n.a_first || 0, a1 = n.a_last ?? 23, b0 = n.b_first || 0, d = Math.max(0, Math.round(n.dissolve || 0));
    const la = Math.max(1, a1 - a0 + 1), start = la - d;
    if (f < start) return [[0, a0 + f, 1]];
    if (f >= la) return [[1, b0 + f - start, 1]];
    const t = (f - start + 1) / (d + 1);
    return [[0, a0 + f, 1 - t], [1, b0 + f - start, t]];
}
/**
 * The frames of its inputs a time node reads at f: [[input index, frame]] (the editor loads them before a draw),
 * or null for a node that reads its inputs at f.
 */
export function extraReads(n, f) {
    switch (n.type) {
    case "framehold": return [[0, holdFrame(n, f)]];
    case "framerange": return [[0, n.outside === "black" && (f < (n.first || 0) || f > (n.last ?? 47)) ? null : Math.min(n.last ?? 47, Math.max(n.first || 0, f))]].filter((x) => x[1] !== null);
    case "timeoffset": return [[0, f - (n.offset || 0)]];
    case "appendclip": return appendParts(n, f).map(([i, g]) => [i, g]);
    case "timeblur": return F.timeBlurFrames({ shutter: n.shutter ?? 0.5, samples: n.samples ?? 5, offset: n.offset }, f).map(([g]) => [0, g]);
    // Its own frames, and the mask (its last input) at f.
    case "degrain": return [...GR.degrainFrames(n, f).map((g) => [0, g]), [1, f]];
    default: return null;
    }
}

/**
 * The picture of an extra node at f. api: {run(id, f), P(n, f) -> params, X(img, ex), exOf(id, f), scale, W, H,
 * size(n, k) -> the w x h coming into input k at this scale, blank, resample, fitMatrix, conform, mixImages, source, ocio}.
 * Returns undefined for a type it does not know.
 */
export function extraMake(n, f, api) {
    if (!EXTRA_TYPES[n.type]) return undefined;
    const { run, scale } = api, ins = n.inputs || [];
    const p = api.P(n, f);
    const src = () => run(ins[0], f);
    const other = (k, img) => (ins[k] ? api.conform(run(ins[k], f), img.w, img.h) : null);
    switch (n.type) {
    case "differencekeyer": { const s = src(); return F.differenceKeyImage(s, other(1, s), p); }
    case "despill": return F.despillImage(src(), p);
    case "edgeextend": return F.edgeExtendImage(src(), { ...p, size: p.size * scale });
    case "lightwrap": { const s = src(); return F.lightWrapImage(s, other(1, s), { ...p, width: p.width * scale, diffuse: p.diffuse * scale }); }
    case "coreedge": return F.coreEdgeImage(src(), { ...p, size: p.size * scale, softness: p.softness * scale });
    case "framehold": case "timeoffset": {
        const g = n.type === "framehold" ? holdFrame(n, f) : f - (n.offset || 0);
        return api.X(run(ins[0], g), api.exOf(ins[0], g));
    }
    case "framerange": {
        const r = extraReads(n, f);
        if (!r.length) { const [w, h] = api.size(n, 0); return api.X(api.blank(w, h), {}); }
        return api.X(run(ins[0], r[0][1]), api.exOf(ins[0], r[0][1]));
    }
    case "appendclip": {
        const parts = appendParts(n, f);
        const pic = ([i, g]) => run(ins[i], g);
        if (parts.length === 1) return api.X(pic(parts[0]), api.exOf(ins[parts[0][0]], parts[0][1]));
        const a = pic(parts[0]), b = api.conform(pic(parts[1]), a.w, a.h), t = parts[1][2];
        return api.X(api.mixImages(a, b, t), mixExtras(api.exOf(ins[0], parts[0][1]), api.exOf(ins[1], parts[1][1]), t, a.w * a.h));
    }
    case "timeblur": {
        const fw = F.timeBlurFrames(p, f);
        const pics = fw.map(([g]) => run(ins[0], g)), first = pics[0];
        const out = F.weightedSum(pics.map((q) => api.conform(q, first.w, first.h)), fw.map((x) => x[1]));
        let best = 0;
        for (let k = 1; k < fw.length; k++) if (fw[k][1] > fw[best][1]) best = k;
        return api.X(out, api.exOf(ins[0], fw[best][0]));
    }
    case "cdl": return F.cdlImage(src(), p);
    case "lut": {
        const s = src();
        const lut = n.file && api.ocio ? api.ocio({ file: n.file }) : null;
        return lut ? api.ocioImage(s, lut, p.unpremult !== "off") : s;
    }
    case "huecurves": return F.hueCurvesImage(src(), p);
    case "clamp": return F.clampImage(src(), p);
    case "loglin": return F.logLinImage(src(), p);
    case "colormatch": { const s = src(); return F.colorMatchImage(s, ins[1] ? run(ins[1], f) : null, p); }
    case "grain": {
        const s = src();
        return GR.isProfile(n.profile) ? GR.profileGrainImage(s, n, p, f, scale) : F.grainImage(s, p, f, scale, ins[1] ? run(ins[1], f) : null);
    }
    case "degrain": {
        const fs = GR.degrainFrames(n, f), at = fs.indexOf(f), s = run(ins[0], f);
        const pics = fs.map((g) => (g === f ? s : api.conform(run(ins[0], g), s.w, s.h)));
        return GR.degrainImage(pics, at, n, p, scale);
    }
    case "regrain": { const s = src(); return GR.regrainImage(s, other(1, s), other(2, s), other(3, s), n, p, f, scale); }
    case "denoise": return F.denoiseImage(src(), p, scale);
    case "sharpen": return F.sharpenImage(src(), p, scale);
    case "median": return F.medianImage(src(), p, scale);
    case "edgedetect": return F.edgeDetectImage(src(), p, scale);
    case "edgeblur": return F.edgeBlurImage(src(), p, scale);
    default: return VFX_KINDS[n.type] ? vfxMake(n, f, p, api) : aiMake(n, f, p, api);
    }
}

/** A VFX node: its result over the frames it covers, at the result's size (reframe / upscale) or the size that
 *  comes in; outside them (or before it ran) the input, laid into that size. */
function vfxMake(n, f, p, api) {
    const kind = VFX_KINDS[n.type], ins = n.inputs || [];
    const s = ins[0] ? api.run(ins[0], f) : (() => { const [w, h] = api.size(n, 0); return api.blank(w, h); })();
    const sz = vfxSize(n);
    const w = sz ? Math.max(1, Math.round(sz.width * api.scale)) : s.w, h = sz ? Math.max(1, Math.round(sz.height * api.scale)) : s.h;
    const rd = vfxRead(n, f), got = rd && api.source ? api.source(rd, f) : null;
    if (!got) return w === s.w && h === s.h ? s : api.resample(s, api.fitMatrix(s.w, s.h, w, h, "stretch"), w, h);
    const r = api.resample(got, api.fitMatrix(got.w, got.h, w, h, "stretch"), w, h);
    if (kind === "reframe" || kind === "upscale") return r;
    const S = (w === s.w && h === s.h ? s : api.resample(s, api.fitMatrix(s.w, s.h, w, h, "stretch"), w, h)).data;
    const out = api.blank(w, h), o = out.data, R = r.data;
    for (let i = 0; i < w * h * 4; i += 4) {
        if (kind === "alpha") {
            const m = 0.2126 * R[i] + 0.7152 * R[i + 1] + 0.0722 * R[i + 2];
            if (p.output === "matte") { o[i] = m; o[i + 1] = m; o[i + 2] = m; o[i + 3] = 1; }
            else { o[i] = S[i] * m; o[i + 1] = S[i + 1] * m; o[i + 2] = S[i + 2] * m; o[i + 3] = S[i + 3] * m; }
        } else {        // hdr: the new picture under the alpha that came in
            const a = S[i + 3];
            for (let c = 0; c < 4; c++) o[i + c] = R[i + c] * a;
        }
    }
    return out;
}

/** An AI node: its result laid over the size that comes in (an upscale: that x its factor), else its input. */
function aiMake(n, f, p, api) {
    const kind = AI_KINDS[n.type], ins = n.inputs || [];
    const s = ins[0] ? api.run(ins[0], f) : (() => { const [w, h] = api.size(n, 0); return api.blank(w, h); })();
    const k = kind === "upscale" ? upscaleFactor(n) : 1;
    const w = Math.max(1, Math.round(s.w * k)), h = Math.max(1, Math.round(s.h * k));
    const rd = aiRead(n, f), got = rd && api.source ? api.source(rd, f) : null;
    if (!got) return kind === "upscale" ? api.resample(s, api.fitMatrix(s.w, s.h, w, h, "stretch"), w, h) : s;
    const r = api.resample(got, api.fitMatrix(got.w, got.h, w, h, "stretch"), w, h);
    const out = api.blank(w, h), o = out.data, R = r.data, S = s.data;
    // An inpaint changes the mask's place only: outside it the plate stays as it came in (in float).
    const mk = kind === "inpaint" && ins[1] ? api.conform(api.run(ins[1], f), w, h).data : null;
    for (let i = 0; i < w * h * 4; i += 4) {
        if (kind === "matte" || kind === "depth") {
            let m = 0.2126 * R[i] + 0.7152 * R[i + 1] + 0.0722 * R[i + 2];
            if (kind === "depth") { if (p.invert === "on") m = 1 - m; o[i] = m; o[i + 1] = m; o[i + 2] = m; o[i + 3] = 1; continue; }
            if (p.output === "matte") { o[i] = m; o[i + 1] = m; o[i + 2] = m; o[i + 3] = 1; }
            else { o[i] = S[i] * m; o[i + 1] = S[i + 1] * m; o[i + 2] = S[i + 2] * m; o[i + 3] = S[i + 3] * m; }
        } else if (kind === "upscale") { o[i] = R[i]; o[i + 1] = R[i + 1]; o[i + 2] = R[i + 2]; o[i + 3] = R[i + 3]; }
        else {
            const a = S[i + 3], m = mk ? mk[i + 3] : 1;
            for (let c = 0; c < 4; c++) o[i + c] = S[i + c] * (1 - m) + R[i + c] * a * m;
        }
    }
    return out;
}

/** The OCIO / LUT-file transforms extra nodes ask for at f (a LUT node's file). */
export function extraLuts(n) { return n.type === "lut" && n.file && !n.disable ? [{ file: n.file }] : []; }
