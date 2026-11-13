// imageViewer_compModel.js
// Comp: the compositing document (*.comp.json), its edits and its pixel arithmetic.
//
// Plain ES module, no DOM: the Comp space (imageViewer_compPanel.js) draws with it, node runs it in the
// tests, and src/comp_model.py is the same arithmetic in numpy for the render and for the ComfyUI node
// (tests/test_comp_parity.py renders the same comps with both and compares them pixel by pixel).
//
// THE FORMAT ("comp": 1)
//   format  { width, height, fps, frames }                       frames = the comp's length
//   nodes   [ { id, type, name?, x, y, disable?, inputs: [id | null, ...], ...params, tracks? } ]
//   output  the id of the Output node the comp renders (the first Output when it is not set)
//
// One node graph, read two ways. The Node graph panel draws it as Nuke does, top to bottom. The Layers
// panel reads the same graph as a stack (layerStack): from the Output up the B pipe, every Merge is a
// layer whose picture is what comes down its A input (a source and the effects on it); what is at the top
// of the B pipe is the background. A branch that is more than a chain (a Merge inside an A input) is a
// layer of kind "group" there, edited in the graph. Nothing is stored twice.
//
// KEYS are Motion's (imageViewer_mgScene.js): static values on the node, animated ones in
// `tracks: { param: [{f, v, ease, ti?, to?}] }`, f = comp frame, and the same interpolation (paramAt calls
// Motion's valueAt), so Motion's stopwatch / key functions (imageViewer_mgModel.js) work on a node as on a layer.
//
// PIXELS are linear light, premultiplied RGBA, Float32Array w*h*4, top-left first (y down). A source is
// decoded once (decode8: sRGB 8-bit straight -> linear premultiplied), every node makes a picture of the
// comp's size (times the preview scale). Sampling is bilinear at pixel centres; outside a picture is
// transparent. Blur is Paint's (three box blurs, edge repeated; paint_math.blur_float).
import { valueAt } from "./imageViewer_mgScene.js";
import * as O from "./imageViewer_compOps.js";
import { ccParams, colorCorrectImage } from "./imageViewer_compColor.js";
import * as K from "./imageViewer_compMatte.js";
import * as OC from "./imageViewer_compOcio.js";
import * as LT from "./imageViewer_compLight.js";
import * as CH from "./imageViewer_compChannels.js";
import * as G3 from "./imageViewer_comp3d.js";
import * as DP from "./imageViewer_compDeep.js";
import * as PT from "./imageViewer_compPaint.js";
import * as WP from "./imageViewer_compWarp.js";
import * as EX from "./imageViewer_compExtra.js";
import * as E from "./imageViewer_compExpr.js";
import * as G from "./imageViewer_compGraph.js";
import { blank, blurImage, boxesForGauss } from "./imageViewer_compOps.js";
export { blank, blurImage, boxesForGauss, E, G };

export const COMP_VERSION = 1;
export const COMP_SUFFIX = ".comp.json";
export const MERGE_OPS = ["over", "under", "plus", "minus", "multiply", "screen", "max", "min", "difference",
    "in", "out", "atop", "mask", "stencil"];
export const FITS = ["fit", "fill", "none", "stretch"];
export const COLORSPACES = ["auto", "srgb", "linear"];

/**
 * The node types. `inputs` are the ports' names, in order (a Merge's B is input 0: the pipe runs through B).
 * A param: kind num | int | vec2 | color (linear RGBA) | enum | file | text; `key` = it can be animated.
 */
export const REFORMAT_TYPES = ["to format", "scale"];
export const MISSING_FRAMES = ["black", "hold", "error"];
export const WRITE_FORMATS = ["exr", "png", "tiff", "jpg", "mov", "mp4", "webm"];
export const WRITE_CHANNELS = ["rgba", "rgb", "all"];
export const WRITE_DEPTHS = ["half", "float", "8", "16"];
export const EXR_COMPRESSIONS = ["zip", "zips", "none"];
export const REFORMAT_RESIZE = ["none", "fit", "fill", "width", "height", "distort"];
export const VIEW_ANAGLYPH = ["colour", "grey"];
export const VIEW_LAYOUTS = ["side by side", "over under"];
export const NODE_TYPES = {
    read: { label: "Read", cat: "Image", inputs: [], params: {
        file: { kind: "file", def: "" },
        offset: { kind: "int", def: 0, help: "Frames to slide the footage by: +10 starts it 10 frames later" },
        colorspace: { kind: "ocio_cs", def: "auto", choices: COLORSPACES, help: "What the file holds. auto: EXR / HDR are linear, the rest sRGB; or any colourspace of the OCIO config, converted to the working space" },
        fit: { kind: "enum", def: "fit", choices: FITS, help: "How a picture of another size is laid into the comp" },
        missing: { kind: "enum", def: "black", choices: MISSING_FRAMES, help: "A frame of a sequence that is not on disk: black, the nearest frame there is (hold), or the render stops (error)" },
    } },
    constant: { label: "Constant", cat: "Image", inputs: [], params: {
        color: { kind: "color", def: [0, 0, 0, 1], key: true },
        write: { kind: "target", def: "rgba", label: "channel", help: "What it writes into: rgba (its whole picture, as before), one channel, or a layer (its r g b a); the rest of what comes in passes" },
    } },
    merge: { label: "Merge", cat: "Merge", inputs: ["B", "A", "mask"], params: {
        operation: { kind: "enum", def: "over", choices: MERGE_OPS },
        mix: { kind: "num", def: 1, min: 0, max: 1, step: 0.01, key: true },
    } },
    transform: { label: "Transform", cat: "Transform", inputs: ["src"], params: {
        translate: { kind: "vec2", def: [0, 0], key: true, step: 1 },
        rotate: { kind: "num", def: 0, key: true, step: 0.5 },
        scale: { kind: "vec2", def: [1, 1], key: true, step: 0.01 },
        skew: { kind: "vec2", def: [0, 0], key: true, step: 0.01, help: "Shear: x moves with y, then y with x" },
        center: { kind: "vec2", def: null, key: true, step: 1, help: "Empty: the middle of the picture that comes in" },
    } },
    grade: { label: "Grade", cat: "Color", inputs: ["src"], params: {
        blackpoint: { kind: "num", def: 0, key: true, step: 0.01 },
        whitepoint: { kind: "num", def: 1, key: true, step: 0.01 },
        lift: { kind: "num", def: 0, key: true, step: 0.01 },
        gain: { kind: "num", def: 1, key: true, step: 0.01 },
        multiply: { kind: "num", def: 1, key: true, step: 0.01 },
        offset: { kind: "num", def: 0, key: true, step: 0.01 },
        gamma: { kind: "num", def: 1, min: 0.01, key: true, step: 0.01 },
        saturation: { kind: "num", def: 1, min: 0, key: true, step: 0.01 },
        mix: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.01 },
    } },
    colorcorrect: { label: "ColorCorrect", cat: "Color", inputs: ["src"], params: ccParams() },
    ocio_colorspace: { label: "OCIOColorSpace", cat: "Color", inputs: ["src"], params: {
        in_space: { kind: "ocio_cs", def: "", help: "From (empty: the working space)" },
        out_space: { kind: "ocio_cs", def: "", help: "To (empty: the working space)" },
        unpremult: { kind: "enum", def: "on", choices: ["on", "off"], help: "Divide by the alpha first (and multiply again after)" },
    } },
    ocio_display: { label: "OCIODisplay", cat: "Color", inputs: ["src"], params: {
        in_space: { kind: "ocio_cs", def: "", help: "What the picture is in (empty: the working space)" },
        display: { kind: "ocio_display", def: "", help: "The display (empty: the config's default)" },
        view: { kind: "ocio_view", def: "", help: "The view (empty: the display's default)" },
        unpremult: { kind: "enum", def: "on", choices: ["on", "off"] },
    } },
    glow: { label: "Glow", cat: "Filter", inputs: ["src"], params: {
        threshold: { kind: "num", def: 0.8, key: true, step: 0.05, help: "Brighter than this glows" },
        softness: { kind: "num", def: 0.2, min: 0, key: true, step: 0.05, help: "Fully glowing this much above the threshold" },
        size: { kind: "num", def: 30, min: 0, max: 500, key: true, step: 1, help: "The widest blur, pixels of the comp" },
        steps: { kind: "int", def: 4, min: 1, max: 8, help: "Blurs stacked, each half the size of the one before" },
        intensity: { kind: "num", def: 1, min: 0, key: true, step: 0.05 },
        tint: { kind: "color", def: [1, 1, 1, 1] },
        source: { kind: "enum", def: "luminance", choices: LT.GLOW_SOURCES, help: "What brightness is measured on" },
        effect_only: { kind: "enum", def: "off", choices: ["off", "on"], help: "on: the glow alone" },
    } },
    lensflare: { label: "LensFlare", cat: "Draw", inputs: ["src", "dirt"], params: {
        position: { kind: "vec2", def: null, key: true, step: 1, help: "The light, pixels of the comp (empty: the middle)" },
        color: { kind: "color", def: [1, 0.85, 0.7, 1] },
        intensity: { kind: "num", def: 1, min: 0, key: true, step: 0.05 },
        size: { kind: "num", def: 1, min: 0.01, key: true, step: 0.05, help: "Everything's size, as a share of the frame's diagonal" },
        glow_amount: { kind: "num", def: 1, min: 0, key: true, step: 0.05 },
        glow_size: { kind: "num", def: 0.05, min: 0, key: true, step: 0.005 },
        streak_count: { kind: "int", def: 6, min: 0, max: 32, help: "Rays (the aperture's blades)" },
        streak_amount: { kind: "num", def: 0.3, min: 0, key: true, step: 0.05 },
        streak_length: { kind: "num", def: 0.4, min: 0, key: true, step: 0.01 },
        streak_width: { kind: "num", def: 2, min: 0.1, key: true, step: 0.1, help: "Pixels of the comp" },
        streak_angle: { kind: "num", def: 15, key: true, step: 1 },
        halo_amount: { kind: "num", def: 0.1, min: 0, key: true, step: 0.01, help: "A ring round the light, split into its colours" },
        halo_radius: { kind: "num", def: 0.25, min: 0, key: true, step: 0.01 },
        halo_width: { kind: "num", def: 0.015, min: 0.001, key: true, step: 0.001 },
        ghost_count: { kind: "int", def: 6, min: 0, max: 16, help: "Bokeh along the axis through the frame's middle" },
        ghost_amount: { kind: "num", def: 0.15, min: 0, key: true, step: 0.01 },
        ghost_size: { kind: "num", def: 0.04, min: 0, key: true, step: 0.005 },
        ghost_spread: { kind: "num", def: 1, key: true, step: 0.05 },
        ghost_shape: { kind: "enum", def: "polygon", choices: LT.GHOST_SHAPES },
        blades: { kind: "int", def: 6, min: 3, max: 16 },
        ghost_rotation: { kind: "num", def: 0, key: true, step: 1 },
        ghost_softness: { kind: "num", def: 0.3, min: 0, max: 1, key: true, step: 0.05 },
        dirt_amount: { kind: "num", def: 0, min: 0, key: true, step: 0.05, help: "Dust on the glass, lit by the light: the dirt input's brightness, or spots from the seed" },
        dirt_spots: { kind: "int", def: 120, min: 0, max: 1000 },
        dirt_reach: { kind: "num", def: 0.3, min: 0.01, key: true, step: 0.01, help: "How far the light reaches the dirt" },
        seed: { kind: "int", def: 1, help: "Another seed, other ghosts and dust" },
        write: { kind: "target", def: "rgba", label: "channel", help: "What it writes into: rgba (its whole picture, as before), one channel, or a layer (its r g b a); the rest of what comes in passes" },
    } },
    blur: { label: "Blur", cat: "Filter", inputs: ["src"], params: {
        size: { kind: "num", def: 10, min: 0, max: 500, key: true, step: 0.5, help: "In pixels of the comp" },
    } },
    reformat: { label: "Reformat", cat: "Transform", inputs: ["src"], params: {
        mode: { kind: "enum", def: "to format", choices: REFORMAT_TYPES, help: "to format: a picture of width x height; scale: the size that comes in times scale" },
        width: { kind: "int", def: null, min: 1, help: "The new picture's width (empty: the one that comes in)" },
        height: { kind: "int", def: null, min: 1, help: "The new picture's height (empty: the one that comes in)" },
        scale: { kind: "num", def: 1, min: 0.01, key: true, step: 0.05, help: "For mode scale" },
        resize: { kind: "enum", def: "fit", choices: REFORMAT_RESIZE, help: "How the picture fills the new one: fit inside, fill it, match its width or height, distort to it, or none (the same size)" },
        center: { kind: "enum", def: "on", choices: ["on", "off"], help: "off: the picture sits at the bottom left" },
        flip: { kind: "enum", def: "off", choices: ["off", "on"], help: "Upside down" },
        flop: { kind: "enum", def: "off", choices: ["off", "on"], help: "Mirrored left to right" },
        turn: { kind: "enum", def: "off", choices: ["off", "on"], help: "Turned 90 degrees anticlockwise first" },
    } },
    crop: { label: "Crop", cat: "Transform", inputs: ["src"], params: {
        topleft: { kind: "vec2", def: [0, 0], key: true, step: 1, help: "The box's top left corner, in pixels of the picture that comes in" },
        bottomright: { kind: "vec2", def: null, key: true, step: 1, help: "The box's bottom right corner. Empty: the picture's" },
        softness: { kind: "num", def: 0, min: 0, key: true, step: 0.5, help: "A soft edge this many pixels wide" },
    } },
    shuffle: { label: "Shuffle", cat: "Channel", inputs: ["src"], params: {
        out: { kind: "layer", def: "rgba", help: "The layer written: rgba, or a layer of extra channels (made if it is not there)" },
        r: { kind: "chan", def: "r", help: "Any channel of what comes in, 0, 1, or - (not written)" }, g: { kind: "chan", def: "g" },
        b: { kind: "chan", def: "b" }, a: { kind: "chan", def: "a" },
    } },
    addchannels: { label: "AddChannels", cat: "Channel", inputs: ["src"], params: {
        channels: { kind: "chanlist", def: "mask.a", help: "Channels or layers to add, commas between: mask.a, depth.z, or a layer name (its r g b a)" },
        value: { kind: "num", def: 0, step: 0.1, help: "What the new channels hold" },
    } },
    removechannels: { label: "Remove", cat: "Channel", inputs: ["src"], params: {
        operation: { kind: "enum", def: "remove", choices: ["remove", "keep"], help: "remove: the channels named go; keep: all others go (r g b a cannot go: they turn black)" },
        channels: { kind: "chanlist", def: "", help: "Channels or layers, commas between: mask, depth.z, rgba" },
    } },
    copy: { label: "Copy", cat: "Channel", inputs: ["B", "A"], params: {
        r: { kind: "enum", def: "B", choices: O.COPY_CHOICES }, g: { kind: "enum", def: "B", choices: O.COPY_CHOICES },
        b: { kind: "enum", def: "B", choices: O.COPY_CHOICES }, a: { kind: "enum", def: "A.a", choices: O.COPY_CHOICES, help: "B's channels, or one of A's" },
    } },
    erode: { label: "Erode/Dilate", cat: "Filter", inputs: ["src"], params: {
        size: { kind: "num", def: -1, min: -100, max: 100, key: true, step: 0.5, help: "Pixels of the comp: below 0 erodes (shrinks), above dilates (grows)" },
        shape: { kind: "enum", def: "box", choices: K.ERODE_SHAPES },
        channels: { kind: "enum", def: "rgba", choices: K.ERODE_CHANNELS },
    } },
    laplacian: { label: "Laplacian", cat: "Filter", inputs: ["src"], params: {
        mode: { kind: "enum", def: "laplacian", choices: K.LAPLACIAN_MODES, help: "laplacian: edges (of the picture blurred by size); highpass: the picture less its blur" },
        size: { kind: "num", def: 0, min: 0, max: 200, key: true, step: 0.5, help: "Blur size, pixels of the comp" },
        gain: { kind: "num", def: 1, key: true, step: 0.1 },
        offset: { kind: "num", def: 0, key: true, step: 0.05, help: "0.5 for a grey-centred result" },
    } },
    channelmerge: { label: "ChannelMerge", cat: "Channel", inputs: ["B", "A"], params: {
        a_channel: { kind: "enum", def: "a", choices: K.CM_CHANNELS },
        b_channel: { kind: "enum", def: "a", choices: K.CM_CHANNELS },
        operation: { kind: "enum", def: "union", choices: K.CM_OPS, help: "A's channel with B's: union is A + B - AB, stencil B(1 - A), out A(1 - B)" },
        output: { kind: "enum", def: "a", choices: K.CM_OUTPUTS, help: "B's channels the result goes into" },
        mix: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.01 },
    } },
    channelmath: { label: "ChannelMath", cat: "Channel", inputs: ["src"], params: {
        operation: { kind: "enum", def: "multiply", choices: K.MATH_OPS },
        value: { kind: "num", def: 1, key: true, step: 0.01, help: "The other number (clamp: the top; invert: what it is taken from)" },
        channels: { kind: "enum", def: "rgb", choices: K.CM_OUTPUTS },
        mix: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.01 },
    } },
    premult: { label: "Premult", cat: "Channel", inputs: ["src"], params: {} },
    unpremult: { label: "Unpremult", cat: "Channel", inputs: ["src"], params: {} },
    retime: { label: "Retime", cat: "Time", inputs: ["src"], params: {
        speed: { kind: "num", def: 1, step: 0.05, help: "2 plays twice as fast, 0.5 half as fast, -1 backwards" },
        start: { kind: "int", def: 0, help: "The frame that stays where it is" },
        offset: { kind: "num", def: 0, step: 1, help: "Frames to add to the input's frame" },
        blend: { kind: "enum", def: "nearest", choices: ["nearest", "mix", "vectors"], help: "Between frames: the nearest, the two mixed, or made from their motion (vectors)" },
    } },
    lumakeyer: { label: "LumaKeyer", cat: "Keyer", inputs: ["src"], params: {
        source: { kind: "enum", def: "luminance", choices: K.LUMA_SOURCES, help: "What brightness is measured on" },
        low: { kind: "num", def: 0.2, key: true, step: 0.01, help: "Transparent below this" },
        low_soft: { kind: "num", def: 0.1, min: 0, key: true, step: 0.01, help: "Solid from low + this" },
        high: { kind: "num", def: 10, key: true, step: 0.01, help: "Transparent again from here" },
        high_soft: { kind: "num", def: 0, min: 0, key: true, step: 0.01, help: "Over this much past high" },
        clip_black: { kind: "num", def: 0, min: 0, max: 1, key: true, step: 0.01, help: "The matte below this is 0" },
        clip_white: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.01, help: "The matte above this is 1" },
        invert: { kind: "enum", def: "off", choices: ["off", "on"] },
        output: { kind: "enum", def: "premultiplied", choices: ["premultiplied", "matte"], help: "matte: the matte as grey" },
        write: { kind: "target", def: "rgba", label: "channel", help: "What it writes into: rgba (its whole picture, as before), one channel, or a layer (its r g b a); the rest of what comes in passes" },
    } },
    chromakeyer: { label: "ChromaKeyer", cat: "Keyer", inputs: ["src"], params: {
        screen: { kind: "color", def: [0.1, 0.55, 0.1, 1], help: "The screen's colour: ⌖ takes it from the picture" },
        screen_gain: { kind: "num", def: 1, min: 0, key: true, step: 0.05, help: "Above 1 takes more as screen" },
        clip_black: { kind: "num", def: 0, min: 0, max: 1, key: true, step: 0.01, help: "The matte below this is 0: cleans the screen" },
        clip_white: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.01, help: "The matte above this is 1: firms up the subject" },
        despill: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.05, help: "How much of the screen's spill is taken out" },
        despill_limit: { kind: "enum", def: "max", choices: K.DESPILL_LIMITS, help: "The screen channel is held to the larger, or the mean, of the other two" },
        invert: { kind: "enum", def: "off", choices: ["off", "on"] },
        output: { kind: "enum", def: "premultiplied", choices: K.KEY_OUTPUTS, help: "matte: the matte as grey; despilled: despill only" },
        write: { kind: "target", def: "rgba", label: "channel", help: "What it writes into: rgba (its whole picture, as before), one channel, or a layer (its r g b a); the rest of what comes in passes" },
    } },
    keyer: { label: "Keyer", cat: "Keyer", inputs: ["src"], params: {
        mode: { kind: "enum", def: "chroma", choices: O.KEYER_MODES },
        screen: { kind: "color", def: [0.1, 0.55, 0.1, 1], key: true, help: "The screen's colour (chroma)" },
        tolerance: { kind: "num", def: 0.3, min: 0, key: true, step: 0.01, help: "Up to here it is keyed out" },
        softness: { kind: "num", def: 0.3, min: 0, key: true, step: 0.01, help: "Over this much more it becomes solid" },
        despill: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.05, help: "Takes the screen's colour out of the edges (chroma)" },
        write: { kind: "target", def: "rgba", label: "channel", help: "What it writes into: rgba (its whole picture, as before), one channel, or a layer (its r g b a); the rest of what comes in passes" },
    } },
    roto: { label: "Roto", cat: "Draw", inputs: ["src"], params: {
        roto: { kind: "roto", def: null, help: "The shapes: drawn and edited on the picture with the viewer's Roto tool" },
        write: { kind: "target", def: "rgba", label: "channel", help: "What it writes into: rgba (its whole picture, as before), one channel, or a layer (its r g b a); the rest of what comes in passes" },
        premult: { kind: "enum", def: "on", choices: ["on", "off"], help: "on: what comes in is multiplied by the matte (cut out); off: it stays as it is, the matte only written" },
    } },
    paint: { label: "Paint", cat: "Draw", inputs: ["src", "reveal"], params: {
        strokes: { kind: "strokes", def: [], help: "The strokes: painted on the picture while this node is in the Parameters panel" },
    } },
    vectors: { label: "Vectors", cat: "Time", inputs: ["src"], params: {
        smoothness: { kind: "num", def: 0.04, min: 0.001, max: 1, step: 0.005, help: "Higher: smoother, less detailed motion" },
        iterations: { kind: "int", def: 30, min: 1, max: 200, help: "More: slower, more exact" },
        levels: { kind: "int", def: 4, min: 1, max: 8, help: "More: finds larger motion" },
        detail: { kind: "enum", def: "half", choices: Object.keys(O.FLOW_DETAIL), help: "The picture the motion is measured on: smaller is much faster" },
        write: { kind: "target", def: "rgba", label: "channel", help: "What it writes into: rgba (its whole picture, as before), one channel, or a layer (its r g b a); the rest of what comes in passes" },
    } },
    motionblur: { label: "MotionBlur", cat: "Filter", inputs: ["src", "vectors"], params: {
        shutter: { kind: "num", def: 0.5, min: 0, max: 2, key: true, step: 0.05, help: "How long the shutter is open, in frames" },
        samples: { kind: "int", def: 10, min: 1, max: 64, help: "Pictures averaged along the motion" },
        offset: { kind: "enum", def: "centred", choices: O.SHUTTER_OFFSETS, help: "Where the shutter opens around the frame" },
    } },
    depthblur: { label: "DepthBlur", cat: "Filter", inputs: ["src", "depth"], params: {
        channel: { kind: "enum", def: "r", choices: O.DEPTH_CHANNELS, help: "Where the depth map holds the depth" },
        focus: { kind: "num", def: 0.5, key: true, step: 0.01, help: "The depth in focus" },
        dof: { kind: "num", def: 0.05, min: 0, key: true, step: 0.01, help: "How deep the sharp part is" },
        falloff: { kind: "num", def: 0.3, min: 0.001, key: true, step: 0.01, help: "How much further it takes to reach the full blur" },
        size: { kind: "num", def: 20, min: 0, max: 200, key: true, step: 0.5, help: "The fullest blur, as Blur's size" },
        layers: { kind: "int", def: 6, min: 2, max: 16, help: "Blur sizes between none and the fullest: more is smoother and slower" },
        filter: { kind: "enum", def: "gaussian", choices: ["gaussian", "lens"], help: "lens: a disc, as Defocus (size is then its diameter)" },
    } },
    defocus: { label: "Defocus", cat: "Filter", inputs: ["src"], params: {
        size: { kind: "num", def: 20, min: 0, max: 400, key: true, step: 0.5, help: "The aperture's diameter, in pixels of the comp" },
        shape: { kind: "enum", def: "disc", choices: O.DEFOCUS_SHAPES },
        blades: { kind: "int", def: 6, min: 3, max: 16, help: "The aperture's sides (polygon)" },
        rotation: { kind: "num", def: 0, key: true, step: 1, help: "The aperture turned, in degrees (polygon)" },
        aspect: { kind: "num", def: 1, min: 0.1, max: 10, key: true, step: 0.05, help: "Above 1 wider, as an anamorphic lens" },
        threshold: { kind: "num", def: 1, min: 0, key: true, step: 0.05, help: "Brighter than this is a highlight" },
        bloom: { kind: "num", def: 0, min: 0, key: true, step: 0.1, help: "How much brighter the highlights' bokeh gets" },
    } },
    // ── 3D (imageViewer_comp3d.js): geometry and cameras are not pictures; Render 3D makes one ──
    camera3d: { label: "Camera", cat: "3D", inputs: [], params: {
        translate: { kind: "vec3", def: [0, 0, 2], key: true, step: 0.01, help: "Where it stands, in scene units (y up)" },
        rotate: { kind: "vec3", def: [0, 0, 0], key: true, step: 0.5, help: "Its turn in degrees about x, then y, then z; it looks down its own -z" },
        focal: { kind: "num", def: 35, min: 1, max: 2000, key: true, step: 0.5, help: "Focal length, mm" },
        haperture: { kind: "num", def: 36, min: 0.1, max: 200, key: true, step: 0.1, label: "film back", help: "The film back's width, mm (36: full frame); the height follows from the picture's shape" },
        near: { kind: "num", def: 0.01, min: 0.0001, step: 0.01, help: "Nothing nearer than this is drawn" },
        far: { kind: "num", def: 100000, min: 0.001, step: 1, help: "Nothing further than this is drawn" },
        interaxial: { kind: "num", def: 0.065, min: 0, key: true, step: 0.005, help: "Stereo (a comp with views): the distance between the eyes, in scene units" },
        convergence: { kind: "num", def: 3, min: 0.001, key: true, step: 0.05, help: "Stereo: the distance at which the eyes' pictures meet (an off-axis pair)" },
    } },
    card3d: { label: "Card", cat: "3D", inputs: ["img"], params: {
        translate: { kind: "vec3", def: [0, 0, 0], key: true, step: 0.01 },
        rotate: { kind: "vec3", def: [0, 0, 0], key: true, step: 0.5, help: "Degrees about x, then y, then z" },
        scale: { kind: "vec3", def: [1, 1, 1], key: true, step: 0.01 },
        uniform: { kind: "num", def: 1, min: 0, key: true, step: 0.01, help: "The card is one unit wide times this; its height follows the picture's shape" },
    } },
    geo3d: { label: "Shape", cat: "3D", inputs: ["img"], params: {
        shape: { kind: "enum", def: "cube", choices: G3.SHAPES, help: "One unit across; the picture wraps it (no picture: white)" },
        divisions: { kind: "int", def: 24, min: 3, max: 128, help: "Segments around a sphere or a cylinder" },
        translate: { kind: "vec3", def: [0, 0, 0], key: true, step: 0.01 },
        rotate: { kind: "vec3", def: [0, 0, 0], key: true, step: 0.5, help: "Degrees about x, then y, then z" },
        scale: { kind: "vec3", def: [1, 1, 1], key: true, step: 0.01 },
        uniform: { kind: "num", def: 1, min: 0, key: true, step: 0.01 },
    } },
    project3d: { label: "Project", cat: "3D", inputs: ["img", "camera"], params: {
        faces: { kind: "enum", def: "both", choices: G3.PROJECT_FACES, help: "front: only surfaces facing the projecting camera take the picture" },
    } },
    scene3d: { label: "Scene", cat: "3D", inputs: ["1", "2", "3", "4"], params: {} },
    pointcloud: { label: "PointCloud", cat: "3D", inputs: ["img", "camera"], params: {
        channel: { kind: "chan", def: "depth.z", help: "Where the picture holds its depth" },
        mode: { kind: "enum", def: "distance", choices: G3.DEPTH_MODES, help: "distance: the depth is the distance along the camera's view; inverse: it is 1 / distance" },
        multiply: { kind: "num", def: 1, min: 0, key: true, step: 0.01, help: "The depth times this (inverse: this over the depth)" },
        step: { kind: "int", def: 2, min: 1, max: 64, help: "A point every this many pixels" },
        size: { kind: "num", def: 2, min: 0.1, max: 64, key: true, step: 0.1, help: "A point's width when rendered, in pixels" },
    } },
    render3d: { label: "Render3D", cat: "3D", inputs: ["scene", "camera", "bg"], params: {
        samples: { kind: "int", def: 2, min: 1, max: 4, help: "Samples a pixel each way (antialiasing): 2 is 4 a pixel" },
        depth: { kind: "enum", def: "depth.z", choices: G3.DEPTH_OUT, help: "depth.z: the distance to the nearest surface goes into the depth.z channel (0: nothing)" },
    } },
    // ── deep (imageViewer_compDeep.js): any number of samples a pixel; viewed, a deep node shows itself flattened ──
    deepread: { label: "DeepRead", cat: "Deep", inputs: [], params: {
        file: { kind: "file", def: "" },
        offset: { kind: "int", def: 0, help: "Frames to slide the footage by" },
    } },
    deepfromimage: { label: "DeepFromImage", cat: "Deep", inputs: ["img"], params: {
        channel: { kind: "chan", def: "depth.z", help: "Each pixel's depth (where it is 0 or missing: z)" },
        z: { kind: "num", def: 1, min: 0, key: true, step: 0.01, help: "The depth of pixels without one" },
    } },
    deepmerge: { label: "DeepMerge", cat: "Deep", inputs: ["1", "2", "3", "4"], params: {} },
    deepholdout: { label: "DeepHoldout", cat: "Deep", inputs: ["src", "holdout"], params: {} },
    deepcrop: { label: "DeepCrop", cat: "Deep", inputs: ["deep"], params: {
        znear: { kind: "num", def: 0, min: 0, key: true, step: 0.01, help: "Samples nearer than this go" },
        zfar: { kind: "num", def: 0, min: 0, key: true, step: 0.01, help: "Samples further than this go (0: no far limit)" },
        outside: { kind: "enum", def: "off", choices: ["off", "on"], help: "on: keep what is outside the range instead" },
    } },
    deepflatten: { label: "DeepFlatten", cat: "Deep", inputs: ["deep"], params: {} },
    // ── views (stereo and more): the comp's format.views; Reads with %V in their name read one file per view ──
    oneview: { label: "OneView", cat: "Views", inputs: ["src"], params: {
        view: { kind: "view", def: "", help: "The view everything above is made in (empty: the comp's first)" },
    } },
    joinviews: { label: "JoinViews", cat: "Views", inputs: ["v1", "v2", "v3", "v4"], params: {} },
    anaglyph: { label: "Anaglyph", cat: "Views", inputs: ["src"], params: {
        mode: { kind: "enum", def: "colour", choices: VIEW_ANAGLYPH, help: "Red from the first view, green and blue from the second; grey: each eye as grey first" },
    } },
    sidebyside: { label: "SideBySide", cat: "Views", inputs: ["src"], params: {
        layout: { kind: "enum", def: "side by side", choices: VIEW_LAYOUTS, help: "The first two views next to each other (left first) or above each other (left on top)" },
    } },
    write: { label: "Write", cat: "Other", inputs: ["src"], params: {
        file: { kind: "outfile", def: "", help: "Where it writes: shot.####.exr (one # per digit), or a film. Relative: beside the comp. Empty: <comp>_<name>/<name>.####.<type> beside the comp" },
        file_type: { kind: "enum", def: "exr", choices: WRITE_FORMATS, label: "type", help: "The file type (a path's own ending wins)" },
        channels: { kind: "enum", def: "rgba", choices: WRITE_CHANNELS, help: "all: every extra channel too, as layers of one multi-layer EXR" },
        depth: { kind: "enum", def: "half", choices: WRITE_DEPTHS, help: "EXR: half or float; PNG / TIFF: 8 or 16 bits (TIFF float: 32 float)" },
        compression: { kind: "enum", def: "zip", choices: EXR_COMPRESSIONS, help: "EXR compression (lossless)" },
        colorspace: { kind: "ocio_cs", def: "", help: "A float file (EXR) is written in this colourspace; empty: the working space" },
        display: { kind: "ocio_display", def: "", help: "PNG / TIFF / JPEG / films: encoded for this display; empty: plain sRGB" },
        view: { kind: "ocio_view", def: "" },
        first: { kind: "int", def: null, help: "The first comp frame it writes; empty: 0" },
        last: { kind: "int", def: null, help: "The last comp frame it writes; empty: the comp's last" },
        handles: { kind: "int", def: 0, min: 0, max: 1000, help: "Extra frames written before the first and after the last" },
        first_number: { kind: "int", def: 1001, min: 0, label: "frame 0 is", help: "The file number of comp frame 0 (a handle before it gets a lower number)" },
        padding: { kind: "int", def: 4, min: 1, max: 9, help: "Digits of the frame number when the path has no #" },
        timecode: { kind: "text", def: "", help: "Timecode of comp frame 0, HH:MM:SS:FF; empty: the footage's own, else none" },
        metadata: { kind: "enum", def: "on", choices: ["on", "off"], help: "Write the metadata that arrives (and the comp's own) into EXR headers" },
    } },
    metadata: { label: "Metadata", cat: "Other", inputs: ["src"], params: {
        set: { kind: "text", def: "", help: "key = value; key2 = value - set or replaced on the way down" },
        remove: { kind: "text", def: "", help: "Keys taken off (comma separated; * at the end matches a start: exr/*)" },
    } },
    cornerpin: { label: "CornerPin", cat: "Transform", inputs: ["src"], params: {
        to1: { kind: "vec2", def: null, key: true, step: 1, help: "Where the bottom left corner goes, pixels of the picture that comes in (empty: where it is)" },
        to2: { kind: "vec2", def: null, key: true, step: 1, help: "Where the bottom right corner goes" },
        to3: { kind: "vec2", def: null, key: true, step: 1, help: "Where the top right corner goes" },
        to4: { kind: "vec2", def: null, key: true, step: 1, help: "Where the top left corner goes" },
        from1: { kind: "vec2", def: null, key: true, step: 1, help: "The four points that are pinned (empty: the picture's corners): bottom left" },
        from2: { kind: "vec2", def: null, key: true, step: 1, help: "bottom right" },
        from3: { kind: "vec2", def: null, key: true, step: 1, help: "top right" },
        from4: { kind: "vec2", def: null, key: true, step: 1, help: "top left" },
        invert: { kind: "enum", def: "off", choices: ["off", "on"], help: "on: the other way, the 'to' points back onto the 'from' ones (to flatten a surface)" },
    } },
    stmap: { label: "STMap", cat: "Transform", inputs: ["src", "stmap"], params: {
        u: { kind: "chan", def: "r", help: "The map's channel that says where across to read (0 left, 1 right)" },
        v: { kind: "chan", def: "g", help: "The map's channel that says where up to read (0 bottom, 1 top)" },
    } },
    vectorwarp: { label: "VectorWarp", cat: "Transform", inputs: ["src", "vectors"], params: {
        u: { kind: "chan", def: "r", help: "The channel with the motion across, pixels of the comp (Vectors: r forward, b backward)" },
        v: { kind: "chan", def: "g", help: "The channel with the motion down (Vectors: g forward, a backward)" },
        amount: { kind: "num", def: 1, key: true, step: 0.05, help: "Each pixel is read this many vectors away: 1 pulls the next frame's picture to this one, -1 the other way" },
    } },
    lensdistortion: { label: "LensDistortion", cat: "Transform", inputs: ["src"], params: {
        mode: { kind: "enum", def: "undistort", choices: WP.LENS_MODES, help: "undistort: straighten the plate; redistort: bend a straight picture back into the plate's lens" },
        k1: { kind: "num", def: 0, key: true, step: 0.001, help: "Barrel below 0, pincushion above, at the corners (the radius is a share of half the diagonal)" },
        k2: { kind: "num", def: 0, key: true, step: 0.001, help: "The same, growing faster towards the corners" },
        center: { kind: "vec2", def: null, key: true, step: 1, help: "The lens's centre (empty: the middle of the picture)" },
        zoom: { kind: "num", def: 1, min: 0.1, max: 10, key: true, step: 0.01, help: "Scales the result about the centre: above 1 hides the edges the warp pulls in" },
        output: { kind: "enum", def: "image", choices: WP.LENS_OUTPUTS, help: "stmap: the warp itself as an ST map (u, v), for writing out and using in an STMap" },
        lines: { kind: "lines", def: null, help: "Lines along things that are straight, drawn on the plate: Solve finds k1 and k2 from them" },
    } },
    gridwarp: { label: "GridWarp", cat: "Transform", inputs: ["src"], params: {
        cols: { kind: "int", def: 5, min: 2, max: 16, help: "Points across" },
        rows: { kind: "int", def: 5, min: 2, max: 16, help: "Points down" },
        src_points: { kind: "points", def: null, help: "The source grid (empty: even over the picture); Shift + drag a point on the picture" },
        dst_points: { kind: "points", def: null, key: true, help: "Where each point of the grid goes; drag them on the picture" },
        distortion: { kind: "num", def: 1, min: 0, max: 1, key: true, step: 0.01, help: "0: as it is, 1: the full warp (keyed: a warp over time, half of a morph)" },
    } },
    tracker: { label: "Tracker", cat: "Transform", inputs: ["src"], params: {
        points: { kind: "trackpoints", def: null, help: "The tracked points: placed and tracked on the picture" },
        motion: { kind: "enum", def: "translate", choices: WP.TRACK_MOTIONS, help: "What the points solve for: a move; with two or more a turn and a scale too; with four a perspective (corner pin)" },
        transform: { kind: "enum", def: "none", choices: WP.TRACK_TRANSFORMS, help: "What this node does to its picture: nothing (it only tracks), hold it still, or move it as the points move" },
        reference: { kind: "int", def: 0, help: "The frame where the picture stays as it is" },
    } },
    planartracker: { label: "PlanarTracker", cat: "Transform", inputs: ["src"], params: {
        plane: { kind: "plane", def: null, help: "The surface tracked: four corners placed on the picture, then tracked" },
        transform: { kind: "enum", def: "none", choices: WP.TRACK_TRANSFORMS, help: "What this node does to its picture: nothing, flatten the surface's motion away, or move the picture with it" },
        reference: { kind: "int", def: 0, help: "The frame where the picture stays as it is" },
    } },
    output: { label: "Output", cat: "Other", inputs: ["src"], params: {} },
    // The graph's own (imageViewer_compGraph.js): no pixels of their own. A group's ports are its Input nodes.
    dot: { label: "Dot", cat: "Graph", inputs: ["src"], params: {} },
    group: { label: "Group", cat: "Graph", inputs: [], params: {} },
    group_input: { label: "Input", cat: "Graph", inputs: [], params: {} },
    group_output: { label: "GroupOutput", cat: "Graph", inputs: ["src"], params: {} },
    backdrop: { label: "Backdrop", cat: "Graph", inputs: [], params: {} },
    sticky: { label: "StickyNote", cat: "Graph", inputs: [], params: {} },
};
/**
 * Nodes that take a MASK and a mix on top of what they do: the last input is "mask", and the result is
 * in + (result - in) x mix x the mask's channel (`maskMix`). Nodes that change the size, the time or only
 * make a picture are left out; a node with a mix of its own keeps it (the mask then multiplies that).
 */
export const MASKABLE = new Set(["grade", "colorcorrect", "ocio_colorspace", "ocio_display", "glow", "lensflare", "blur",
    "shuffle", "copy", "erode", "laplacian", "channelmerge", "channelmath", "premult", "unpremult", "lumakeyer", "chromakeyer",
    "keyer", "motionblur", "depthblur", "defocus"]);
/** MASKABLE nodes whose own arithmetic already takes `mix` (the mask stage then does not apply it twice). */
export const OWN_MIX = new Set([...MASKABLE].filter((t) => NODE_TYPES[t].params.mix));
for (const t of MASKABLE) maskable(t);
function maskable(t) {
    const d = NODE_TYPES[t];
    d.inputs = [...d.inputs, "mask"];
    if (!d.params.mix) d.params.mix = { kind: "num", def: 1, min: 0, max: 1, step: 0.01, key: true, help: "How much of the result: 0 is what comes in" };
    d.params.mask_channel = { kind: "chan", def: "a", from: "mask", label: "mask channel", help: "The mask input's channel that says where the node acts" };
    d.params.mask_invert = { kind: "enum", def: "off", choices: ["off", "on"], label: "invert mask" };
}
/** The index of a MASKABLE node's mask input (-1 for the rest). */
export function maskIndex(type) { return MASKABLE.has(type) ? NODE_TYPES[type].inputs.length - 1 : -1; }
export const TYPE_ORDER = ["read", "constant", "roto", "paint", "merge", "copy", "transform", "reformat", "crop", "cornerpin", "tracker", "planartracker", "stmap", "vectorwarp", "lensdistortion", "gridwarp", "grade", "colorcorrect", "ocio_colorspace", "ocio_display", "keyer", "lumakeyer", "chromakeyer", "blur", "glow", "erode", "laplacian",
    "motionblur", "depthblur", "defocus", "lensflare", "shuffle", "addchannels", "removechannels", "channelmerge", "channelmath", "premult", "unpremult", "retime", "vectors", "metadata", "write",
    "camera3d", "card3d", "geo3d", "project3d", "scene3d", "pointcloud", "render3d",
    "deepread", "deepfromimage", "deepmerge", "deepholdout", "deepcrop", "deepflatten",
    "oneview", "joinviews", "anaglyph", "sidebyside", "output",
    "dot", "group", "group_input", "group_output", "backdrop", "sticky"];
/** Nodes that hand their input on unchanged: what they do is outside the pixels (a file written, metadata). */
export const PASS_THROUGH = new Set(["output", "write", "metadata"]);
// The finishing nodes (keying, time, colour, filters, AI) are in imageViewer_compExtra.js.
Object.assign(NODE_TYPES, EX.EXTRA_TYPES);
for (const t of EX.EXTRA_MASKABLE) { MASKABLE.add(t); if (NODE_TYPES[t].params.mix) OWN_MIX.add(t); maskable(t); }
TYPE_ORDER.splice(TYPE_ORDER.indexOf("metadata"), 0, ...EX.EXTRA_ORDER);
/** Nodes whose result is kept between renders (keyed by their whole upstream): they take long. */
export const HEAVY = new Set(["vectors", "motionblur", "depthblur", "defocus", ...EX.EXTRA_HEAVY]);
export const NODE_W = 120;
export const NODE_H = 30;

// ── the graph's grid ────────────────────────────────────────────────────────
/** The node graph's grid, in graph units: a node is 8 cells wide and 2 high. */
export const GRID = 15;
export const snapTo = (v, g = GRID) => Math.round(v / g) * g;
export const ALIGNS = ["grid", "left", "centre", "right", "top", "middle", "bottom", "hspace", "vspace"];
/**
 * Lines the nodes ``ids`` up, in place; returns how many moved. "grid": each onto the grid. "left" / "centre" /
 * "right": one column by their left edges, middles or right edges (the leftmost / the mean / the rightmost);
 * "top" / "middle" / "bottom" the same as a row. "hspace" / "vspace": the first and the last stay, the ones between
 * spread evenly. With ``snap`` the result lands on the grid too. Aligning needs two nodes, spreading three.
 */
export function alignNodes(comp, ids, how, { snap = false, g = GRID } = {}) {
    const ns = ids.map((id) => nodeById(comp, id)).filter(Boolean);
    const before = ns.map((n) => [n.x, n.y]);
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const put = (n, k, v) => { n[k] = Math.round(snap ? snapTo(v, g) : v); };
    if (how === "grid") for (const n of ns) { put(n, "x", snapTo(n.x, g)); put(n, "y", snapTo(n.y, g)); }
    else if (ns.length >= 2 && ["left", "centre", "right"].includes(how)) {
        const x = how === "left" ? Math.min(...ns.map((n) => n.x)) : how === "right" ? Math.max(...ns.map((n) => n.x)) : mean(ns.map((n) => n.x));
        for (const n of ns) put(n, "x", x);
    } else if (ns.length >= 2 && ["top", "middle", "bottom"].includes(how)) {
        const y = how === "top" ? Math.min(...ns.map((n) => n.y)) : how === "bottom" ? Math.max(...ns.map((n) => n.y)) : mean(ns.map((n) => n.y));
        for (const n of ns) put(n, "y", y);
    } else if (ns.length >= 3 && (how === "hspace" || how === "vspace")) {
        const k = how === "hspace" ? "x" : "y";
        const order = [...ns].sort((a, b) => a[k] - b[k]);
        const a = order[0][k], b = order[order.length - 1][k];
        order.forEach((n, i) => { if (i > 0 && i < order.length - 1) put(n, k, a + ((b - a) * i) / (order.length - 1)); });
    }
    return ns.filter((n, i) => n.x !== before[i][0] || n.y !== before[i][1]).length;
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// ── documents ────────────────────────────────────────────────────────────────

export function isCompPath(p) { return typeof p === "string" && p.toLowerCase().endsWith(COMP_SUFFIX); }

/** A new comp: a Constant into an Output, ready for a Read to be merged over it. */
export function newComp({ width = 1920, height = 1080, fps = 24, frames = 48 } = {}) {
    const comp = { comp: COMP_VERSION, format: { width, height, fps, frames }, nodes: [], output: "Output1" };
    const bg = addNode(comp, makeNode(comp, "constant", { x: 0, y: 0, color: [0, 0, 0, 1], name: "Background" }));
    addNode(comp, makeNode(comp, "output", { x: 0, y: 200, inputs: [bg.id] }));
    return comp;
}

/** The comp a file holds, with defaults filled in and what cannot be used dropped: {comp, errors}. */
export function normalizeComp(raw) {
    const errors = [];
    if (!isObj(raw) || raw.comp !== COMP_VERSION) return { comp: newComp(), errors: ["not a comp (it needs \"comp\": 1)"] };
    const f = isObj(raw.format) ? raw.format : {};
    const int = (v, d, lo, hi) => (isNum(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
    const comp = {
        comp: COMP_VERSION,
        format: { width: int(f.width, 1920, 4, 16384), height: int(f.height, 1080, 4, 16384), fps: isNum(f.fps) && f.fps > 0 ? f.fps : 24,
            frames: int(f.frames, 48, 1, 100000) },
        nodes: [],
        output: typeof raw.output === "string" ? raw.output : null,
    };
    comp.nodes = normalizeLevel(raw.nodes, errors, "", 0);
    if (!comp.output || !nodeById(comp, comp.output) || nodeById(comp, comp.output).type !== "output") {
        const o = comp.nodes.find((n) => n.type === "output");
        comp.output = o ? o.id : null;
    }
    const views = cleanViews(f.views);
    if (views.length) comp.format.views = views;
    return { comp, errors };
}

// ── views (stereo, multi-view) ───────────────────────────────────────────────
// A comp with format.views (two or more names, the first is "left" of a stereo pair) is made once per view.
// A Read whose file names %V (the view) or %v (its first letter) reads one file per view; a node's `split`
// ({view: {param: value, tracks?}}) gives it other settings in that view; a Camera's eyes move apart by its
// interaxial. renderNode's ctx.view is the view made (null: the comp has none, or the first).
export const VIEW_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const STEREO_VIEWS = ["left", "right"];
/** Two or more distinct view names, or [] (a comp without views). */
export function cleanViews(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) if (typeof x === "string" && VIEW_NAME.test(x) && !out.includes(x) && out.length < 16) out.push(x);
    return out.length >= 2 ? out : [];
}
export const viewsOf = (comp) => (comp && comp.format && Array.isArray(comp.format.views) ? comp.format.views : []);
/** A file name in a view: %V is the view's name, %v its first letter. */
export function viewFile(file, view) {
    if (typeof file !== "string" || !view) return file;
    return file.replace(/%V/g, view).replace(/%v/g, view[0]);
}
/** A node as it is in `view`: its split settings over it and a Read's %V named. The node itself when nothing differs. */
export function viewNode(n, view) {
    if (!n || !view) return n;
    const sp = isObj(n.split) && isObj(n.split[view]) ? n.split[view] : null;
    const file = typeof n.file === "string" && /%[Vv]/.test(n.file) ? viewFile(n.file, view) : null;
    if (!sp && file === null) return n;
    const out = Object.assign({}, n);
    if (sp) for (const [k, v] of Object.entries(sp)) if (k !== "id" && k !== "type" && k !== "inputs") out[k] = v;
    if (file !== null) { out.file = file; out.__view = view; }
    return out;
}
/** The key a page keeps a Read's pixels under (a per-view Read's per view). */
export const srcKey = (n, f) => `${n.id}@${f}${n.__view ? "#" + n.__view : ""}`;
/** How far a camera's eye moves along its x in `view`: the views spread evenly about the middle, interaxial apart. */
export function eyeOffset(comp, view, interaxial) {
    const vs = viewsOf(comp), i = view ? vs.indexOf(view) : -1;
    if (vs.length < 2 || i < 0) return 0;
    return (i - (vs.length - 1) / 2) * interaxial;
}
/** The view made when none is asked for: the comp's first, or null. */
export const firstView = (comp) => viewsOf(comp)[0] || null;

/** The comp's Write nodes, in graph order. */
export function writeNodes(comp) { return (comp && G.flattenComp(comp).nodes || []).filter((n) => n.type === "write"); }

/** The Reads a comp names (for relinking and localising): [{id, name, file, local}]. */
export function readNodes(comp) {
    return (comp && comp.nodes || []).filter((n) => n.type === "read" && n.file).map((n) => ({ id: n.id, name: n.name || n.id, file: n.file, local: n.local || "" }));
}

/** One graph's nodes (the comp's, or a group's), checked: known types, ids of their own, inputs that exist, no loops. */
const MAX_GROUP_DEPTH = 16;
function normalizeLevel(raw, errors, where, depth) {
    const seen = new Set(), nodes = [];
    for (const n of Array.isArray(raw) ? raw : []) {
        if (!isObj(n) || !NODE_TYPES[n.type]) { errors.push(`${where}a node of unknown type ${isObj(n) ? n.type : n} was left out`); continue; }
        if (typeof n.id !== "string" || !n.id || seen.has(n.id)) { errors.push(`${where}a ${n.type} node without its own id was left out`); continue; }
        if (n.type === "group" && depth >= MAX_GROUP_DEPTH) { errors.push(`${where}${n.id}: groups go ${MAX_GROUP_DEPTH} deep at most`); continue; }
        seen.add(n.id);
        const node = clone(n);
        node.x = isNum(n.x) ? n.x : 0; node.y = isNum(n.y) ? n.y : 0;
        if (n.type === "group") {
            node.nodes = normalizeLevel(n.nodes, errors, `${where}${n.id}/`, depth + 1);
            G.groupInputs(node).forEach((x, k) => { x.index = k; });
        } else delete node.nodes;
        const ins = Array.isArray(n.inputs) ? n.inputs : [];
        node.inputs = inputsOf(node).map((_, i) => (typeof ins[i] === "string" ? ins[i] : null));
        if (node.tracks && !isObj(node.tracks)) delete node.tracks;
        if (node.expr !== undefined && !isObj(node.expr)) delete node.expr;
        // A layer's length: whole frames, out after in (a Merge's only).
        for (const k of ["in", "out"]) { if (node.type !== "merge" || !isNum(node[k])) delete node[k]; else node[k] = Math.round(node[k]); }
        if (isNum(node.in) && isNum(node.out) && node.out <= node.in) { errors.push(`${where}${node.id}: its out was not after its in and was taken off`); delete node.out; }
        nodes.push(node);
    }
    const level = { nodes };
    for (const n of nodes) n.inputs = n.inputs.map((id) => (id && seen.has(id) && id !== n.id && !G.GRAPH_ONLY.has(nodeById(level, id).type) ? id : null));
    // Cycles are not a picture: the input that closes one goes.
    for (const n of nodes) n.inputs = n.inputs.map((id, i) => {
        if (!id) return null;
        n.inputs[i] = null;
        const bad = reaches(level, id, n.id);
        if (bad) errors.push(`${where}${n.id}: an input that made a loop was taken off`);
        return bad ? null : id;
    });
    return nodes;
}

/** A node's ports' names: its type's, or a group's Input nodes'. */
export function inputsOf(n) {
    if (!n) return [];
    if (n.type === "group") return G.groupInputs(n).map((x) => x.name || x.id);
    return (NODE_TYPES[n.type] || { inputs: [] }).inputs;
}

export function nodeById(comp, id) { return (comp && comp.nodes || []).find((n) => n.id === id) || null; }

export function uniqueId(comp, base) {
    const have = new Set((comp.nodes || []).map((n) => n.id));
    let k = 1;
    while (have.has(`${base}${k}`)) k++;
    return `${base}${k}`;
}

/** A new node of `type` (not yet in the comp). */
export function makeNode(comp, type, extra = {}) {
    const t = NODE_TYPES[type];
    if (!t) throw new Error(`unknown node type ${type}`);
    const node = { id: uniqueId(comp, t.label), type, x: 0, y: 0, inputs: t.inputs.map(() => null) };
    for (const [p, d] of Object.entries(t.params)) if (d.def !== null) node[p] = clone(d.def);
    Object.assign(node, clone(extra));
    // A new group holds an Input wired to its Output: it passes its picture until something goes between them.
    if (type === "group" && !Array.isArray(node.nodes)) node.nodes = [
        { id: "Input1", type: "group_input", index: 0, x: 0, y: 0, inputs: [] },
        { id: "GroupOutput1", type: "group_output", x: 0, y: 150, inputs: ["Input1"] }];
    if (type === "backdrop") { node.w = node.w || 360; node.h = node.h || 240; }
    if (type === "sticky") { node.w = node.w || 180; node.h = node.h || 90; if (node.text === undefined) node.text = ""; }
    node.inputs = inputsOf(node).map((_, i) => (extra.inputs && extra.inputs[i]) || null);
    return node;
}

export function addNode(comp, node) {
    comp.nodes.push(node);
    if (node.type === "output" && !comp.output) comp.output = node.id;
    return node;
}

/** The nodes reading `id`: [{node, port}]. */
export function consumers(comp, id) {
    const out = [];
    for (const n of comp.nodes) n.inputs.forEach((src, port) => { if (src === id) out.push({ node: n, port }); });
    return out;
}

/** Does `from` reach `to` going up the inputs (is `to` upstream of `from`, or the same)? */
export function reaches(comp, from, to) {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
        const id = stack.pop();
        if (id === to) return true;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const n = nodeById(comp, id);
        if (n) stack.push(...n.inputs);
    }
    return false;
}

/** Connect `src` into `dst`'s input `port`. Refused (false) when it would make a loop. */
export function connect(comp, dstId, port, srcId) {
    const dst = nodeById(comp, dstId);
    if (!dst || port < 0 || port >= dst.inputs.length) return false;
    if (srcId && (!nodeById(comp, srcId) || reaches(comp, srcId, dstId))) return false;
    dst.inputs[port] = srcId || null;
    return true;
}

export function disconnect(comp, dstId, port) { return connect(comp, dstId, port, null); }

// ── wires: where they run, and a node dropped on one ───────────────────────
/** A Dot's size in the graph (a small round elbow for wires). */
export const DOT = 12;
/** How big a node is drawn in the graph: [w, h]. */
export function nodeSize(n) {
    if (!n) return [NODE_W, NODE_H];
    if (n.type === "dot") return [DOT, DOT];
    if (G.GRAPH_ONLY.has(n.type)) return [isNum(n.w) ? n.w : n.type === "sticky" ? 180 : 360, isNum(n.h) ? n.h : n.type === "sticky" ? 90 : 240];
    return [NODE_W, NODE_H];
}
/** Where a node's output sits (the bottom middle). */
export function outXY(n) { const [w, h] = nodeSize(n); return [n.x + w / 2, n.y + h]; }
/** Where input ``i`` of a node sits (along its top edge). */
export function inXY(n, i) { return n.type === "dot" ? [n.x + DOT / 2, n.y] : [n.x + portX(n, i), n.y]; }
/** Where input ``port`` of a node sits along its top edge (graph units from its left). */
export function portX(n, i) { return ((i + 1) / (Math.max(1, inputsOf(n).length) + 1)) * NODE_W; }
/** A wire's curve (the editor draws the same): from the bottom middle of the source to the input on top of the other. */
export function wireCurve(x1, y1, x2, y2) {
    const dy = Math.max(30, Math.abs(y2 - y1) / 2);
    return [[x1, y1], [x1, y1 + dy], [x2, y2 - dy], [x2, y2]];
}
/** Every wire: {src, dst, port, curve}. */
export function wires(comp) {
    const out = [];
    for (const n of comp.nodes) n.inputs.forEach((src, port) => {
        const s = src && nodeById(comp, src);
        if (s) out.push({ src, dst: n.id, port, curve: wireCurve(...outXY(s), ...inXY(n, port)) });
    });
    return out;
}
function bez(c, t) {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
    return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}
/** How far a point is from a wire's curve (sampled at 48 steps). */
export function wireDistance(curve, x, y) {
    let best = Infinity, prev = bez(curve, 0);
    for (let i = 1; i <= 48; i++) {
        const q = bez(curve, i / 48);
        const dx = q[0] - prev[0], dy = q[1] - prev[1], L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((x - prev[0]) * dx + (y - prev[1]) * dy) / L)) : 0;
        best = Math.min(best, Math.hypot(x - (prev[0] + t * dx), y - (prev[1] + t * dy)));
        prev = q;
    }
    return best;
}
/** Can node ``id`` go into a wire as Nuke lets one: it has an input, its first is free and nothing reads it yet. */
export function canSplice(comp, id) {
    const n = nodeById(comp, id);
    return !!(n && n.type !== "output" && n.type !== "group_output" && n.inputs.length && !n.inputs[0] && !consumers(comp, id).length);
}
/** The wire a node dropped at (x, y) - its middle - goes into: the nearest within ``reach``, none of its own. */
export function wireUnder(comp, id, x, y, reach) {
    if (!canSplice(comp, id)) return null;
    let best = null;
    for (const w of wires(comp)) {
        if (w.src === id || w.dst === id) continue;
        if (reaches(comp, w.src, id) || reaches(comp, id, w.dst)) continue;   // it would make a loop
        const d = wireDistance(w.curve, x, y);
        if (d <= reach && (!best || d < best.d)) best = { ...w, d };
    }
    return best;
}
/** Node ``id`` put into the wire src -> dst.port: it reads src on its first input, dst reads it. */
export function spliceNode(comp, id, wire) {
    const n = nodeById(comp, id), dst = nodeById(comp, wire.dst);
    if (!n || !dst || !canSplice(comp, id) || dst.inputs[wire.port] !== wire.src) return false;
    n.inputs[0] = wire.src;
    dst.inputs[wire.port] = id;
    return true;
}

// ── gestures: lay out by dragging, cut wires by stroking (Houdini's, as on ComfyUI's canvas) ──
/** The gap between nodes the layout gesture leaves: two grid cells, so a laid-out row stays on the grid. */
export const LAYOUT_GAP = 2 * GRID;
/**
 * Where the layout gesture puts ``items`` = [{id, x, y, batch}] (batch: when the node joined the selection -
 * nodes picked together, by one box, share one): "h" one row from the left, "v" one column from the top, in
 * the order they were picked (inside a batch by where they stand), from the selection's top left corner.
 * Returns [{id, x, y}]; pure, so the same axis always gives the same places.
 */
export function layoutTargets(items, axis, { gap = LAYOUT_GAP, snap = false, g = GRID } = {}) {
    if (!items.length) return [];
    let left = Math.min(...items.map((s) => s.x)), top = Math.min(...items.map((s) => s.y));
    if (snap) { left = snapTo(left, g); top = snapTo(top, g); }
    const pos = axis === "h" ? (a, b) => (a.x - b.x) || (a.y - b.y) : (a, b) => (a.y - b.y) || (a.x - b.x);
    const order = [...items].sort((a, b) => ((a.batch ?? Infinity) - (b.batch ?? Infinity)) || pos(a, b));
    return order.map((s, i) => axis === "h" ? { id: s.id, x: left + i * (NODE_W + gap), y: top } : { id: s.id, x: left, y: top + i * (NODE_H + gap) });
}
/** The axis a layout drag means: null until it is ``least`` graph units long, then the longer of the two. */
export function layoutAxis(dx, dy, least = 6) {
    if (Math.abs(dx) < least && Math.abs(dy) < least) return null;
    return Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
}
function segCross(a, b, c, d) {
    const den = (d[1] - c[1]) * (b[0] - a[0]) - (d[0] - c[0]) * (b[1] - a[1]);
    if (den === 0) return false;
    const ua = ((d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0])) / den;
    const ub = ((b[0] - a[0]) * (a[1] - c[1]) - (b[1] - a[1]) * (a[0] - c[0])) / den;
    return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}
/** The wires a stroke from ``a`` to ``b`` crosses (each wire's curve as 24 straight pieces): [{src, dst, port}]. */
export function wiresCrossed(comp, a, b) {
    const out = [];
    for (const w of wires(comp)) {
        let prev = bez(w.curve, 0);
        for (let i = 1; i <= 24; i++) {
            const q = bez(w.curve, i / 24);
            if (segCross(a, b, prev, q)) { out.push({ src: w.src, dst: w.dst, port: w.port }); break; }
            prev = q;
        }
    }
    return out;
}
/** Cut the wires ``cut`` (from wiresCrossed): each input that still reads what it read is left empty. */
export function cutWires(comp, cut) {
    let n = 0;
    for (const w of cut) { const d = nodeById(comp, w.dst); if (d && d.inputs[w.port] === w.src) { d.inputs[w.port] = null; n++; } }
    return n;
}

/** Delete nodes as Nuke does: what read a node reads its first input instead. */
export function removeNodes(comp, ids) {
    const gone = new Set(ids);
    for (const id of ids) {
        const n = nodeById(comp, id);
        if (!n) continue;
        let up = n.inputs[0] || null;
        while (up && gone.has(up)) up = (nodeById(comp, up) || { inputs: [null] }).inputs[0] || null;
        for (const { node, port } of consumers(comp, id)) if (!gone.has(node.id)) node.inputs[port] = up && !reaches(comp, up, node.id) ? up : null;
    }
    comp.nodes = comp.nodes.filter((n) => !gone.has(n.id));
    if (gone.has(comp.output)) { const o = comp.nodes.find((n) => n.type === "output"); comp.output = o ? o.id : null; }
}

/**
 * Put a new node after `afterId` (Nuke's way: it takes over what read that node, and reads it); with nothing
 * selected it just goes in. A Merge put after a node takes it as its B. Returns the node.
 */
export function insertNode(comp, type, afterId, extra = {}) {
    const after = afterId ? nodeById(comp, afterId) : null;
    const node = makeNode(comp, type, Object.assign(after ? { x: after.x, y: after.y + 70 } : freeSpot(comp), extra));
    addNode(comp, node);
    if (after && after.type !== "output" && node.inputs.length) {
        for (const { node: c, port } of consumers(comp, after.id)) if (c.id !== node.id) c.inputs[port] = node.id;
        node.inputs[0] = after.id;
        // Make room: what was below moves down with it.
        shiftBelow(comp, node, after.id);
    }
    return node;
}

// ── groups, tools, backdrops (the graph's own; see imageViewer_compGraph.js) ─────
const baseOf = (id) => String(id).replace(/\d+$/, "") || "Node";
function freshId(have, base) { let k = 1; while (have.has(`${base}${k}`)) k++; const id = `${base}${k}`; have.add(id); return id; }

/**
 * The nodes ``ids`` of a graph (`level`: the comp, or compGraph.levelView of a group) put into one Group node, in
 * place. What came into them from outside becomes the group's inputs (an Input node each, in the order of the
 * sources from left to right); the node read from outside (the most read, else the lowest one nothing inside
 * reads) feeds its Output, and what read it reads the group. Returns {group, lost} - lost: wires from outside to
 * another node inside, which a group with one output cannot keep - or null.
 */
export function groupNodes(level, ids, { name } = {}) {
    const inside = new Set(ids.filter((id) => { const n = nodeById(level, id); return n && n.type !== "output"; }));
    if (!inside.size) return null;
    const ns = level.nodes.filter((n) => inside.has(n.id));
    const pics = ns.filter((n) => !G.GRAPH_ONLY.has(n.type));
    const srcs = [];
    for (const n of pics) for (const s of n.inputs) if (s && !inside.has(s) && !srcs.includes(s)) srcs.push(s);
    srcs.sort((a, b) => (nodeById(level, a).x - nodeById(level, b).x) || (nodeById(level, a).y - nodeById(level, b).y));
    const outs = [];
    for (const n of pics) for (const { node: c, port } of consumers(level, n.id)) if (!inside.has(c.id)) outs.push({ c, port, from: n.id });
    let from = null;
    if (outs.length) {
        const count = new Map();
        for (const x of outs) count.set(x.from, (count.get(x.from) || 0) + 1);
        from = [...count].sort((a, b) => (b[1] - a[1]) || (nodeById(level, b[0]).y - nodeById(level, a[0]).y))[0][0];
    } else {
        const sinks = pics.filter((n) => !pics.some((m) => m.inputs.includes(n.id)));
        const pool = sinks.length ? sinks : pics;
        from = pool.length ? pool.reduce((a, b) => (b.y > a.y ? b : a)).id : null;
    }
    const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const have = new Set(ns.map((n) => n.id));
    const inputs = srcs.map((s, k) => {
        const sn = nodeById(level, s);
        return { id: freshId(have, "Input"), type: "group_input", index: k, name: sn.name || sn.id, x: Math.round(Math.min(Math.max(sn.x, x0), x1)), y: Math.round(y0 - 90), inputs: [] };
    });
    const inId = new Map(srcs.map((s, k) => [s, inputs[k].id]));
    for (const n of pics) n.inputs = n.inputs.map((s) => (s && !inside.has(s) ? inId.get(s) : s));
    const fromNode = from && nodeById(level, from);
    const out = { id: freshId(have, "GroupOutput"), type: "group_output", x: Math.round(fromNode ? fromNode.x : x0), y: Math.round(y1 + 90), inputs: [from] };
    const group = makeNode(level, "group", { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), nodes: [] });
    if (name) group.name = name;
    group.nodes = [...inputs, ...ns, out];
    group.inputs = srcs.slice();
    let lost = 0;
    for (const x of outs) { if (x.from === from) x.c.inputs[x.port] = group.id; else { x.c.inputs[x.port] = null; lost++; } }
    const at = level.nodes.findIndex((n) => inside.has(n.id));
    const rest = level.nodes.filter((n) => !inside.has(n.id));
    rest.splice(Math.max(0, Math.min(at, rest.length)), 0, group);
    level.nodes = rest;
    return { group, lost };
}

/**
 * A Group node of a graph taken apart, in place: its nodes come out (ids changed only where the graph already
 * has them), wired to what came into the group, and what read the group reads what fed its Output. Returns the
 * ids of the nodes that came out, or null.
 */
export function ungroup(level, id) {
    const g = nodeById(level, id);
    if (!g || g.type !== "group") return null;
    const ins = G.groupInputs(g), out = G.groupOutput(g);
    const portSrc = new Map(ins.map((x, k) => [x.id, g.inputs[k] || null]));
    const moved = (g.nodes || []).filter((n) => n.type !== "group_input" && n.type !== "group_output");
    const have = new Set(level.nodes.filter((n) => n !== g).map((n) => n.id));
    const ren = new Map();
    for (const n of moved) ren.set(n.id, have.has(n.id) ? freshId(have, baseOf(n.id)) : (have.add(n.id), n.id));
    const mapIn = (s) => (!s ? null : portSrc.has(s) ? portSrc.get(s) : ren.has(s) ? ren.get(s) : null);
    const xs = moved.map((n) => n.x), ys = moved.map((n) => n.y);
    const dx = moved.length ? g.x - (Math.min(...xs) + Math.max(...xs)) / 2 : 0, dy = moved.length ? g.y - (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
    for (const n of moved) {
        n.inputs = n.inputs.map(mapIn);
        n.x = Math.round(n.x + dx); n.y = Math.round(n.y + dy);
        if (n.expr) for (const [from, to] of ren) if (from !== to) n.expr = renameInExpr(n.expr, from, to);
        n.id = ren.get(n.id);
    }
    const passes = out ? mapIn(out.inputs[0]) : null;
    for (const { node: c, port } of consumers(level, id)) c.inputs[port] = passes && !reaches(level, passes, c.id) ? passes : null;
    const at = level.nodes.indexOf(g);
    const rest = level.nodes.filter((n) => n !== g);
    rest.splice(at, 0, ...moved);
    level.nodes = rest;
    return moved.map((n) => n.id);
}
const renameInExpr = (expr, from, to) => {
    const one = (s) => (typeof s === "string" ? E.renameRef(s, from, to) : s);
    const out = {};
    for (const [p, v] of Object.entries(expr)) out[p] = Array.isArray(v) ? v.map(one) : one(v);
    return out;
};

/** A Group as a tool for the tool library: a comp file (`*.comp.json`) holding the group alone, unwired. */
export function toolFragment(group, format, name) {
    const g = clone(group);
    g.inputs = g.inputs.map(() => null);
    g.x = 0; g.y = 0;
    if (name) g.name = name;
    return { comp: COMP_VERSION, format: clone(format), nodes: [g], output: null, tool: { name: name || g.name || g.id } };
}

/** A tool (toolFragment's file) put into a graph at (x, y): a new Group node, unwired. Returns it, or null. */
export function insertTool(level, raw, at = null) {
    const { comp: frag } = normalizeComp(Object.assign({}, raw, { comp: COMP_VERSION }));
    const src = frag.nodes.find((n) => n.type === "group");
    if (!src) return null;
    const name = (raw && raw.tool && raw.tool.name) || src.name || "Tool";
    const base = String(name).replace(/[^A-Za-z0-9_]/g, "") || "Group";
    const g = Object.assign(clone(src), { id: uniqueId(level, /\d$/.test(base) ? base + "_" : base), name });
    g.inputs = g.inputs.map(() => null);
    const p = at || freeSpot(level);
    g.x = Math.round(p.x); g.y = Math.round(p.y);
    addNode(level, g);
    return g;
}

/** The nodes a backdrop holds: those whose middle lies inside it (backdrops and notes too). */
export function backdropHolds(level, id) {
    const b = nodeById(level, id);
    if (!b) return [];
    const [bw, bh] = nodeSize(b);
    return level.nodes.filter((n) => {
        if (n === b) return false;
        const [w, h] = nodeSize(n);
        const cx = n.x + w / 2, cy = n.y + h / 2;
        return cx > b.x && cx < b.x + bw && cy > b.y && cy < b.y + bh && !(n.type === "backdrop" && w * h >= bw * bh);
    }).map((n) => n.id);
}

/** A backdrop round the nodes ``ids`` (with a margin and room for its label on top), not yet in the graph. */
export function backdropAround(level, ids, extra = {}) {
    const ns = ids.map((id) => nodeById(level, id)).filter(Boolean);
    if (!ns.length) return makeNode(level, "backdrop", Object.assign(freeSpot(level), extra));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) { const [w, h] = nodeSize(n); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + w); y1 = Math.max(y1, n.y + h); }
    const m = 30;
    return makeNode(level, "backdrop", Object.assign({ x: Math.round(x0 - m), y: Math.round(y0 - m - 30), w: Math.round(x1 - x0 + 2 * m), h: Math.round(y1 - y0 + 2 * m + 30) }, extra));
}

/** Where a node with nothing to hang under goes: right of everything, level with the topmost. */
export function freeSpot(comp) {
    if (!comp.nodes.length) return { x: 0, y: 0 };
    let right = -Infinity, top = Infinity;
    for (const n of comp.nodes) { right = Math.max(right, n.x); top = Math.min(top, n.y); }
    return { x: Math.round(right + NODE_W + 40), y: Math.round(top) };
}

function shiftBelow(comp, node, aboveId) {
    const moved = new Set([node.id, aboveId]);
    const walk = (id) => {
        for (const { node: c } of consumers(comp, id)) {
            if (moved.has(c.id)) continue;
            moved.add(c.id);
            if (c.y < node.y + NODE_H + 20) c.y += 70;
            walk(c.id);
        }
    };
    walk(node.id);
}

// ── keys and values ──────────────────────────────────────────────────────────

/** A param's value at `frame`: its keys (Motion's interpolation), else its value, else the type's default. */
export function paramAt(node, p, frame, scope) {
    const d = NODE_TYPES[node.type] && NODE_TYPES[node.type].params[p];
    const own = node[p] !== undefined ? node[p] : d ? d.def : undefined;
    if (!d || !d.key) return clone(own);
    let v = valueAt({ tracks: node.tracks, [p]: own }, p, frame);
    const ex = node.expr && node.expr[p];
    if (ex) { const sc = scope || node.__scope; if (sc) v = withExpr(node, p, d, v, frame, sc); }
    if (d.kind === "num" && isNum(v)) {
        let x = v;
        if (d.min !== undefined && x < d.min) x = d.min;
        if (d.max !== undefined && x > d.max) x = d.max;
        return x;
    }
    return v;
}

// ── expressions ──────────────────────────────────────────────────────────────
// `expr: { param: "text" }` on a node (a vector or a colour: a list, one text or null per component) says how a
// keyable number is worked out from `value` (its own keys or number), the frame and other nodes' numbers
// (imageViewer_compExpr.js). Where it makes no number the value stays. Its twin is comp_model.param_at.
const exprBusy = [];
/** Can `p` of a node of this type take an expression? (keyable numbers, vectors and colours) */
export function exprable(type, p) {
    const d = NODE_TYPES[type] && NODE_TYPES[type].params[p];
    return !!(d && d.key && (d.kind === "num" || d.kind === "int" || d.kind === "vec2" || d.kind === "color"));
}
function withExpr(node, p, d, v, frame, sc) {
    if (exprBusy.length > 32 || exprBusy.some((b) => b[0] === node && b[1] === p)) return v;   // a loop of links
    const ex = node.expr[p];
    const f = sc.format || {}, fps = f.fps || 24;
    const vars = (value) => ({ frame, time: frame / fps, fps, width: f.width, height: f.height, value });
    const ref = (k) => (id, param, comp) => {
        const m = G.scopeNode(sc, id);
        if (!m || !NODE_TYPES[m.type] || !NODE_TYPES[m.type].params[param]) return NaN;
        const r = paramAt(m, param, frame);
        if (Array.isArray(r)) { const i = comp ?? k ?? 0; return i < r.length && isNum(r[i]) ? r[i] : NaN; }
        return isNum(r) ? r : NaN;
    };
    exprBusy.push([node, p]);
    try {
        if (Array.isArray(v)) {
            if (!Array.isArray(ex)) return v;
            const out = v.slice();
            for (let k = 0; k < out.length; k++) {
                if (typeof ex[k] !== "string" || !ex[k].trim() || !isNum(out[k])) continue;
                const r = E.evalExpr(ex[k], { vars: vars(out[k]), ref: ref(k) });
                if (Number.isFinite(r)) out[k] = r;
            }
            return out;
        }
        if (typeof ex !== "string" || !ex.trim() || !isNum(v)) return v;
        const r = E.evalExpr(ex, { vars: vars(v), ref: ref(null) });
        return Number.isFinite(r) ? (d.kind === "int" ? Math.floor(r + 0.5) : r) : v;
    } finally { exprBusy.pop(); }
}
/** The node ids a node's expressions read. */
export function exprRefsOf(node) {
    const out = [];
    for (const ex of Object.values((node && node.expr) || {})) for (const s of Array.isArray(ex) ? ex : [ex]) {
        if (typeof s === "string") for (const r of E.exprRefs(s)) if (!out.includes(r)) out.push(r);
    }
    return out;
}

/** Every key frame of a node, sorted. */
export function nodeKeyFrames(node) {
    const out = new Set();
    for (const list of Object.values((node && node.tracks) || {})) for (const k of list || []) out.add(k.f);
    return [...out].sort((a, b) => a - b);
}

// ── the stack the Layers panel shows ─────────────────────────────────────────

const CHAIN = new Set(["transform", "paint", "reformat", "cornerpin", "tracker", "planartracker", "stmap", "vectorwarp", "lensdistortion", "gridwarp", "glow", "lensflare", "grade", "colorcorrect", "ocio_colorspace", "ocio_display", "lumakeyer", "chromakeyer", "erode", "laplacian", "channelmerge", "channelmath", "blur", "crop", "shuffle", "addchannels", "removechannels", "premult", "unpremult", "retime", "keyer", "vectors",
    "motionblur", "depthblur", "defocus", "copy", ...EX.EXTRA_CHAIN]);

/**
 * The comp as layers, top first: [{ kind: "layer" | "background" | "group", merge?, chain: [ids top-down],
 * source?, name }]. `chain` runs from the node the Merge reads (its A) up to the source; `source` is the
 * Read / Input / Constant at its end. A layer whose A branch holds another Merge is a "group".
 */
export function layerStack(comp, from = undefined) {
    const out = [];
    const outNode = nodeById(comp, comp.output);
    let id = from !== undefined ? from : outNode ? outNode.inputs[0] : null;
    const seen = new Set();
    const branch = (start) => {
        const chain = [];
        let cur = start, group = false;
        while (cur && !seen.has(cur)) {
            const n = nodeById(comp, cur);
            if (!n) break;
            chain.push(n.id);
            if (CHAIN.has(n.type)) { cur = n.inputs[0]; continue; }
            if (n.type === "merge") group = true;
            break;
        }
        const last = chain.length ? nodeById(comp, chain[chain.length - 1]) : null;
        const source = last && !CHAIN.has(last.type) && last.type !== "merge" ? last : null;
        return { chain, source, group };
    };
    while (id && !seen.has(id)) {
        const n = nodeById(comp, id);
        if (!n) break;
        if (n.type === "merge") {
            seen.add(id);
            const b = branch(n.inputs[1]);
            out.push({ kind: b.group ? "group" : "layer", merge: n.id, chain: b.chain, source: b.source ? b.source.id : null,
                name: n.name || (b.source ? b.source.name || sourceName(b.source) : b.group ? "Group" : "(nothing in A)") });
            id = n.inputs[0];
            continue;
        }
        const b = branch(id);
        out.push({ kind: b.group ? "group" : "background", merge: null, chain: b.chain, source: b.source ? b.source.id : null,
            name: b.source ? b.source.name || sourceName(b.source) : "Background" });
        break;
    }
    return out;
}

/**
 * Where the Layers panel starts reading: what the Output reads; with nothing wired into the Output, the node
 * looked at (`viewed`, a top-level id) or else the end of the largest tree of nodes nothing reads - so a Read
 * dropped into the graph is a layer before it is wired. {id, loose}: loose = not what the Output reads.
 */
export function layerRoot(comp, viewed = null) {
    const outNode = nodeById(comp, comp.output);
    if (outNode && outNode.inputs[0] && nodeById(comp, outNode.inputs[0])) return { id: outNode.inputs[0], loose: false };
    const pic = (n) => n && n.type !== "output" && !G.GRAPH_ONLY.has(n.type) && n.type !== "group_input" && n.type !== "group_output";
    const v = viewed ? nodeById(comp, viewed) : null;
    if (pic(v)) return { id: v.id, loose: true };
    const read = new Set();
    for (const n of comp.nodes) for (const s of n.inputs || []) if (s) read.add(s);
    const size = (id, seen = new Set()) => {
        const n = nodeById(comp, id);
        if (!n || seen.has(id)) return 0;
        seen.add(id);
        return 1 + (n.inputs || []).reduce((a, s) => a + (s ? size(s, seen) : 0), 0);
    };
    let best = null, bestN = 0;
    for (const n of comp.nodes) {
        if (!pic(n) || read.has(n.id)) continue;
        const k = size(n.id);
        if (k > bestN || (k === bestN && best && n.y > best.y)) { best = n; bestN = k; }
    }
    return { id: best ? best.id : null, loose: !!best };
}

/** The picture sources (Reads, Constants ...: nodes without inputs) that are in no layer of `stack`. */
export function looseSources(comp, stack) {
    const used = new Set();
    for (const l of stack) { if (l.merge) used.add(l.merge); for (const id of l.chain) used.add(id); }
    const up = new Set();
    const walk = (id) => { const n = nodeById(comp, id); if (!n || up.has(id)) return; up.add(id); for (const s of n.inputs || []) if (s) walk(s); };
    for (const id of used) walk(id);
    return comp.nodes.filter((n) => n.type === "read" && !up.has(n.id)).map((n) => n.id);
}

/** A node already in the comp made a new layer on top (addLayer for a node that is there). Returns {merge, source}. */
export function layerFrom(comp, id) {
    const source = nodeById(comp, id);
    if (!source) return null;
    const outNode = nodeById(comp, comp.output) || addNode(comp, makeNode(comp, "output", { x: source.x, y: source.y + 200 }));
    if (!comp.output) comp.output = outNode.id;
    const top = outNode.inputs[0] ? nodeById(comp, outNode.inputs[0]) : null;
    if (!top) { outNode.inputs[0] = source.id; return { merge: null, source }; }
    const merge = addNode(comp, makeNode(comp, "merge", { x: outNode.x, y: outNode.y }));
    merge.inputs = [top.id, source.id, null];
    outNode.inputs[0] = merge.id;
    outNode.y += 70;
    return { merge, source };
}

// ── copies: duplicate, copy and paste ────────────────────────────────────────
const NO_COPY = new Set(["output", "group_input", "group_output"]);
/** The nodes `ids` of a graph as a fragment to paste (copies; an Output and a group's own ports are left out). */
export function copyNodes(level, ids) {
    const want = new Set(ids);
    const nodes = level.nodes.filter((n) => want.has(n.id) && !NO_COPY.has(n.type)).map((n) => clone(n));
    return nodes.length ? { nodes } : null;
}

/**
 * A fragment (copyNodes) put into a graph as new nodes: ids made new where the graph has them, the wires and
 * expression links among the copies kept, wires from nodes outside kept only with `outer` (and only where that
 * node is in this graph). Placed `dx` / `dy` from where they were, or with their middle at `at` ([x, y]).
 * Returns the new nodes.
 */
export function pasteNodes(level, frag, { dx = 0, dy = 0, at = null, outer = false } = {}) {
    const src = ((frag && frag.nodes) || []).filter((n) => n && NODE_TYPES[n.type] && !NO_COPY.has(n.type)).map((n) => clone(n));
    if (!src.length) return [];
    const have = new Set(level.nodes.map((n) => n.id));
    const ren = new Map();
    for (const n of src) ren.set(n.id, have.has(n.id) ? freshId(have, baseOf(n.id)) : (have.add(n.id), n.id));
    if (at) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const n of src) { const [w, h] = nodeSize(n); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + w); y1 = Math.max(y1, n.y + h); }
        dx = at[0] - (x0 + x1) / 2; dy = at[1] - (y0 + y1) / 2;
    }
    // Links are renamed in two steps (Read1 -> Read2 while Read2 -> Read3 must not run into each other).
    const pairs = [...ren].filter(([a, b]) => a !== b);
    const tmp = (k) => `__copy_${k}__`;
    for (const n of src) {
        n.inputs = (n.inputs || []).map((s) => (!s ? null : ren.has(s) ? ren.get(s) : outer && nodeById(level, s) ? s : null));
        if (n.expr) {
            pairs.forEach(([a], k) => { n.expr = renameInExpr(n.expr, a, tmp(k)); });
            pairs.forEach(([, b], k) => { n.expr = renameInExpr(n.expr, tmp(k), b); });
        }
        n.id = ren.get(n.id);
        n.x = Math.round(n.x + dx); n.y = Math.round(n.y + dy);
        addNode(level, n);
    }
    return src;
}

export function sourceName(n) {
    if (!n) return "";
    if (n.type === "read") return String(n.file || "Read").split(/[\\/]/).pop() || n.id;
    return n.name || n.id;
}

/** Swap two layers' places (i and i + d in layerStack's order): their Merges trade A branches and settings. */
export function moveLayer(comp, i, d) {
    const L = layerStack(comp);
    const a = L[i], b = L[i + d];
    if (!a || !b || !a.merge || !b.merge) return false;
    const ma = nodeById(comp, a.merge), mb = nodeById(comp, b.merge);
    for (const k of ["operation", "mix", "disable", "name", "tracks", "in", "out"]) { const t = ma[k]; ma[k] = mb[k]; mb[k] = t; if (ma[k] === undefined) delete ma[k]; if (mb[k] === undefined) delete mb[k]; }
    const tA = ma.inputs[1]; ma.inputs[1] = mb.inputs[1]; mb.inputs[1] = tA;
    const tM = ma.inputs[2]; ma.inputs[2] = mb.inputs[2]; mb.inputs[2] = tM;
    // The branches keep their place on screen beside their Merge.
    const shift = (start, dx, dy) => { for (const id of branchIds(comp, start)) { const n = nodeById(comp, id); n.x += dx; n.y += dy; } };
    const dy = mb.y - ma.y;
    shift(ma.inputs[1], 0, dy); shift(mb.inputs[1], 0, -dy);
    return true;
}

function branchIds(comp, start) {
    const out = [];
    let cur = start;
    while (cur && !out.includes(cur)) {
        const n = nodeById(comp, cur);
        if (!n || consumers(comp, cur).length > 1) break;
        out.push(cur);
        if (!CHAIN.has(n.type)) break;
        cur = n.inputs[0];
    }
    return out;
}

/** A new layer on top of the stack: `source` (a node not yet in the comp) merged over what the Output reads. */
export function addLayer(comp, source) {
    const outNode = nodeById(comp, comp.output) || addNode(comp, makeNode(comp, "output", { x: 0, y: 200 }));
    if (!comp.output) comp.output = outNode.id;
    const top = outNode.inputs[0] ? nodeById(comp, outNode.inputs[0]) : null;
    const merge = makeNode(comp, "merge", { x: outNode.x, y: outNode.y });
    source.x = merge.x + 180; source.y = merge.y - 70;
    addNode(comp, source);
    addNode(comp, merge);
    merge.inputs = [top ? top.id : null, source.id, null];
    outNode.inputs[0] = merge.id;
    outNode.y += 70;
    for (const n of comp.nodes) if (n !== outNode && n.y > merge.y && reaches(comp, n.id, merge.id)) n.y += 70;
    return { merge, source };
}

/** Take a layer out: its Merge goes (B passes on), and so does its branch when nothing else reads it. */
export function removeLayer(comp, i) {
    const L = layerStack(comp)[i];
    if (!L || !L.merge) return false;
    const ids = [L.merge, ...branchIds(comp, nodeById(comp, L.merge).inputs[1])];
    removeNodes(comp, ids);
    return true;
}

// ── a layer's length (its Merge's in / out) ──────────────────────────────────

/** Is a Merge's A laid over at comp frame `f`? Its `in` is the first frame it is, `out` the first it is no
 *  longer (Motion's layer rule); either left out = from the start / to the end. Outside, the Merge passes B. */
export function mergeLive(n, f) {
    if (isNum(n.in) && f < n.in) return false;
    if (isNum(n.out) && f >= n.out) return false;
    return true;
}

/** A layer's length as frames [in, out), the comp's whole length filling what is not set. */
export function layerRange(comp, mergeId) {
    const n = nodeById(comp, mergeId), F = comp.format.frames;
    return { in: n && isNum(n.in) ? n.in : 0, out: n && isNum(n.out) ? n.out : F };
}

/** Set a layer's in / out (whole frames, at least one frame long). The comp's own ends are written as nothing. */
export function setLayerRange(comp, mergeId, a, b) {
    const n = nodeById(comp, mergeId);
    if (!n || n.type !== "merge") return false;
    a = Math.round(a); b = Math.round(b);
    if (b <= a) b = a + 1;
    if (a === 0) delete n.in; else n.in = a;
    if (b === comp.format.frames) delete n.out; else n.out = b;
    return true;
}

/** The nodes that make a layer: its Merge and its A branch (the chain up to the source). */
export function layerNodes(comp, L) {
    return [L.merge, ...(L.chain || [])].filter((id, i, a) => id && a.indexOf(id) === i && nodeById(comp, id));
}

/** Every key of a layer's nodes: [{id, prop, f}]. */
export function layerKeys(comp, L) {
    const out = [];
    for (const id of layerNodes(comp, L)) {
        const n = nodeById(comp, id);
        for (const [prop, list] of Object.entries(n.tracks || {})) for (const k of list || []) out.push({ id, prop, f: k.f });
    }
    return out;
}

/**
 * Slide a layer in time by `df` frames, as a layer bar is dragged: its in and out, a Read's footage (offset) and
 * every key of its nodes move together, so the layer looks the same, later or earlier.
 */
export function slideLayer(comp, L, df) {
    df = Math.round(df);
    if (!df || !L || !L.merge) return false;
    const r = layerRange(comp, L.merge);
    setLayerRange(comp, L.merge, r.in + df, r.out + df);
    for (const id of layerNodes(comp, L)) {
        const n = nodeById(comp, id);
        if (n.type === "read") { const o = (n.offset || 0) + df; if (o) n.offset = o; else delete n.offset; }
        for (const list of Object.values(n.tracks || {})) for (const k of list || []) k.f += df;
    }
    return true;
}

// ── pixels ───────────────────────────────────────────────────────────────────


export function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export function linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

/** 8-bit straight RGBA (sRGB, or linear when `linear`) -> a picture: linear, premultiplied floats. */
export function decode8(u8, w, h, linear = false) {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = linear ? i / 255 : srgbToLinear(i / 255);
    const out = blank(w, h), d = out.data;
    for (let i = 0; i < w * h * 4; i += 4) {
        const a = u8[i + 3] / 255;
        d[i] = lut[u8[i]] * a; d[i + 1] = lut[u8[i + 1]] * a; d[i + 2] = lut[u8[i + 2]] * a; d[i + 3] = a;
    }
    return out;
}

/** A picture -> 8-bit RGBA for the screen: premultiplied colour over black, sRGB; `alpha` shows the alpha. */
export function encode8(img, out, { alpha = false } = {}) {
    return viewEncode(img, out, { channel: alpha ? "a" : "rgb" });
}

/** The channels the picture can be looked at in (the viewer's channel menu, with alpha). */
export const VIEW_CHANNELS = [["rgb", "RGB"], ["r", "Red"], ["g", "Green"], ["b", "Blue"], ["a", "Alpha"]];

/**
 * The picture as the viewer shows it, into 8-bit RGBA (`out`): its rgb times `gain` (2^exposure; alpha is not
 * touched), one channel as grey when `channel` is r / g / b, then encoded - through `color(r, g, b)` -> display
 * values 0..1 (an OCIO display / view) when given, else the sRGB curve. The alpha ("a") is shown as it is, grey:
 * no exposure and no display transform - it is a matte, not a picture. Over black (premultiplied as it stands).
 */
export function viewEncode(img, out, { gain = 1, channel = "rgb", color = null } = {}) {
    const d = img.data, n = img.w * img.h * 4;
    const lut = new Uint8ClampedArray(4096);
    for (let i = 0; i < 4096; i++) lut[i] = Math.round(linearToSrgb(i / 4095) * 255);
    const q = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : lut[(v * 4095 + 0.5) | 0]);
    const qd = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
    const one = channel === "r" ? 0 : channel === "g" ? 1 : channel === "b" ? 2 : -1;
    for (let i = 0; i < n; i += 4) {
        out[i + 3] = 255;
        if (channel === "a") { const a = q(d[i + 3]); out[i] = out[i + 1] = out[i + 2] = a; continue; }
        let r, g, b;
        if (one >= 0) r = g = b = d[i + one] * gain;
        else { r = d[i] * gain; g = d[i + 1] * gain; b = d[i + 2] * gain; }
        if (color) { const c = color(r, g, b); out[i] = qd(c[0]); out[i + 1] = qd(c[1]); out[i + 2] = qd(c[2]); }
        else { out[i] = q(r); out[i + 1] = q(g); out[i + 2] = q(b); }
    }
    return out;
}

// 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (Motion's convention).
export const mat = {
    mul: (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]],
    inv: (m) => { const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
        return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]; },
    t: (x, y) => [1, 0, 0, 1, x, y],
    s: (x, y) => [x, 0, 0, y, 0, 0],
    r: (deg) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; },
    /** Skew: x moves by kx * y first, then y by ky * x (the y skew after the x one). */
    k: (kx, ky) => [1, ky, kx, kx * ky + 1, 0, 0],
};

/** `src` drawn through `m` (source pixels -> output pixels) into a w x h picture, bilinear, transparent outside. */
export function resample(src, m, w, h) {
    const out = blank(w, h), o = out.data, s = src.data, sw = src.w, sh = src.h;
    if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 && sw === w && sh === h) { o.set(s); return src.bb ? O.withBox(out, src.bb) : out; }
    const iv = mat.inv(m);
    // With a box: only the output pixels its corners land in (a pixel more all round, for the bilinear reach).
    let X0 = 0, Y0 = 0, X1 = w, Y1 = h;
    if (src.bb) {
        const [bx0, by0, bx1, by1] = src.bb;
        if (O.boxEmpty(src.bb)) return O.withBox(out, [0, 0, 0, 0]);
        let lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
        for (const [cx, cy] of [[bx0 - 1, by0 - 1], [bx1 + 1, by0 - 1], [bx0 - 1, by1 + 1], [bx1 + 1, by1 + 1]]) {
            const X = m[0] * cx + m[2] * cy + m[4], Y = m[1] * cx + m[3] * cy + m[5];
            lx = Math.min(lx, X); hx = Math.max(hx, X); ly = Math.min(ly, Y); hy = Math.max(hy, Y);
        }
        [X0, Y0, X1, Y1] = O.boxClip([Math.floor(lx) - 1, Math.floor(ly) - 1, Math.ceil(hx) + 1, Math.ceil(hy) + 1], w, h);
        O.withBox(out, [X0, Y0, X1, Y1]);
    }
    for (let y = Y0; y < Y1; y++) {
        const py = y + 0.5;
        for (let x = X0; x < X1; x++) {
            const px = x + 0.5;
            const u = iv[0] * px + iv[2] * py + iv[4] - 0.5;
            const v = iv[1] * px + iv[3] * py + iv[5] - 0.5;
            const x0 = Math.floor(u), y0 = Math.floor(v);
            if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) continue;
            const fx = u - x0, fy = v - y0;
            const oi = (y * w + x) * 4;
            for (let j = 0; j < 4; j++) {
                const yy = y0 + (j >> 1), xx = x0 + (j & 1);
                if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
                const wgt = ((j & 1) ? fx : 1 - fx) * ((j >> 1) ? fy : 1 - fy);
                if (!wgt) continue;
                const si = (yy * sw + xx) * 4;
                o[oi] += s[si] * wgt; o[oi + 1] += s[si + 1] * wgt; o[oi + 2] += s[si + 2] * wgt; o[oi + 3] += s[si + 3] * wgt;
            }
        }
    }
    return out;
}

/** The matrix that lays a sw x sh source into a w x h picture by `fit`. */
/** Lay a picture of sw x sh into w x h. `k` is what one of its pixels is in the picture's pixels for "none"
 *  (the proxy scale, times how much smaller than the file a shrunk source was handed over). */
export function fitMatrix(sw, sh, w, h, fit, k = 1) {
    let kx = k, ky = k;
    if (fit === "fit") kx = ky = Math.min(w / sw, h / sh);
    else if (fit === "fill") kx = ky = Math.max(w / sw, h / sh);
    else if (fit === "stretch") { kx = w / sw; ky = h / sh; }
    return mat.mul(mat.t(w / 2, h / 2), mat.mul(mat.s(kx, ky), mat.t(-sw / 2, -sh / 2)));
}

/** The size a Reformat makes, in pixels of the comp, from the size that comes in (``inFmt``: {width, height}). */
export function reformatSize(node, frame, inFmt) {
    if ((paramAt(node, "mode", frame) || "to format") === "scale") {
        const k = paramAt(node, "scale", frame) || 1;
        return [Math.max(1, Math.round(inFmt.width * k)), Math.max(1, Math.round(inFmt.height * k))];
    }
    return [Math.max(1, Math.round(paramAt(node, "width", frame) || inFmt.width)), Math.max(1, Math.round(paramAt(node, "height", frame) || inFmt.height))];
}

/** A Reformat: the picture that comes in (``inFmt`` big, in pixels of the comp) laid into a NEW picture of
 *  reformatSize: {m (input pixels -> output pixels, both ``scale`` times their size), w, h (output pixels), bw, bh}.
 *  centre on: the middle on the middle; off: its bottom left on the bottom left. */
export function reformatLayout(node, frame, inFmt, scale = 1) {
    const FW = inFmt.width, FH = inFmt.height;
    const [bw, bh] = reformatSize(node, frame, inFmt);
    const turn = paramAt(node, "turn", frame) === "on";
    const iw = turn ? FH : FW, ih = turn ? FW : FH;
    let sx = 1, sy = 1;
    const how = paramAt(node, "resize", frame) || "fit";
    if (how === "fit") sx = sy = Math.min(bw / iw, bh / ih);
    else if (how === "fill") sx = sy = Math.max(bw / iw, bh / ih);
    else if (how === "width") sx = sy = bw / iw;
    else if (how === "height") sx = sy = bh / ih;
    else if (how === "distort") { sx = bw / iw; sy = bh / ih; }
    const lw = iw * sx, lh = ih * sy;
    if (paramAt(node, "flop", frame) === "on") sx = -sx;
    if (paramAt(node, "flip", frame) === "on") sy = -sy;
    const centre = paramAt(node, "center", frame) !== "off";
    const cx = centre ? bw / 2 : lw / 2, cy = centre ? bh / 2 : bh - lh / 2;
    let m = mat.mul(mat.s(sx, sy), mat.t(-FW / 2, -FH / 2));
    if (turn) m = mat.mul(mat.s(sx, sy), mat.mul([0, -1, 1, 0, 0, 0], mat.t(-FW / 2, -FH / 2)));
    m = mat.mul(mat.t(cx, cy), m);
    m = mat.mul(mat.s(scale, scale), mat.mul(m, mat.s(1 / scale, 1 / scale)));
    return { m, w: Math.max(1, Math.round(bw * scale)), h: Math.max(1, Math.round(bh * scale)), bw, bh };
}

/**
 * The size of the picture node ``id`` makes, in pixels of the comp ({width, height}), from the graph alone: a
 * Reformat sets it, a node with no input is the comp's format, every other node keeps what comes in (a Merge:
 * B's). Pictures of other sizes are laid at the bottom left of the one they meet (``conform``).
 */
/** Nodes whose picture is the comp's size whatever comes in (3D and deep). */
export const GEO3D = new Set(["camera3d", "card3d", "geo3d", "project3d", "scene3d", "pointcloud"]);
export const DEEP = new Set(["deepread", "deepfromimage", "deepmerge", "deepholdout", "deepcrop", "deepflatten", "render3d"]);
const PLAIN_SIZE = new Set([...GEO3D, ...DEEP].filter((t) => t !== "project3d"));
export function formatAt(comp, id, depth = 0) {
    if (!depth) { comp = G.flattenComp(comp); id = G.resolveId(comp, id); }
    const F = { width: comp.format.width, height: comp.format.height };
    const n = id && depth < 256 && nodeById(comp, id);
    if (!n || !NODE_TYPES[n.type]) return F;
    const up = () => (NODE_TYPES[n.type].inputs.length && n.inputs[0] ? formatAt(comp, n.inputs[0], depth + 1) : F);
    if (!n.disable && n.type === "sidebyside") { const u = up(); return n.layout === "over under" ? { width: u.width, height: u.height * 2 } : { width: u.width * 2, height: u.height }; }
    if (!n.disable && n.type === "stmap" && n.inputs[1]) return formatAt(comp, n.inputs[1], depth + 1);
    if (EX.VFX_KINDS[n.type]) { const z = EX.vfxSize(n); if (z) return z; }
    if (!n.disable && n.type === "ai_upscale") { const u = up(), k = EX.upscaleFactor(n); return { width: Math.max(1, Math.round(u.width * k)), height: Math.max(1, Math.round(u.height * k)) }; }
    if (n.disable || n.type !== "reformat") return n.type === "read" || n.type === "constant" || PLAIN_SIZE.has(n.type) ? F : up();
    const [w, h] = reformatSize(n, 0, up());
    return { width: w, height: h };
}

/** ``img`` laid into a w x h picture with its bottom left on the bottom left (as a compositor lays a picture
 *  of another size): cut where it is bigger, transparent where it is smaller. */
export function conform(img, w, h) {
    if (!img || (img.w === w && img.h === h)) return img;
    const out = blank(w, h), dy = h - img.h, cw = Math.min(w, img.w);
    for (let y = Math.max(0, dy); y < Math.min(h, img.h + dy); y++) {
        const s = (y - dy) * img.w * 4;
        out.data.set(img.data.subarray(s, s + cw * 4), y * w * 4);
    }
    const b = O.boxOf(img);
    return O.withBox(out, O.boxClip([b[0], b[1] + dy, b[2], b[3] + dy], w, h));
}
/** One channel of w0 x h0 numbers laid into w x h the same way. */
export function conformPlane(a, w0, h0, w, h) {
    if (w0 === w && h0 === h) return a;
    const out = new a.constructor(w * h), dy = h - h0, cw = Math.min(w, w0);
    for (let y = Math.max(0, dy); y < Math.min(h, h0 + dy); y++) out.set(a.subarray((y - dy) * w0, (y - dy) * w0 + cw), y * w);
    return out;
}
const conformExtras = (ex, w0, h0, w, h) => {
    if (w0 === w && h0 === h) return ex;
    const out = {};
    for (const [k, v] of Object.entries(ex || {})) out[k] = conformPlane(v, w0, h0, w, h);
    return out;
};

/** A Transform node's matrix at `frame`, in pixels of a picture `scale` times ``format`` (the size that comes in). */
export function transformMatrix(node, frame, format, scale = 1) {
    const t = paramAt(node, "translate", frame) || [0, 0];
    const r = paramAt(node, "rotate", frame) || 0;
    const sc = paramAt(node, "scale", frame) || [1, 1];
    const k = paramAt(node, "skew", frame) || [0, 0];
    const c = paramAt(node, "center", frame) || [format.width / 2, format.height / 2];
    const cx = c[0] * scale, cy = c[1] * scale;
    return mat.mul(mat.t(t[0] * scale + cx, t[1] * scale + cy), mat.mul(mat.r(r), mat.mul(mat.s(sc[0], sc[1]), mat.mul(mat.k(k[0], k[1]), mat.t(-cx, -cy)))));
}

/** A Paint stroke's link at frame f: the matrix (full-size pixels) its points move by - the linked node's matrix at
 *  f taken back through its matrix at the stroke's frame - or null (no link, or not a node that moves pictures). */
export function linkMatrix(comp, s, f) {
    if (!s || !s.link) return null;
    const n = nodeById(comp, s.link);
    if (!n || n.disable || n.type !== "transform") return null;
    const F = formatAt(comp, n.inputs[0]);
    return mat.mul(transformMatrix(n, f, F, 1), mat.inv(transformMatrix(n, s.f, F, 1)));
}

export function gradeImage(img, p) {
    const out = blank(img.w, img.h), s = img.data, o = out.data;
    const A = (p.multiply * (p.gain - p.lift)) / ((p.whitepoint - p.blackpoint) || 1e-6);
    const B = p.offset + p.lift - A * p.blackpoint;
    const g = 1 / (p.gamma || 1e-6), sat = p.saturation, mix = p.mix;
    for (let i = 0; i < img.w * img.h * 4; i += 4) {
        const a = s[i + 3];
        o[i + 3] = a;
        if (a <= 0) { o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; continue; }
        const c = [s[i] / a, s[i + 1] / a, s[i + 2] / a];
        const r = [0, 0, 0];
        for (let k = 0; k < 3; k++) { let v = A * c[k] + B; if (g !== 1 && v > 0) v = Math.pow(v, g); r[k] = v; }
        if (sat !== 1) { const l = 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]; for (let k = 0; k < 3; k++) r[k] = l + (r[k] - l) * sat; }
        for (let k = 0; k < 3; k++) o[i + k] = (c[k] + (r[k] - c[k]) * mix) * a;
    }
    return out;
}

const OPS = {
    over: (A, B, a) => A + B * (1 - a),
    under: (A, B, a, b) => A * (1 - b) + B,
    plus: (A, B) => A + B,
    minus: (A, B) => A - B,
    multiply: (A, B) => A * B,
    screen: (A, B) => A + B - A * B,
    max: (A, B) => Math.max(A, B),
    min: (A, B) => Math.min(A, B),
    difference: (A, B) => Math.abs(A - B),
    in: (A, B, a, b) => A * b,
    out: (A, B, a, b) => A * (1 - b),
    atop: (A, B, a, b) => A * b + B * (1 - a),
    mask: (A, B, a) => B * a,
    stencil: (A, B, a) => B * (1 - a),
};

/** Operations that give B where A is 0 (so only A's box needs working out). */
const B_WHERE_NO_A = new Set(["over", "under", "plus", "screen", "atop"]);
export function mergeImages(Bimg, Aimg, Mimg, op, mix) {
    const w = Bimg.w, h = Bimg.h, out = blank(w, h), o = out.data, B = Bimg.data, A = Aimg.data, M = Mimg ? Mimg.data : null;
    const f = OPS[op] || OPS.over;
    if (Aimg.bb && B_WHERE_NO_A.has(OPS[op] ? op : "over") && !O.boxWhole(Aimg.bb, w, h)) {
        o.set(B);
        const [x0, y0, x1, y1] = O.boxClip(Aimg.bb, w, h);
        for (let y = y0; y < y1; y++) for (let x = x0, i = (y * w + x0) * 4; x < x1; x++, i += 4) {
            const a = A[i + 3], b = B[i + 3];
            const t = M ? mix * M[i + 3] : mix;
            for (let k = 0; k < 4; k++) { const r = f(A[i + k], B[i + k], a, b); o[i + k] = B[i + k] + (r - B[i + k]) * t; }
        }
        return Bimg.bb ? O.withBox(out, O.boxUnion(Bimg.bb, Aimg.bb)) : out;
    }
    for (let i = 0; i < w * h * 4; i += 4) {
        const a = A[i + 3], b = B[i + 3];
        const t = M ? mix * M[i + 3] : mix;
        for (let k = 0; k < 4; k++) { const r = f(A[i + k], B[i + k], a, b); o[i + k] = B[i + k] + (r - B[i + k]) * t; }
    }
    return out;
}

/** The input frame a Retime reads at comp frame `f`: start + (f - start) x speed + offset. */
export function retimeFrame(node, f) {
    const start = node.start || 0, speed = node.speed ?? 1, off = node.offset || 0;
    return start + (f - start) * speed + off;
}

/** A node's own settings and everything upstream of it, as a string: what a kept result is valid for. */
export function upstreamKey(comp, id) {
    const seen = new Set(), parts = [];
    const walk = (nid) => {
        if (!nid || seen.has(nid)) return;
        seen.add(nid);
        const n = nodeById(comp, nid);
        if (!n) return;
        const { x, y, name, ...rest } = n;
        parts.push(JSON.stringify(rest));
        for (const s of n.inputs) walk(s);
        // What its expressions read is part of what it is.
        for (const r of exprRefsOf(n)) { const m = n.__scope && G.scopeNode(n.__scope, r); if (m) walk(m.id); }
    };
    walk(id);
    return parts.join("|");
}

/**
 * The picture `id` makes at `frame`. ctx: { scale, source(node, frame) -> picture | null (a Read's pixels at
 * their own size, linear premultiplied), cache?: Map (results kept between calls: the HEAVY nodes', every
 * node's with `cacheAll`, only `cacheIds`' when given; within `cacheBytes` or `cacheMax` entries; keyed by
 * frame, scale, `upstreamHash`, the sources handed over and the LUTs there; `keysUsed`: a Map that gets
 * each cached node's key, `${id}@${frame}` -> key) }. Nodes that
 * look at other times (Retime, Vectors, MotionBlur without vectors) render their input at those frames.
 * Returns a picture of its own size (formatAt) x scale.
 */
/** The OCIO transforms a comp's nodes ask for at frame f: [{spec, key}] (the page fetches their LUTs). */
export function ocioNeeds(comp, frame) {
    comp = G.flattenComp(comp);
    const out = new Map();
    for (const n of comp.nodes || []) {
        for (const spec of EX.extraLuts(n)) out.set(OC.ocioKey(spec), spec);
        if (n.disable || (n.type !== "ocio_colorspace" && n.type !== "ocio_display")) continue;
        const p = {};
        for (const k of Object.keys(NODE_TYPES[n.type].params)) p[k] = paramAt(n, k, frame);
        const spec = OC.ocioSpec(n.type, p);
        out.set(OC.ocioKey(spec), spec);
    }
    return [...out].map(([key, spec]) => ({ key, spec }));
}
/**
 * What an AI node's result was made from, as a short hash: what comes into it (and its mask), the words /
 * factor it asks with, and the workflow / model files it picked.
 * A result whose key is not the node's key now is out of date (said in Parameters; it is
 * still shown until it is run again).
 */
export function aiKey(comp, n) {
    const ins = n.inputs || [];
    const models = n.models && typeof n.models === "object" ? Object.keys(n.models).sort().map((k) => `${k}=${n.models[k]}`).join(",") : "";
    const parts = [ins[0] ? upstreamKey(comp, ins[0]) : "", ins[1] ? upstreamKey(comp, ins[1]) : "", n.type, n.prompt || "", n.factor || ""];
    // The workflow and models a node picked count too (a node without them keeps the key it had).
    if (n.workflow || models) parts.push(n.workflow || "", models);
    const text = parts.join("\u0001");
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
}

/** A VFX node's key: what comes in and the settings its workflow ran with (a result of another key is out of date). */
export function vfxKey(comp, n) {
    const ins = n.inputs || [];
    const text = [ins[0] ? upstreamKey(comp, ins[0]) : "", n.type, n.prompt || "", n.width || "", n.height || "", n.mode || "", n.size || "",
        n.prerender || "on"].join("\u0001");
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
}

export { OC, CH, PT, O, EX };

/** Nodes that make something and so have a "write" (the channel or layer it goes into). */
export const WRITES = new Set(Object.keys(NODE_TYPES).filter((t) => NODE_TYPES[t].params.write));
/** Nodes that move pixels: the extra channels are moved with the picture. */
const SPATIAL = new Set(["transform", "reformat", "crop", "blur"]);
const TWO_IN = new Set(["merge", "copy", "channelmerge"]);

/**
 * The extra channels' names at node ``id``'s output (no pixels: from the graph and the settings alone), in
 * the order a render makes them - what the channel menus offer.
 */
export function channelsAt(comp, id, depth = 0) {
    if (!depth) { comp = G.flattenComp(comp); id = G.resolveId(comp, id); }
    const n = id && nodeById(comp, id);
    if (!n || depth > 256) return [];
    const ins = (i) => channelsAt(comp, n.inputs[i], depth + 1);
    const t = NODE_TYPES[n.type] || { inputs: [] };
    if (n.disable) return t.inputs.length ? ins(0) : [];
    if ((GEO3D.has(n.type) && n.type !== "project3d") || n.type === "anaglyph" || n.type === "sidebyside") return [];
    if (DEEP.has(n.type) && n.type !== "render3d") return ["depth.z"];
    if (n.type === "render3d") { const b = ins(2); return (n.depth || "depth.z") === "none" || b.includes("depth.z") ? b : [...b, "depth.z"]; }
    let have = t.inputs.length ? ins(0) : [];
    if (TWO_IN.has(n.type)) for (const c of ins(1)) if (!have.includes(c)) have = [...have, c];
    if (n.type === "addchannels") {
        for (const c of CH.expandChannels(CH.parseChannels(n.channels ?? t.params.channels.def), have, true)) if (!CH.RGBA.includes(c) && !have.includes(c)) have = [...have, c];
    } else if (n.type === "removechannels") {
        const named = CH.expandChannels(CH.parseChannels(n.channels), have, false);
        have = have.filter((c) => (n.operation === "keep" ? named.includes(c) : !named.includes(c)));
    } else if (n.type === "shuffle") {
        const out = n.out || "rgba";
        if (out !== "rgba" && CH.isLayer(out)) CH.layerChannels(out).forEach((c, k) => { const pk = n["rgba"[k]] || "rgba"[k]; if (pk !== "-" && !have.includes(c)) have = [...have, c]; });
    }
    if (WRITES.has(n.type)) {
        const w = n.write || "rgba";
        const add = w === "rgba" || !CH.isTarget(w) ? [] : CH.isLayer(w) ? CH.layerChannels(w) : CH.RGBA.includes(w) ? [] : [w];
        for (const c of add) if (!have.includes(c)) have = [...have, c];
    }
    return have;
}

/**
 * The mask stage: `src` (what came in) + (`img` - src) x mix x m, per pixel, for the picture and every extra
 * channel of either (a channel one side lacks counts as 0). `m` is one plane (null: no mask), `invert` 1 - m.
 * Float64 between steps, as the numpy twin's `mask_mix`.
 */
export function maskMix(src, sex, img, ex, m, mix, invert) {
    const w = img.w, h = img.h, N = w * h, out = blank(w, h), o = out.data, S = src.data, R = img.data;
    const t = new Float64Array(N);
    for (let p = 0; p < N; p++) t[p] = m ? mix * (invert ? 1 - m[p] : m[p]) : mix;
    for (let p = 0, i = 0; p < N; p++, i += 4) for (let k = 0; k < 4; k++) o[i + k] = S[i + k] + (R[i + k] - S[i + k]) * t[p];
    const oex = {};
    for (const name of new Set([...Object.keys(sex || {}), ...Object.keys(ex || {})])) {
        const a = (sex || {})[name], b = (ex || {})[name], c = new Float32Array(N);
        for (let p = 0; p < N; p++) { const av = a ? a[p] : 0, bv = b ? b[p] : 0; c[p] = av + (bv - av) * t[p]; }
        oex[name] = c;
    }
    return [out, oex];
}

/** cyrb53: a 53-bit hash of a string, as a base-36 string. */
export function hashString(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/**
 * A hash of node `id`'s settings and everything upstream of it (what `upstreamKey` spells out), built
 * from its inputs' hashes so a graph is hashed once per render (`memo`: id -> hash).
 */
export function upstreamHash(comp, id, memo = new Map(), depth = 0) {
    if (!depth) { comp = G.flattenComp(comp); id = G.resolveId(comp, id); }
    if (!id) return "-";
    if (memo.has(id)) return memo.get(id);
    const n = nodeById(comp, id);
    if (!n || depth > 256) return "?";
    memo.set(id, "~");   // a loop (refused by connect) hashes as itself
    const { x, y, name, ...rest } = n;
    // A Paint node's strokes can follow a Transform that is not upstream of it: its settings count too.
    const links = n.type === "paint" && Array.isArray(n.strokes) ? [...new Set(n.strokes.map((s) => s && s.link).filter((l) => typeof l === "string"))] : [];
    const h = hashString(JSON.stringify(rest) + "|" + n.inputs.map((s) => upstreamHash(comp, s, memo, depth + 1)).join(",")
        + (links.length ? "|" + links.map((l) => upstreamHash(comp, l, memo, depth + 1)).join(",") : "")
        // What its expressions read is part of what it is.
        + (n.expr ? "|" + exprRefsOf(n).map((r) => { const m = n.__scope && G.scopeNode(n.__scope, r); return m ? upstreamHash(comp, m.id, memo, depth + 1) : "?"; }).join(",") : ""));
    memo.set(id, h);
    return h;
}
// A token per object handed to renderNode (a decoded source frame): the same object, the same token.
const tokens = new WeakMap();
let tokenNext = 1;
function tokenOf(o) {
    if (!o || typeof o !== "object") return "0";
    let t = tokens.get(o);
    if (!t) { t = tokenNext++; tokens.set(o, t); }
    return t;
}
/** The bytes a kept result holds (its picture and its extra channels). */
export function resultBytes(r) {
    let b = r.img && r.img.data ? r.img.data.byteLength : 0;
    for (const v of Object.values(r.ex || {})) b += v.byteLength || 0;
    return b;
}
/**
 * Keep `value` in `cache` (a Map in use order, oldest first) under `key`: within `maxBytes` when given (the
 * oldest go first, the newest always stays), else within `maxCount` entries (24).
 */
export function cacheKeep(cache, key, value, maxBytes, maxCount) {
    if (cache.has(key)) { cache.__bytes = (cache.__bytes || 0) - (cache.get(key).__b || 0); cache.delete(key); }
    value.__b = resultBytes(value);
    cache.set(key, value);
    cache.__bytes = (cache.__bytes || 0) + value.__b;
    if (maxBytes) {
        while (cache.__bytes > maxBytes && cache.size > 1) {
            const [k, v] = cache.entries().next().value;
            cache.delete(k);
            cache.__bytes -= v.__b || 0;
        }
    } else {
        while (cache.size > (maxCount || 24)) {
            const [k, v] = cache.entries().next().value;
            cache.delete(k);
            cache.__bytes -= v.__b || 0;
        }
    }
}

const sourceSigOf = (comp, nid, f, ctx, view) => sourceNeeds(comp, nid, f, view).map(({ node: s, frame: sf, deep }) =>
    `${srcKey(s, sf)}:${tokenOf(deep ? (ctx.deepSource ? ctx.deepSource(s, sf) : null) : ctx.source ? ctx.source(s, sf) : null)}`).join(",");
const lutSigOf = (comp, frame, ctx) => ocioNeeds(comp, frame).map((x) => x.key + (ctx.ocio && ctx.ocio(x.spec) ? "+" : "-")).join(",");
/** The key renderNode keeps node `id`'s result at `frame` under in `ctx.cache` (another renderer - the GPU - keeps
 *  its pictures under the same key, so the two share one cache). */
export function resultKey(comp, id, frame, ctx) {
    const view = ctx.view || firstView(comp);
    return `${frame}@${ctx.scale || 1}@${view || ""}@${upstreamHash(comp, id)}@${sourceSigOf(comp, id, frame, ctx, view)}@${lutSigOf(comp, frame, ctx)}`;
}

export function renderNode(comp, id, frame, ctx) {
    // Groups, Dots, backdrops and notes: the flat comp (imageViewer_compGraph.js); a group or a Dot shows what it passes on.
    comp = G.flattenComp(comp); id = G.resolveId(comp, id);
    const scale = ctx.scale || 1;
    const view = ctx.view ? ctx.view : firstView(comp);
    const dmemo = ctx.dmemo || (ctx.dmemo = new Map());   // the deep pictures beside the deep nodes' flattened ones
    const W = Math.max(1, Math.round(comp.format.width * scale)), H = Math.max(1, Math.round(comp.format.height * scale));
    const memo = ctx.memo || (ctx.memo = new Map());
    const xmemo = ctx.xmemo || (ctx.xmemo = new Map());   // the extra channels beside each picture
    const keys = new Map(), hashes = new Map();
    // What a cached result also depends on beside the settings: which pixels its Reads were handed (none yet,
    // or which decoded frame) and which OCIO transforms had arrived.
    const sourceSig = (nid, f) => sourceSigOf(comp, nid, f, ctx, view);
    let lut = null;
    const lutSig = () => lut ?? (lut = lutSigOf(comp, frame, ctx));
    // A node's result with its own extra channels (otherwise its first input's are taken, moved for SPATIAL ones).
    const X = (img, ex) => ({ __x: true, img, ex });
    const exOf = (nid, f) => (nid && xmemo.get(`${nid}@${f}`)) || {};
    const run = (nid, f, depth) => {
        if (!nid || depth > 256) return blank(W, H);
        const mk = `${nid}@${f}`;
        if (memo.has(mk)) return memo.get(mk);
        const n = viewNode(nodeById(comp, nid), view);
        let ck = null;
        if (n && !n.disable && ctx.cache && (ctx.cacheIds ? ctx.cacheIds.has(nid) : ctx.cacheAll ? true : HEAVY.has(n.type))) {
            if (!keys.has(nid)) keys.set(nid, upstreamHash(comp, nid, hashes));
            ck = `${f}@${scale}@${view || ""}@${keys.get(nid)}@${sourceSig(nid, f)}@${lutSig()}`;
            if (ctx.keysUsed) ctx.keysUsed.set(mk, ck);
            if (ctx.cache.has(ck)) {
                const kept = ctx.cache.get(ck);
                ctx.cache.delete(ck); ctx.cache.set(ck, kept);   // most recently used last
                memo.set(mk, kept.img); xmemo.set(mk, kept.ex);
                return kept.img;
            }
        }
        let img = make(n, f, depth), ex;
        if (img && img.__x) { ex = img.ex; img = img.img; }
        else if (!n || !NODE_TYPES[n.type] || !NODE_TYPES[n.type].inputs.length || !n.inputs[0]) ex = {};
        else {
            ex = exOf(n.inputs[0], f);
            if (!n.disable && TWO_IN.has(n.type) && n.inputs[1]) {
                // The other input's channels laid as its picture is, at the bottom left of this one.
                const a = run(n.inputs[1], f, depth + 1);
                ex = CH.unionExtras(ex, conformExtras(exOf(n.inputs[1], f), a.w, a.h, img.w, img.h));
            }
        }
        if (n && !n.disable && WRITES.has(n.type) && n.type !== "roto") {
            const w = n.write || "rgba";
            if (w !== "rgba") {
                const base = n.inputs[0] ? run(n.inputs[0], f, depth + 1) : blank(W, H);
                [img, ex] = CH.writeTarget(base, exOf(n.inputs[0], f), conform(img, base.w, base.h), w);
            }
        }
        if (n && !n.disable && MASKABLE.has(n.type)) [img, ex] = maskStage(n, f, depth, img, ex);
        memo.set(mk, img);
        xmemo.set(mk, ex);
        if (ck) cacheKeep(ctx.cache, ck, { img, ex }, ctx.cacheBytes, ctx.cacheMax);
        return img;
    };
    // A MASKABLE node's result held back by its mix and its mask's channel (where it is 0 the input shows).
    const maskStage = (n, f, depth, img, ex) => {
        const mix = OWN_MIX.has(n.type) ? 1 : paramAt(n, "mix", f);
        const mi = n.inputs[maskIndex(n.type)];
        if (!mi && mix === 1) return [img, ex];
        const i0 = n.inputs[0];
        const s0 = i0 ? run(i0, f, depth + 1) : blank(img.w, img.h);
        const src = conform(s0, img.w, img.h), sex = i0 ? conformExtras(exOf(i0, f), s0.w, s0.h, img.w, img.h) : {};
        let m = null;
        if (mi) {
            const mp = run(mi, f, depth + 1);
            const plane = CH.channelOf(mp, exOf(mi, f), n.mask_channel || "a");
            m = plane ? conformPlane(plane, mp.w, mp.h, img.w, img.h) : new Float32Array(img.w * img.h);
        }
        const [mo, mex] = maskMix(src, sex, img, ex, m, mix, (n.mask_invert || "off") === "on");
        return [src.bb && img.bb ? O.withBox(mo, O.boxUnion(src.bb, img.bb)) : mo, mex];
    };
    // A SPATIAL node: its picture and every extra channel through the same operation.
    const spatial = (srcId, f, d1, fn) => { const src = run(srcId, f, d1); return X(fn(src), CH.mapExtras(exOf(srcId, f), src.w, src.h, fn)); };
    const vectorsOf = (srcId, f, depth, n) => O.vectorsImage(run(srcId, f - 1, depth), run(srcId, f, depth), run(srcId, f + 1, depth), {
        smoothness: paramAt(n, "smoothness", f), iterations: paramAt(n, "iterations", f), levels: paramAt(n, "levels", f),
        detail: paramAt(n, "detail", f) }, scale);
    // The size that comes into input k of node n, in pixels of the comp.
    const inFmt = (n, k = 0) => formatAt(comp, n.inputs[k]);
    // ── views: what a node makes in another view (a renderNode of its own, its memo kept per view) ──
    const inView = (nid, f, v) => {
        if ((v || null) === (view || null)) return X(run(nid, f, 0), exOf(nid, f));
        const vm = ctx.vmemo || (ctx.vmemo = new Map());
        if (!vm.has(v)) vm.set(v, {});
        const own = vm.get(v);
        const sub = Object.assign({}, ctx, { memo: own.memo || new Map(), xmemo: own.xmemo || new Map(), dmemo: own.dmemo || new Map(), view: v, vmemo: vm });
        const r = renderNode(comp, nid, f, sub);
        Object.assign(vm.get(v), { memo: sub.memo, xmemo: sub.xmemo, dmemo: sub.dmemo });
        return X({ w: r.w, h: r.h, data: r.data }, r.ch || {});
    };
    const views2 = () => { const vs = viewsOf(comp); return vs.length ? [vs[0], vs[1]] : [null, null]; };
    // ── 3D ──
    const P3 = (n, f) => { const p = {}; for (const k of Object.keys(NODE_TYPES[n.type].params)) p[k] = paramAt(n, k, f); return p; };
    const camNode = (cid) => { const c = cid && viewNode(nodeById(comp, cid), view); return c && !c.disable && c.type === "camera3d" ? c : null; };
    // A camera taking a w x h picture; `stereo`: its eye in this view.
    const cameraOf = (cid, f, w, h, stereo) => {
        const c = camNode(cid), p = c ? P3(c, f) : Object.fromEntries(Object.entries(NODE_TYPES.camera3d.params).map(([k, d]) => [k, clone(d.def)]));
        return G3.cameraAt(p, stereo ? eyeOffset(comp, view, p.interaxial) : 0, w, h);
    };
    const placed = (n, f) => { const p = P3(n, f), u = p.uniform; return G3.trs(p.translate, p.rotate, [p.scale[0] * u, p.scale[1] * u, p.scale[2] * u]); };
    // The scene node `nid` makes: [objects] in world space (see comp3d's renderScene).
    const sceneOf = (nid, f, depth) => {
        const n = nid && depth < 256 ? viewNode(nodeById(comp, nid), view) : null;
        if (!n || n.disable) return [];
        if (n.type === "scene3d") return [].concat(...n.inputs.map((s) => sceneOf(s, f, depth + 1)));
        if (n.type === "card3d" || n.type === "geo3d") {
            const mesh = n.type === "card3d"
                ? G3.cardMesh((() => { const F = inFmt(n); return F.height / F.width; })())
                : G3.shapeMesh(paramAt(n, "shape", f), paramAt(n, "divisions", f));
            const ob = Object.assign({ kind: "mesh", tex: null, proj: null, faces: "both" }, G3.placeMesh(mesh, placed(n, f)));
            const src = n.inputs[0] && viewNode(nodeById(comp, n.inputs[0]), view);
            if (src && !src.disable && src.type === "project3d") {
                const img = run(src.inputs[0], f, depth + 1);
                ob.proj = { img, cam: cameraOf(src.inputs[1], f, img.w, img.h, false) };
                ob.faces = paramAt(src, "faces", f);
            } else if (n.inputs[0]) ob.tex = run(n.inputs[0], f, depth + 1);
            return [ob];
        }
        if (n.type === "pointcloud") {
            const img = n.inputs[0] ? run(n.inputs[0], f, depth + 1) : null;
            if (!img) return [];
            const ch = paramAt(n, "channel", f) || "depth.z";
            const dch = CH.channelOf(img, exOf(n.inputs[0], f), ch);
            const pts = G3.pointsFromDepth(img, dch, cameraOf(n.inputs[1], f, img.w, img.h, false), paramAt(n, "mode", f),
                paramAt(n, "multiply", f), Math.max(1, Math.round(paramAt(n, "step", f) * scale)));
            return [{ kind: "points", pos: pts.pos, col: pts.col, size: paramAt(n, "size", f) * scale }];
        }
        return [];
    };
    const render3d = (n, f, d1) => {
        const r = G3.renderScene(sceneOf(n.inputs[0], f, d1), cameraOf(n.inputs[1], f, W, H, true), W, H, paramAt(n, "samples", f));
        dmemo.set(`${n.id}@${f}`, r.deep);
        let img = r.img, ex = {};
        if (n.inputs[2]) {
            const raw = run(n.inputs[2], f, d1);
            img = mergeImages(conform(raw, W, H), img, null, "over", 1);
            ex = Object.assign({}, conformExtras(exOf(n.inputs[2], f), raw.w, raw.h, W, H));
        }
        if ((n.depth || "depth.z") !== "none") ex["depth.z"] = r.depth;
        return X(img, ex);
    };
    // ── deep ──
    // The deep picture of node `nid`: a deep node's own, a picture's one sample a pixel (DeepFromImage's defaults).
    const deepOf = (nid, f, d1) => {
        const n = nid && viewNode(nodeById(comp, nid), view);
        if (!n) return DP.emptyDeep(W, H);
        if (n.disable && DEEP.has(n.type)) return n.inputs.length && n.inputs[0] ? deepOf(n.inputs[0], f, d1 + 1) : DP.emptyDeep(W, H);
        const img = run(nid, f, d1);
        const own = !n.disable && DEEP.has(n.type) && n.type !== "deepflatten" ? dmemo.get(`${nid}@${f}`) : null;
        if (own) return own;
        const c = conform(img, W, H);
        return DP.deepFromImage(c, c === img ? CH.channelOf(img, exOf(nid, f), "depth.z") : null, 1);
    };
    const deepOut = (n, f, d) => {
        dmemo.set(`${n.id}@${f}`, d);
        const fl = DP.deepFlatten(d);
        return X(fl.img, { "depth.z": fl.depth });
    };
    const make = (n, f, depth) => {
        const d1 = depth + 1;
        if (!n) return blank(W, H);
        if (n.disable) return NODE_TYPES[n.type].inputs.length ? run(n.inputs[0], f, d1) : blank(W, H);
        switch (n.type) {
        case "read": {
            const src = ctx.source ? ctx.source(n, f) : null;
            // A source may come shrunk (the page's proxy): `ow` x `oh` is the file's own size then.
            const k = src ? scale * (src.ow ? src.ow / src.w : 1) : 1;
            if (!src) return O.withBox(blank(W, H), [0, 0, 0, 0]);
            const img = resample(src, fitMatrix(src.w, src.h, W, H, n.fit || "fit", k), W, H);
            return O.withBox(img, O.scanBox(img));
        }
        case "constant": {
            const c = paramAt(n, "color", f) || [0, 0, 0, 1];
            const img = blank(W, H), a = c[3];
            for (let i = 0; i < W * H * 4; i += 4) { img.data[i] = c[0] * a; img.data[i + 1] = c[1] * a; img.data[i + 2] = c[2] * a; img.data[i + 3] = a; }
            return img;
        }
        case "merge": {
            if (!mergeLive(n, f)) return run(n.inputs[0], f, d1);
            const B = run(n.inputs[0], f, d1), A = conform(run(n.inputs[1], f, d1), B.w, B.h);
            const M = n.inputs[2] ? conform(run(n.inputs[2], f, d1), B.w, B.h) : null;
            return mergeImages(B, A, M, n.operation || "over", paramAt(n, "mix", f));
        }
        case "transform": { const m = transformMatrix(n, f, inFmt(n), scale); return spatial(n.inputs[0], f, d1, (p) => resample(p, m, p.w, p.h)); }
        case "grade": {
            const p = {};
            for (const k of Object.keys(NODE_TYPES.grade.params)) p[k] = paramAt(n, k, f);
            const g0 = run(n.inputs[0], f, d1);
            return g0.bb ? O.withBox(gradeImage(g0, p), g0.bb) : gradeImage(g0, p);
        }
        case "lumakeyer": case "chromakeyer": case "erode": case "laplacian": case "channelmath": {
            const p = {};
            for (const k of Object.keys(NODE_TYPES[n.type].params)) p[k] = paramAt(n, k, f);
            const src = run(n.inputs[0], f, d1);
            if (n.type === "lumakeyer") return K.lumaKeyImage(src, p);
            if (n.type === "chromakeyer") return K.chromaKeyImage(src, p);
            if (n.type === "erode") { p.size *= scale; return K.erodeImage(src, p); }
            if (n.type === "laplacian") { p.size *= scale; return K.laplacianImage(src, p); }
            return K.channelMathImage(src, p);
        }
        case "channelmerge": {
            const p = {};
            for (const k of Object.keys(NODE_TYPES.channelmerge.params)) p[k] = paramAt(n, k, f);
            const B = run(n.inputs[0], f, d1);
            return K.channelMergeImage(B, n.inputs[1] ? conform(run(n.inputs[1], f, d1), B.w, B.h) : null, p);
        }
        case "glow": {
            const p = {};
            for (const k of Object.keys(NODE_TYPES.glow.params)) p[k] = paramAt(n, k, f);
            p.size *= scale;
            return LT.glowImage(run(n.inputs[0], f, d1), p);
        }
        case "lensflare": {
            const p = {};
            for (const k of Object.keys(NODE_TYPES.lensflare.params)) p[k] = paramAt(n, k, f);
            // On a picture: that picture's size (the light in its pixels); without one, the comp's.
            const src = n.inputs[0] ? run(n.inputs[0], f, d1) : null, w = src ? src.w : W, h = src ? src.h : H;
            return LT.flareImage(src, n.inputs[1] ? conform(run(n.inputs[1], f, d1), w, h) : null, p, w, h, scale);
        }
        case "ocio_colorspace": case "ocio_display": {
            const p = {};
            for (const k of Object.keys(NODE_TYPES[n.type].params)) p[k] = paramAt(n, k, f);
            const src = run(n.inputs[0], f, d1);
            const lut = ctx.ocio ? ctx.ocio(OC.ocioSpec(n.type, p)) : null;
            return lut ? OC.ocioImage(src, (r, g, b) => OC.lutColor(lut, r, g, b), p.unpremult !== "off") : src;
        }
        case "colorcorrect": {
            const p = {};
            for (const k of Object.keys(NODE_TYPES.colorcorrect.params)) p[k] = paramAt(n, k, f);
            return colorCorrectImage(run(n.inputs[0], f, d1), p);
        }
        case "blur": { const sz = paramAt(n, "size", f) * scale; return spatial(n.inputs[0], f, d1, (p) => blurImage(p, sz)); }
        case "reformat": {
            const L = reformatLayout(n, f, inFmt(n), scale);
            return spatial(n.inputs[0], f, d1, (p) => resample(p, L.m, L.w, L.h));
        }
        case "crop": {
            const tl = paramAt(n, "topleft", f) || [0, 0];
            const F = inFmt(n), br = paramAt(n, "bottomright", f) || [F.width, F.height];
            const soft = paramAt(n, "softness", f) * scale;
            return spatial(n.inputs[0], f, d1, (p) => {
                const c = O.cropImage(p, tl[0] * scale, tl[1] * scale, br[0] * scale, br[1] * scale, soft);
                const L = tl[0] * scale, T = tl[1] * scale, R = br[0] * scale, B = br[1] * scale, pb = O.boxOf(p);
                const cb = O.boxClip([Math.floor(L) - 1, Math.floor(T) - 1, Math.ceil(R) + 1, Math.ceil(B) + 1], p.w, p.h);
                return O.withBox(c, O.boxClip([Math.max(cb[0], pb[0]), Math.max(cb[1], pb[1]), Math.min(cb[2], pb[2]), Math.min(cb[3], pb[3])], p.w, p.h));
            });
        }
        case "shuffle": {
            const src = run(n.inputs[0], f, d1);
            const [img, ex] = CH.shuffleChannels(src, exOf(n.inputs[0], f), n.out || "rgba", ["r", "g", "b", "a"].map((k) => n[k] || k));
            return X(img, ex);
        }
        case "addchannels": {
            const src = run(n.inputs[0], f, d1);
            const [img, ex] = CH.addChannels(src, exOf(n.inputs[0], f), CH.parseChannels(n.channels ?? NODE_TYPES.addchannels.params.channels.def), paramAt(n, "value", f) || 0);
            return X(img, ex);
        }
        case "removechannels": {
            const src = run(n.inputs[0], f, d1);
            const [img, ex] = CH.removeChannels(src, exOf(n.inputs[0], f), CH.parseChannels(n.channels), n.operation === "keep");
            return X(img, ex);
        }
        case "copy": {
            const pick = ["r", "g", "b", "a"].map((k) => n[k] || NODE_TYPES.copy.params[k].def);
            const B = run(n.inputs[0], f, d1);
            return O.copyImage(B, conform(run(n.inputs[1], f, d1), B.w, B.h), pick);
        }
        case "premult": return O.premultImage(run(n.inputs[0], f, d1));
        case "unpremult": return O.unpremultImage(run(n.inputs[0], f, d1));
        case "retime": {
            const t = retimeFrame(n, f), s0 = n.inputs[0];
            const at = (g) => X(run(s0, g, d1), exOf(s0, g));
            if (n.blend !== "mix" && n.blend !== "vectors") return at(Math.floor(t + 0.5));
            const f0 = Math.floor(t), fr = t - f0;
            if (fr < 1e-9) return at(f0);
            const a = run(s0, f0, d1), b = run(s0, f0 + 1, d1);
            const pic = n.blend === "vectors" ? EX.F.vectorBlend(a, conform(b, a.w, a.h), fr) : mixImages(a, b, fr);
            return X(pic, CH.mixExtras(exOf(s0, f0), exOf(s0, f0 + 1), fr, a.w * a.h));
        }
        case "keyer": {
            const p = {};
            for (const k of Object.keys(NODE_TYPES.keyer.params)) p[k] = paramAt(n, k, f);
            return O.keyImage(run(n.inputs[0], f, d1), p);
        }
        case "roto": {
            // The matte comes from the page (the viewer's Roto code, imageViewer_roto.js rotoMatte); none: empty.
            // The shapes are drawn on the comp's format; on a picture of another size the matte is laid as it would be.
            let matte = (ctx.matte && ctx.matte(n, f, W, H)) || new Float64Array(W * H);
            const src = n.inputs[0] ? run(n.inputs[0], f, d1) : null, w = src ? src.w : W, h = src ? src.h : H;
            if (w !== W || h !== H) matte = conformPlane(matte, W, H, w, h);
            const [img, ex] = CH.rotoWrite(matte, w, h, src, exOf(n.inputs[0], f), n.write || "rgba", n.premult !== "off");
            return X(O.withBox(img, O.scanBox(img)), ex);
        }
        case "paint": {
            // Strokes on the picture that comes in (the comp's size without one); clone / reveal read pictures moved by
            // their offset, at other frames for a dt. Pictures of another size meet at the bottom left.
            const src = n.inputs[0] ? run(n.inputs[0], f, d1) : blank(W, H);
            const strokes = PT.liveStrokes(n.strokes, f);
            if (!strokes.length) return src;
            const shifted = new Map();
            const moved = (img, s) => {
                const ox = -s.offset[0] * scale, oy = -s.offset[1] * scale;
                return ox || oy ? resample(img, mat.t(ox, oy), img.w, img.h) : img;
            };
            const sourceOf = (s, now) => {
                if (s.tool === "reveal" && !n.inputs[1]) return null;
                if (s.tool === "clone" && !s.dt) return moved(now, s);
                const key = `${s.tool}@${s.dt}@${s.offset[0]},${s.offset[1]}`;
                if (!shifted.has(key)) {
                    const pic = s.tool === "reveal" ? conform(run(n.inputs[1], f + s.dt, d1), src.w, src.h) : run(n.inputs[0], f + s.dt, d1);
                    shifted.set(key, moved(pic, s));
                }
                return shifted.get(key);
            };
            return PT.paintImage(src, strokes, scale, sourceOf, (s) => linkMatrix(comp, s, f));
        }
        case "vectors": return vectorsOf(n.inputs[0], f, d1, n);
        case "motionblur": {
            const src = run(n.inputs[0], f, d1);
            const vec = n.inputs[1] ? run(n.inputs[1], f, d1) : vectorsOf(n.inputs[0], f, d1, { type: "vectors" });
            return O.motionBlurImage(src, conform(vec, src.w, src.h), paramAt(n, "shutter", f), paramAt(n, "samples", f), n.offset || "centred", scale);
        }
        case "defocus": {
            const p = {};
            for (const k of Object.keys(NODE_TYPES.defocus.params)) p[k] = paramAt(n, k, f);
            p.size *= scale;
            return O.defocusImage(run(n.inputs[0], f, d1), p);
        }
        case "depthblur": {
            const src = run(n.inputs[0], f, d1);
            if (!n.inputs[1]) return src;
            const p = {};
            for (const k of Object.keys(NODE_TYPES.depthblur.params)) p[k] = paramAt(n, k, f);
            p.size *= scale;
            return O.depthBlurImage(src, conform(run(n.inputs[1], f, d1), src.w, src.h), p);
        }
        case "camera3d": case "card3d": case "geo3d": case "scene3d": case "pointcloud": {
            // Geometry on its own: seen through the comp's first Camera, as Render3D would draw it.
            if (n.type === "camera3d") return X(blank(W, H), {});
            const cam = comp.nodes.find((c) => c.type === "camera3d" && !c.disable);
            const r = G3.renderScene(sceneOf(n.id, f, d1), cameraOf(cam ? cam.id : null, f, W, H, true), W, H, 1);
            return X(r.img, {});
        }
        case "project3d": return X(run(n.inputs[0], f, d1), exOf(n.inputs[0], f));
        case "render3d": return render3d(n, f, d1);
        case "deepread": {
            const src = ctx.deepSource ? ctx.deepSource(n, f) : null;
            return deepOut(n, f, src ? DP.deepPlace(src, comp.format.width, comp.format.height, scale) : DP.emptyDeep(W, H));
        }
        case "deepfromimage": {
            const img = n.inputs[0] ? conform(run(n.inputs[0], f, d1), W, H) : blank(W, H);
            const same = n.inputs[0] && run(n.inputs[0], f, d1) === img;
            return deepOut(n, f, DP.deepFromImage(img, same ? CH.channelOf(img, exOf(n.inputs[0], f), paramAt(n, "channel", f) || "depth.z") : null, paramAt(n, "z", f)));
        }
        case "deepmerge": {
            const ins = n.inputs.filter(Boolean);
            return deepOut(n, f, ins.length ? DP.deepMerge(ins.map((s) => deepOf(s, f, d1))) : DP.emptyDeep(W, H));
        }
        case "deepholdout": {
            const src = deepOf(n.inputs[0], f, d1);
            return deepOut(n, f, n.inputs[1] ? DP.deepHoldout(src, deepOf(n.inputs[1], f, d1)) : src);
        }
        case "deepcrop": return deepOut(n, f, DP.deepCrop(deepOf(n.inputs[0], f, d1), paramAt(n, "znear", f), paramAt(n, "zfar", f), n.outside === "on"));
        case "deepflatten": { const fl = DP.deepFlatten(deepOf(n.inputs[0], f, d1)); return X(fl.img, { "depth.z": fl.depth }); }
        case "oneview": {
            const v = paramAt(n, "view", f) || firstView(comp);
            return viewsOf(comp).includes(v) ? inView(n.inputs[0], f, v) : X(run(n.inputs[0], f, d1), exOf(n.inputs[0], f));
        }
        case "joinviews": {
            const i = Math.max(0, viewsOf(comp).indexOf(view));
            const s0 = n.inputs[Math.min(i, 3)] || n.inputs[0];
            return X(run(s0, f, d1), exOf(s0, f));
        }
        case "anaglyph": case "sidebyside": {
            const [vl, vr] = views2();
            const L = inView(n.inputs[0], f, vl).img, R = conform(inView(n.inputs[0], f, vr).img, L.w, L.h);
            return X(n.type === "anaglyph" ? anaglyphImage(L, R, n.mode || "colour") : sideBySide(L, R, n.layout === "over under"), {});
        }
        case "cornerpin": {
            const { from, to } = WP.pinCorners((p) => paramAt(n, p, f), inFmt(n));
            const inv = n.invert === "on" ? WP.homography(from, to) : WP.homography(to, from);
            return spatial(n.inputs[0], f, d1, (p) => WP.homographyImage(p, inv, scale));
        }
        case "stmap": {
            const src = run(n.inputs[0], f, d1);
            if (!n.inputs[1]) return X(src, exOf(n.inputs[0], f));
            const M = run(n.inputs[1], f, d1), mex = exOf(n.inputs[1], f);
            const us = CH.channelOf(M, mex, n.u || "r") || new Float32Array(M.w * M.h), vs = CH.channelOf(M, mex, n.v || "g") || new Float32Array(M.w * M.h);
            const [U, V] = WP.stMap(us, vs, M.w, M.h, src.w, src.h);
            return spatial(n.inputs[0], f, d1, (p) => WP.sampleMap(p, U, V, M.w, M.h));
        }
        case "vectorwarp": {
            const src = run(n.inputs[0], f, d1);
            if (!n.inputs[1]) return X(src, exOf(n.inputs[0], f));
            const Vi = run(n.inputs[1], f, d1), vex = conformExtras(exOf(n.inputs[1], f), Vi.w, Vi.h, src.w, src.h), Vc = conform(Vi, src.w, src.h);
            const us = CH.channelOf(Vc, vex, n.u || "r") || new Float32Array(src.w * src.h), vs = CH.channelOf(Vc, vex, n.v || "g") || new Float32Array(src.w * src.h);
            const [U, V] = WP.vectorMap(us, vs, src.w, src.h, paramAt(n, "amount", f), scale);
            return spatial(n.inputs[0], f, d1, (p) => WP.sampleMap(p, U, V, src.w, src.h));
        }
        case "lensdistortion": {
            const src = run(n.inputs[0], f, d1);
            const p = { mode: n.mode || "undistort", k1: paramAt(n, "k1", f), k2: paramAt(n, "k2", f), center: paramAt(n, "center", f), zoom: paramAt(n, "zoom", f) };
            const [U, V] = WP.lensMap(src.w, src.h, p, scale);
            if (n.output === "stmap") return X(WP.mapAsSt(U, V, src.w, src.h, src.w, src.h), {});
            return spatial(n.inputs[0], f, d1, (q) => WP.sampleMap(q, U, V, src.w, src.h));
        }
        case "gridwarp": {
            const src = run(n.inputs[0], f, d1);
            const [sp, dp] = gridPoints(n, f, inFmt(n));
            const [U, V] = WP.gridMap(sp, dp, src.w, src.h, scale);
            return spatial(n.inputs[0], f, d1, (q) => WP.sampleMap(q, U, V, src.w, src.h));
        }
        case "tracker": case "planartracker": {
            const how = n.transform || "none";
            const mo = how === "none" ? null : trackMotion(n, f);
            if (!mo) return X(run(n.inputs[0], f, d1), exOf(n.inputs[0], f));
            if (mo.kind === "perspective") {
                // Match-move: each output pixel reads where it was at the reference; stabilise: where it is now.
                const inv = how === "match-move" ? WP.homography(mo.Q, mo.P) : WP.homography(mo.P, mo.Q);
                return spatial(n.inputs[0], f, d1, (p) => WP.homographyImage(p, inv, scale));
            }
            const m0 = how === "match-move" ? mo.m : WP.invertAffine(mo.m);
            const m = mat.mul(mat.s(scale, scale), mat.mul(m0, mat.s(1 / scale, 1 / scale)));
            return spatial(n.inputs[0], f, d1, (p) => resample(p, m, p.w, p.h));
        }
        case "output": case "write": case "metadata": return run(n.inputs[0], f, d1);
        default: {
            const r = EX.extraMake(n, f, {
                run: (sid, g) => run(sid, g, d1), X, exOf, scale, W, H, blank, resample, fitMatrix, conform, mixImages,
                P: (nn, g) => { const p = {}; for (const k of Object.keys(NODE_TYPES[nn.type].params)) p[k] = paramAt(nn, k, g); return p; },
                size: (nn, k) => { const F = inFmt(nn, k); return [Math.max(1, Math.round(F.width * scale)), Math.max(1, Math.round(F.height * scale))]; },
                source: ctx.source, ocio: ctx.ocio,
                ocioImage: (img, lut, unp) => OC.ocioImage(img, (r, g, b) => OC.lutColor(lut, r, g, b), unp),
            });
            return r === undefined ? blank(W, H) : r;
        }
        }
    };
    const img = run(id, frame, 0);
    return { w: img.w, h: img.h, data: img.data, ch: exOf(id, frame) };
}

/** Red from the left eye, green and blue from the right ("grey": each eye's luminance); alpha the larger. */
export function anaglyphImage(L, R, mode) {
    const out = blank(L.w, L.h), o = out.data, a = L.data, b = R.data;
    for (let i = 0; i < L.w * L.h * 4; i += 4) {
        if (mode === "grey") {
            const yl = 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2], yr = 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
            o[i] = yl; o[i + 1] = yr; o[i + 2] = yr;
        } else { o[i] = a[i]; o[i + 1] = b[i + 1]; o[i + 2] = b[i + 2]; }
        o[i + 3] = Math.max(a[i + 3], b[i + 3]);
    }
    return out;
}
/** Two pictures of one size next to each other (left first) or above each other (left on top). */
export function sideBySide(L, R, over) {
    const w = L.w, h = L.h, out = blank(over ? w : w * 2, over ? h * 2 : h);
    for (let y = 0; y < h; y++) {
        out.data.set(L.data.subarray(y * w * 4, (y + 1) * w * 4), over ? y * w * 4 : y * w * 8);
        out.data.set(R.data.subarray(y * w * 4, (y + 1) * w * 4), over ? (y + h) * w * 4 : y * w * 8 + w * 4);
    }
    return out;
}

/** A GridWarp's two point lists at frame f (flat [x, y, ...], pixels of its input): the source grid, and the
 *  destination as far as ``distortion`` takes it. A list of the wrong length counts as not there (the even grid). */
export function gridPoints(n, f, fmt) {
    const cols = Math.max(2, Math.min(16, Math.round(n.cols || 5))), rows = Math.max(2, Math.min(16, Math.round(n.rows || 5)));
    const len = 2 * cols * rows, ok = (a) => Array.isArray(a) && a.length === len && a.every(isNum);
    const sp = ok(n.src_points) ? n.src_points : WP.lattice(cols, rows, fmt.width, fmt.height);
    const raw = paramAt(n, "dst_points", f), dr = ok(raw) ? raw : sp;
    const k = paramAt(n, "distortion", f);
    return [sp, sp.map((v, i) => v + (dr[i] - v) * k)];
}

/** A Tracker's or PlanarTracker's motion from its reference frame to frame f: solveMotion's answer, with the point
 *  sets (P at the reference, Q now) for a perspective; null when the points do not reach both frames. */
export function trackMotion(n, f) {
    const ref = Math.round(n.reference || 0);
    if (n.type === "planartracker") {
        const keys = n.plane && n.plane.keys;
        if (!WP.trackHas(keys, ref) || !WP.trackHas(keys, f)) return null;
        const P = WP.quadAt(keys, ref), Q = WP.quadAt(keys, f);
        return { kind: "perspective", P, Q };
    }
    const { P, Q } = WP.trackPairs(n.points, ref, f);
    const mo = WP.solveMotion(P, Q, n.motion || "translate");
    if (mo && mo.kind === "perspective") { mo.P = P.slice(0, 4); mo.Q = Q.slice(0, 4); }
    return mo;
}
export { WP };

export const TRACK_BAKES = ["stabilise", "match-move", "corner pin"];
/** The frames a Tracker's or PlanarTracker's motion is known at: every frame of the comp it reaches from its reference. */
export function trackFrames(comp, n) {
    const out = [];
    for (let f = 0; f < comp.format.frames; f++) if (trackMotion(n, f)) out.push(f);
    return out;
}
/**
 * A Tracker's / PlanarTracker's motion as a new keyed node (not wired: it is put beside the tracker, for the
 * picture it should move): "stabilise" / "match-move" a Transform (a key a frame: translate, rotate, scale and,
 * for stabilise, its centre), or a CornerPin for a perspective / a surface (its from corners the reference's, its
 * to corners keyed; stabilise = invert on). "corner pin" is a match-move CornerPin from the first four points, or
 * the surface. Returns the node added, or null when there is nothing to bake.
 */
export function bakeTrack(comp, trackerId, how) {
    const n = nodeById(comp, trackerId);
    if (!n || (n.type !== "tracker" && n.type !== "planartracker")) return null;
    const pin = how === "corner pin" || n.type === "planartracker" || n.motion === "perspective";
    const probe = pin && n.type === "tracker" ? Object.assign({}, n, { motion: "perspective" }) : n;
    const frames = trackFrames(comp, probe);
    if (!frames.length) return null;
    const key = (f, v) => ({ f, v, ease: "linear" });
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const at = { x: n.x + NODE_W + 30, y: n.y, name: undefined };
    const label = n.name || n.id;
    let node;
    if (pin) {
        const first = trackMotion(probe, frames[0]);
        if (!first || first.kind !== "perspective") return null;
        node = makeNode(comp, "cornerpin", Object.assign(at, { name: `${label} ${how === "stabilise" ? "stabilise" : "pin"}`,
            invert: how === "stabilise" ? "on" : "off" }));
        first.P.forEach((p, k) => { node[`from${k + 1}`] = p.map(r4); });
        node.tracks = {};
        for (let k = 0; k < 4; k++) node.tracks[`to${k + 1}`] = frames.map((f) => key(f, trackMotion(probe, f).Q[k].map(r4)));
    } else {
        node = makeNode(comp, "transform", Object.assign(at, { name: `${label} ${how}` }));
        const t = [], r = [], sc = [], c = [];
        for (const f of frames) {
            const mo = trackMotion(n, f);
            if (how === "match-move") { t.push(key(f, [r4(mo.cQ[0] - mo.cP[0]), r4(mo.cQ[1] - mo.cP[1])])); r.push(key(f, r4(mo.angle))); sc.push(key(f, [r4(mo.s), r4(mo.s)])); }
            else { t.push(key(f, [r4(mo.cP[0] - mo.cQ[0]), r4(mo.cP[1] - mo.cQ[1])])); r.push(key(f, r4(-mo.angle))); sc.push(key(f, [r4(1 / mo.s), r4(1 / mo.s)])); c.push(key(f, mo.cQ.map(r4))); }
        }
        const mo0 = trackMotion(n, frames[0]);
        node.tracks = { translate: t };
        if (n.motion === "rotate" || n.motion === "scale") node.tracks.rotate = r;
        if (n.motion === "scale") node.tracks.scale = sc;
        if (how === "match-move") node.center = mo0.cP.map(r4); else node.tracks.center = c;
    }
    if (!node.name) delete node.name;
    addNode(comp, node);
    return node;
}

/** a x (1 - t) + b x t. */
export function mixImages(a, b, t) {
    const out = blank(a.w, a.h), o = out.data, x = a.data, y = b.data;
    for (let i = 0; i < a.w * a.h * 4; i++) o[i] = x[i] + (y[i] - x[i]) * t;
    return out;
}

/** The Reads `id` depends on (what has to be loaded before it can be drawn). */
export function sourcesOf(comp, id) {
    const out = [];
    const seen = new Set();
    for (const { node } of sourceNeeds(comp, id, 0)) if (!seen.has(node.id)) { seen.add(node.id); out.push(node); }
    return out;
}

/** Every Read and comp frame `id` reads to be drawn at `frame`: [{node, frame}], each once. */
export function sourceNeeds(comp, id, frame, view = null) {
    comp = G.flattenComp(comp); id = G.resolveId(comp, id);
    const out = [], seen = new Set();
    const vs = viewsOf(comp);
    const walk = (nid, f, depth, v) => {
        const key = `${nid}@${f}#${v || ""}`;
        if (!nid || depth > 256 || seen.has(key)) return;
        seen.add(key);
        const n = viewNode(nodeById(comp, nid), v);
        if (!n) return;
        if (n.disable) { if (n.inputs.length) walk(n.inputs[0], f, depth + 1, v); return; }
        if (n.type === "read") { out.push({ node: n, frame: f, view: v }); return; }
        if (n.type === "deepread") { out.push({ node: n, frame: f, view: v, deep: true }); return; }
        if (n.type === "oneview") { const w = paramAt(n, "view", f) || vs[0] || null; walk(n.inputs[0], f, depth + 1, vs.includes(w) ? w : v); return; }
        if (n.type === "anaglyph" || n.type === "sidebyside") { for (const w of vs.length ? vs.slice(0, 2) : [v]) walk(n.inputs[0], f, depth + 1, w); return; }
        if (n.type === "joinviews") { const i = Math.max(0, vs.indexOf(v)); walk(n.inputs[Math.min(i, 3)] || n.inputs[0], f, depth + 1, v); return; }
        if (EX.AI_KINDS[n.type]) { const rd = EX.aiRead(n, f); if (rd) out.push({ node: rd, frame: f, view: v }); }
        if (EX.VFX_KINDS[n.type] && !n.disable) { const rd = EX.vfxRead(n, f); if (rd) out.push({ node: rd, frame: f, view: v }); }
        const xr = EX.extraReads(n, f);
        if (xr) { for (const [k, g] of xr) walk(n.inputs[k], g, depth + 1, v); return; }
        if (n.type === "retime") {
            const t = retimeFrame(n, f);
            if (n.blend !== "mix" && n.blend !== "vectors") walk(n.inputs[0], Math.floor(t + 0.5), depth + 1, v);
            else { const f0 = Math.floor(t); walk(n.inputs[0], f0, depth + 1, v); if (t - f0 >= 1e-9) walk(n.inputs[0], f0 + 1, depth + 1, v); }
            return;
        }
        if (n.type === "vectors" || (n.type === "motionblur" && !n.inputs[1])) {
            for (const g of [f - 1, f, f + 1]) walk(n.inputs[0], g, depth + 1, v);
            if (n.type === "vectors") return;
        }
        if (n.type === "depthblur" && !n.inputs[1]) { walk(n.inputs[0], f, depth + 1, v); return; }
        if (n.type === "paint") {
            const fr = PT.paintFrames(n.strokes, f);
            for (const g of fr.clone) walk(n.inputs[0], g, depth + 1, v);
            if (n.inputs[1]) for (const g of fr.reveal) walk(n.inputs[1], g, depth + 1, v);
            walk(n.inputs[0], f, depth + 1, v);
            return;
        }
        for (const s of n.inputs) walk(s, f, depth + 1, v);
    };
    walk(id, frame, 0, view || vs[0] || null);
    return out;
}

/** Which file frame a Read shows at comp frame `f`, given what its file is ({kind, first, last}). */
export function sourceFrame(node, info, f) {
    if (!info || info.kind === "still") return null;
    const first = isNum(info.first) ? info.first : 0;
    const last = isNum(info.last) ? info.last : first;
    const n = first + f - (node.offset || 0);
    return Math.max(first, Math.min(last, n));
}
