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
import { blank, blurImage, boxesForGauss } from "./imageViewer_compOps.js";
export { blank, blurImage, boxesForGauss };

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
export const REFORMAT_RESIZE = ["none", "fit", "fill", "width", "height", "distort"];
export const NODE_TYPES = {
    read: { label: "Read", cat: "Image", inputs: [], params: {
        file: { kind: "file", def: "" },
        offset: { kind: "int", def: 0, help: "Frames to slide the footage by: +10 starts it 10 frames later" },
        colorspace: { kind: "ocio_cs", def: "auto", choices: COLORSPACES, help: "What the file holds. auto: EXR / HDR are linear, the rest sRGB; or any colourspace of the OCIO config, converted to the working space" },
        fit: { kind: "enum", def: "fit", choices: FITS, help: "How a picture of another size is laid into the comp" },
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
        blend: { kind: "enum", def: "nearest", choices: ["nearest", "mix"], help: "Between frames: the nearest, or the two mixed" },
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
    output: { label: "Output", cat: "Other", inputs: ["src"], params: {} },
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
for (const t of MASKABLE) {
    const d = NODE_TYPES[t];
    d.inputs = [...d.inputs, "mask"];
    if (!d.params.mix) d.params.mix = { kind: "num", def: 1, min: 0, max: 1, step: 0.01, key: true, help: "How much of the result: 0 is what comes in" };
    d.params.mask_channel = { kind: "chan", def: "a", from: "mask", label: "mask channel", help: "The mask input's channel that says where the node acts" };
    d.params.mask_invert = { kind: "enum", def: "off", choices: ["off", "on"], label: "invert mask" };
}
/** The index of a MASKABLE node's mask input (-1 for the rest). */
export function maskIndex(type) { return MASKABLE.has(type) ? NODE_TYPES[type].inputs.length - 1 : -1; }
export const TYPE_ORDER = ["read", "constant", "roto", "merge", "copy", "transform", "reformat", "crop", "grade", "colorcorrect", "ocio_colorspace", "ocio_display", "keyer", "lumakeyer", "chromakeyer", "blur", "glow", "erode", "laplacian",
    "motionblur", "depthblur", "defocus", "lensflare", "shuffle", "addchannels", "removechannels", "channelmerge", "channelmath", "premult", "unpremult", "retime", "vectors", "output"];
/** Nodes whose result is kept between renders (keyed by their whole upstream): they take long. */
export const HEAVY = new Set(["vectors", "motionblur", "depthblur", "defocus"]);
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
    const seen = new Set();
    for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
        if (!isObj(n) || !NODE_TYPES[n.type]) { errors.push(`a node of unknown type ${isObj(n) ? n.type : n} was left out`); continue; }
        if (typeof n.id !== "string" || !n.id || seen.has(n.id)) { errors.push(`a ${n.type} node without its own id was left out`); continue; }
        seen.add(n.id);
        const t = NODE_TYPES[n.type];
        const node = clone(n);
        node.x = isNum(n.x) ? n.x : 0; node.y = isNum(n.y) ? n.y : 0;
        const ins = Array.isArray(n.inputs) ? n.inputs : [];
        node.inputs = t.inputs.map((_, i) => (typeof ins[i] === "string" ? ins[i] : null));
        if (node.tracks && !isObj(node.tracks)) delete node.tracks;
        // A layer's length: whole frames, out after in (a Merge's only).
        for (const k of ["in", "out"]) { if (node.type !== "merge" || !isNum(node[k])) delete node[k]; else node[k] = Math.round(node[k]); }
        if (isNum(node.in) && isNum(node.out) && node.out <= node.in) { errors.push(`${node.id}: its out was not after its in and was taken off`); delete node.out; }
        comp.nodes.push(node);
    }
    for (const n of comp.nodes) n.inputs = n.inputs.map((id) => (id && seen.has(id) && id !== n.id ? id : null));
    // Cycles are not a picture: the input that closes one goes.
    for (const n of comp.nodes) n.inputs = n.inputs.map((id, i) => {
        if (!id) return null;
        n.inputs[i] = null;
        const bad = reaches(comp, id, n.id);
        if (bad) errors.push(`${n.id}: an input that made a loop was taken off`);
        return bad ? null : id;
    });
    if (!comp.output || !nodeById(comp, comp.output) || nodeById(comp, comp.output).type !== "output") {
        const o = comp.nodes.find((n) => n.type === "output");
        comp.output = o ? o.id : null;
    }
    return { comp, errors };
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
    node.inputs = t.inputs.map((_, i) => (extra.inputs && extra.inputs[i]) || null);
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
/** Where input ``port`` of a node sits along its top edge (graph units from its left). */
export function portX(n, i) { return ((i + 1) / ((NODE_TYPES[n.type] || { inputs: [0] }).inputs.length + 1)) * NODE_W; }
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
        if (s) out.push({ src, dst: n.id, port, curve: wireCurve(s.x + NODE_W / 2, s.y + NODE_H, n.x + portX(n, port), n.y) });
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
    return !!(n && n.type !== "output" && n.inputs.length && !n.inputs[0] && !consumers(comp, id).length);
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
export function paramAt(node, p, frame) {
    const d = NODE_TYPES[node.type] && NODE_TYPES[node.type].params[p];
    const own = node[p] !== undefined ? node[p] : d ? d.def : undefined;
    if (!d || !d.key) return clone(own);
    const v = valueAt({ tracks: node.tracks, [p]: own }, p, frame);
    if (d.kind === "num" && isNum(v)) {
        let x = v;
        if (d.min !== undefined && x < d.min) x = d.min;
        if (d.max !== undefined && x > d.max) x = d.max;
        return x;
    }
    return v;
}

/** Every key frame of a node, sorted. */
export function nodeKeyFrames(node) {
    const out = new Set();
    for (const list of Object.values((node && node.tracks) || {})) for (const k of list || []) out.add(k.f);
    return [...out].sort((a, b) => a - b);
}

// ── the stack the Layers panel shows ─────────────────────────────────────────

const CHAIN = new Set(["transform", "reformat", "glow", "lensflare", "grade", "colorcorrect", "ocio_colorspace", "ocio_display", "lumakeyer", "chromakeyer", "erode", "laplacian", "channelmerge", "channelmath", "blur", "crop", "shuffle", "addchannels", "removechannels", "premult", "unpremult", "retime", "keyer", "vectors",
    "motionblur", "depthblur", "defocus", "copy"]);

/**
 * The comp as layers, top first: [{ kind: "layer" | "background" | "group", merge?, chain: [ids top-down],
 * source?, name }]. `chain` runs from the node the Merge reads (its A) up to the source; `source` is the
 * Read / Input / Constant at its end. A layer whose A branch holds another Merge is a "group".
 */
export function layerStack(comp) {
    const out = [];
    const outNode = nodeById(comp, comp.output);
    let id = outNode ? outNode.inputs[0] : null;
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
        seen.add(id);
        if (n.type === "merge") {
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
    if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 && sw === w && sh === h) { o.set(s); return out; }
    const iv = mat.inv(m);
    for (let y = 0; y < h; y++) {
        const py = y + 0.5;
        for (let x = 0; x < w; x++) {
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
export function formatAt(comp, id, depth = 0) {
    const F = { width: comp.format.width, height: comp.format.height };
    const n = id && depth < 256 && nodeById(comp, id);
    if (!n || !NODE_TYPES[n.type]) return F;
    const up = () => (NODE_TYPES[n.type].inputs.length && n.inputs[0] ? formatAt(comp, n.inputs[0], depth + 1) : F);
    if (n.disable || n.type !== "reformat") return n.type === "read" || n.type === "constant" ? F : up();
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
    return out;
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

export function mergeImages(Bimg, Aimg, Mimg, op, mix) {
    const w = Bimg.w, h = Bimg.h, out = blank(w, h), o = out.data, B = Bimg.data, A = Aimg.data, M = Mimg ? Mimg.data : null;
    const f = OPS[op] || OPS.over;
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
    const out = new Map();
    for (const n of comp.nodes || []) {
        if (n.disable || (n.type !== "ocio_colorspace" && n.type !== "ocio_display")) continue;
        const p = {};
        for (const k of Object.keys(NODE_TYPES[n.type].params)) p[k] = paramAt(n, k, frame);
        const spec = OC.ocioSpec(n.type, p);
        out.set(OC.ocioKey(spec), spec);
    }
    return [...out].map(([key, spec]) => ({ key, spec }));
}
export { OC, CH };

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
    const n = id && nodeById(comp, id);
    if (!n || depth > 256) return [];
    const ins = (i) => channelsAt(comp, n.inputs[i], depth + 1);
    const t = NODE_TYPES[n.type] || { inputs: [] };
    if (n.disable) return t.inputs.length ? ins(0) : [];
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
    if (!id) return "-";
    if (memo.has(id)) return memo.get(id);
    const n = nodeById(comp, id);
    if (!n || depth > 256) return "?";
    memo.set(id, "~");   // a loop (refused by connect) hashes as itself
    const { x, y, name, ...rest } = n;
    const h = hashString(JSON.stringify(rest) + "|" + n.inputs.map((s) => upstreamHash(comp, s, memo, depth + 1)).join(","));
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

export function renderNode(comp, id, frame, ctx) {
    const scale = ctx.scale || 1;
    const W = Math.max(1, Math.round(comp.format.width * scale)), H = Math.max(1, Math.round(comp.format.height * scale));
    const memo = ctx.memo || (ctx.memo = new Map());
    const xmemo = ctx.xmemo || (ctx.xmemo = new Map());   // the extra channels beside each picture
    const keys = new Map(), hashes = new Map();
    // What a cached result also depends on beside the settings: which pixels its Reads were handed (none yet,
    // or which decoded frame) and which OCIO transforms had arrived.
    const sourceSig = (nid, f) => sourceNeeds(comp, nid, f).map(({ node: s, frame: sf }) => `${s.id}:${sf}:${tokenOf(ctx.source ? ctx.source(s, sf) : null)}`).join(",");
    let lut = null;
    const lutSig = () => lut ?? (lut = ocioNeeds(comp, frame).map((x) => x.key + (ctx.ocio && ctx.ocio(x.spec) ? "+" : "-")).join(","));
    // A node's result with its own extra channels (otherwise its first input's are taken, moved for SPATIAL ones).
    const X = (img, ex) => ({ __x: true, img, ex });
    const exOf = (nid, f) => (nid && xmemo.get(`${nid}@${f}`)) || {};
    const run = (nid, f, depth) => {
        if (!nid || depth > 256) return blank(W, H);
        const mk = `${nid}@${f}`;
        if (memo.has(mk)) return memo.get(mk);
        const n = nodeById(comp, nid);
        let ck = null;
        if (n && !n.disable && ctx.cache && (ctx.cacheIds ? ctx.cacheIds.has(nid) : ctx.cacheAll ? true : HEAVY.has(n.type))) {
            if (!keys.has(nid)) keys.set(nid, upstreamHash(comp, nid, hashes));
            ck = `${f}@${scale}@${keys.get(nid)}@${sourceSig(nid, f)}@${lutSig()}`;
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
        return maskMix(src, sex, img, ex, m, mix, (n.mask_invert || "off") === "on");
    };
    // A SPATIAL node: its picture and every extra channel through the same operation.
    const spatial = (srcId, f, d1, fn) => { const src = run(srcId, f, d1); return X(fn(src), CH.mapExtras(exOf(srcId, f), src.w, src.h, fn)); };
    const vectorsOf = (srcId, f, depth, n) => O.vectorsImage(run(srcId, f - 1, depth), run(srcId, f, depth), run(srcId, f + 1, depth), {
        smoothness: paramAt(n, "smoothness", f), iterations: paramAt(n, "iterations", f), levels: paramAt(n, "levels", f),
        detail: paramAt(n, "detail", f) }, scale);
    // The size that comes into input k of node n, in pixels of the comp.
    const inFmt = (n, k = 0) => formatAt(comp, n.inputs[k]);
    const make = (n, f, depth) => {
        const d1 = depth + 1;
        if (!n) return blank(W, H);
        if (n.disable) return NODE_TYPES[n.type].inputs.length ? run(n.inputs[0], f, d1) : blank(W, H);
        switch (n.type) {
        case "read": {
            const src = ctx.source ? ctx.source(n, f) : null;
            // A source may come shrunk (the page's proxy): `ow` x `oh` is the file's own size then.
            const k = src ? scale * (src.ow ? src.ow / src.w : 1) : 1;
            return src ? resample(src, fitMatrix(src.w, src.h, W, H, n.fit || "fit", k), W, H) : blank(W, H);
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
            return gradeImage(run(n.inputs[0], f, d1), p);
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
            return spatial(n.inputs[0], f, d1, (p) => O.cropImage(p, tl[0] * scale, tl[1] * scale, br[0] * scale, br[1] * scale, soft));
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
            if (n.blend !== "mix") return at(Math.floor(t + 0.5));
            const f0 = Math.floor(t), fr = t - f0;
            if (fr < 1e-9) return at(f0);
            const a = run(s0, f0, d1), b = run(s0, f0 + 1, d1);
            return X(mixImages(a, b, fr), CH.mixExtras(exOf(s0, f0), exOf(s0, f0 + 1), fr, a.w * a.h));
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
            return X(img, ex);
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
        case "output": return run(n.inputs[0], f, d1);
        default: return blank(W, H);
        }
    };
    const img = run(id, frame, 0);
    return { w: img.w, h: img.h, data: img.data, ch: exOf(id, frame) };
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
export function sourceNeeds(comp, id, frame) {
    const out = [], seen = new Set();
    const walk = (nid, f, depth) => {
        const key = `${nid}@${f}`;
        if (!nid || depth > 256 || seen.has(key)) return;
        seen.add(key);
        const n = nodeById(comp, nid);
        if (!n) return;
        if (n.disable) { if (n.inputs.length) walk(n.inputs[0], f, depth + 1); return; }
        if (n.type === "read") { out.push({ node: n, frame: f }); return; }
        if (n.type === "retime") {
            const t = retimeFrame(n, f);
            if (n.blend !== "mix") walk(n.inputs[0], Math.floor(t + 0.5), depth + 1);
            else { const f0 = Math.floor(t); walk(n.inputs[0], f0, depth + 1); if (t - f0 >= 1e-9) walk(n.inputs[0], f0 + 1, depth + 1); }
            return;
        }
        if (n.type === "vectors" || (n.type === "motionblur" && !n.inputs[1])) {
            for (const g of [f - 1, f, f + 1]) walk(n.inputs[0], g, depth + 1);
            if (n.type === "vectors") return;
        }
        if (n.type === "depthblur" && !n.inputs[1]) { walk(n.inputs[0], f, depth + 1); return; }
        for (const s of n.inputs) walk(s, f, depth + 1);
    };
    walk(id, frame, 0);
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
