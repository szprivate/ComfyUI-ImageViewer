// imageViewer_editAfxPlay.js
// Sound effects in the Edit tab's preview: a WebAudio graph per sounding element
// (the two <video>s and the <audio>s of the sound items, imageViewer_editPlay.js),
// built from the clip's effects and its track's (imageViewer_audioFxData.js):
//
//   element -> MediaElementSource -> the clip's effects -> its gain (volume, fades,
//   crossfades - what element.volume was) -> the track's bus (its effects, shared by
//   all of its clips) -> the speakers
//
// The graph only carries the sound: the elements still run on the film's one clock
// (026d427's followPlan / followRate) - nothing here seeks or starts anything. An
// element is put through WebAudio the first time a clip or track it plays has
// effects (a MediaElementSource cannot be taken off again); until then, and for a
// cut without effects, it is the plain element as before. Nodes: BiquadFilter (EQ;
// the pass filters at Q -3.01 dB, Butterworth), DynamicsCompressor (compressor,
// and the limiter as one with ratio 20 and no knee), Convolver with the generated
// impulse response (reverb, normalize off: reverbIR is unit energy), Delay with a
// feedback loop, Gain, StereoPanner. Keyed params (mix, gain, pan) are set every
// frame from the clip's time (a clip's chain) or the film's (a track's).
import * as A from "./imageViewer_audioFxData.js";
import * as D from "./imageViewer_editTimelineData.js";

export const EditAfxPlayMixin = {

    /** The one AudioContext of the window `el` lives in (popped out or not). */
    _epAfxCtx(el) {
        const win = (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
        const C = win.AudioContext || win.webkitAudioContext;
        if (!C) return null;
        if (!win.__imageViewerAfxCtx) {
            try { win.__imageViewerAfxCtx = new C(); } catch (_) { return null; }
            win.__imageViewerAfxCtx.__buses = {};
        }
        const ctx = win.__imageViewerAfxCtx;
        if (ctx.state === "suspended" && this.isPlaying) { try { ctx.resume(); } catch (_) {} }
        return ctx;
    },

    // The nodes of one effect: { input, output, keyed: [{ k, set(v) }] }.
    _epAfxNodes(ctx, fx) {
        const plan = A.afxPlan(fx);
        const gainNode = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
        const keyed = [];
        if (fx.type === "eq") {
            const nodes = plan.eq.map((b) => {
                const f = ctx.createBiquadFilter();
                f.type = b.kind;
                f.frequency.value = b.f;
                if (b.kind === "highpass" || b.kind === "lowpass") f.Q.value = 20 * Math.log10(b.q);   // WebAudio's Q is dB there
                else if (b.kind === "peaking") f.Q.value = b.q;
                if (b.g !== undefined) f.gain.value = b.g;
                return f;
            });
            if (!nodes.length) { const g = gainNode(1); return { input: g, output: g, keyed }; }
            for (let n = 0; n + 1 < nodes.length; n++) nodes[n].connect(nodes[n + 1]);
            return { input: nodes[0], output: nodes[nodes.length - 1], keyed };
        }
        if (fx.type === "comp" || fx.type === "limit") {
            const c = ctx.createDynamicsCompressor();
            const lim = fx.type === "limit";
            c.threshold.value = lim ? plan.ceiling : plan.threshold;
            c.knee.value = lim ? 0 : Math.min(40, plan.knee);
            c.ratio.value = lim ? 20 : plan.ratio;
            c.attack.value = lim ? 0.001 : Math.min(1, plan.attack);
            c.release.value = Math.min(1, plan.release);
            const out = gainNode(lim ? 1 : Math.pow(10, plan.makeup / 20));
            c.connect(out);
            return { input: c, output: out, keyed };
        }
        if (fx.type === "reverb" || fx.type === "delay") {
            const input = gainNode(1), out = gainNode(1);
            const dry = gainNode(1 - A.afxParam(fx, "mix", 0)), wet = gainNode(A.afxParam(fx, "mix", 0));
            input.connect(dry); dry.connect(out); wet.connect(out);
            if (fx.type === "reverb") {
                const conv = ctx.createConvolver();
                conv.normalize = false;
                const ir = A.reverbIR(fx.p.preset, fx.p.decay, fx.p.pre, ctx.sampleRate);
                const buf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
                buf.copyToChannel(ir[0], 0);
                buf.copyToChannel(ir[1], 1);
                conv.buffer = buf;
                input.connect(conv); conv.connect(wet);
            } else {
                const d = ctx.createDelay(2.5);
                d.delayTime.value = fx.p.time / 1000;
                const fb = gainNode(fx.p.fb);
                input.connect(d); d.connect(fb); fb.connect(d); d.connect(wet);
            }
            if (fx.keys.mix && fx.keys.mix.length) keyed.push({ k: "mix", set: (v) => { dry.gain.value = 1 - v; wet.gain.value = v; } });
            return { input, output: out, keyed };
        }
        if (fx.type === "gain") {
            const g = gainNode(Math.pow(10, fx.p.gain / 20));
            if (fx.keys.gain && fx.keys.gain.length) keyed.push({ k: "gain", set: (v) => { g.gain.value = Math.pow(10, v / 20); } });
            return { input: g, output: g, keyed };
        }
        const p = ctx.createStereoPanner();
        p.pan.value = fx.p.pan;
        if (fx.keys.pan && fx.keys.pan.length) keyed.push({ k: "pan", set: (v) => { p.pan.value = v; } });
        return { input: p, output: p, keyed };
    },

    // A chain from `input` to `output`: the effects that are on, in order. Returns its keyed params [{ fx, k, set }].
    _epAfxWire(ctx, chain, input, output) {
        let at = input;
        const keyed = [];
        for (const fx of A.cleanAfx(chain)) {
            if (fx.on === false) continue;
            const n = this._epAfxNodes(ctx, fx);
            at.connect(n.input);
            at = n.output;
            for (const k of n.keyed) keyed.push({ fx, ...k });
        }
        at.connect(output);
        return keyed;
    },

    // A track's bus: its input stays, its effects are rewired when they change.
    // Its output goes through the window's master (both with an AnalyserNode beside
    // them, which the Mixer's meters read) to the speakers.
    _epAfxBus(ctx, id, chain) {
        const buses = ctx.__buses;
        const sig = JSON.stringify(A.cleanAfx(chain));
        let bus = buses[id];
        if (!bus) {
            bus = buses[id] = { input: ctx.createGain(), out: ctx.createGain(), meter: this._epAfxMeter(ctx), sig: null, keyed: [] };
            bus.out.connect(this._epAfxMaster(ctx).input);
            bus.out.connect(bus.meter);
        }
        if (bus.sig !== sig) {
            try { bus.input.disconnect(); } catch (_) {}
            bus.keyed = this._epAfxWire(ctx, chain, bus.input, bus.out);
            bus.sig = sig;
        }
        return bus;
    },

    // An analyser for a meter: a short window, no smoothing (the meter keeps its own peak).
    _epAfxMeter(ctx) {
        const a = ctx.createAnalyser();
        a.fftSize = 1024;
        a.smoothingTimeConstant = 0;
        return a;
    },

    // The window's master: everything the Edit tab plays through WebAudio, metered, to the speakers.
    _epAfxMaster(ctx) {
        if (!ctx.__master) {
            const input = ctx.createGain();
            const meter = this._epAfxMeter(ctx);
            input.connect(ctx.destination);
            input.connect(meter);
            ctx.__master = { input, meter };
        }
        return ctx.__master;
    },

    /**
     * Element `el` (playing `clip`, whose time 0 is the film's `origin`, on track
     * `track`) put through its effects - or left as it is when neither it nor its
     * track has any and it was never put through WebAudio.
     */
    _editAfxEnsure(el, clip, track, origin) {
        if (!el) return;
        const cut = this._editPlayCut();
        const chain = clip && !clip.title ? A.cleanAfx(clip.afx) : [];
        const tchain = cut && track && D.afxTrack(cut, track) ? D.trackAfx(cut, track) : [];
        // The Mixer up: every element goes through its track's bus, so that its meter has something to read.
        const metered = !!(this._editMixOn && this._editMixOn()) && !!track;
        if (!el._epAfx && !A.afxActive(chain) && !A.afxActive(tchain) && !metered) return;
        const ctx = this._epAfxCtx(el);
        if (!ctx) return;
        if (!el._epAfx) {
            try {
                el._epAfx = { src: ctx.createMediaElementSource(el), gain: ctx.createGain(), sig: null, keyed: [] };
            } catch (_) { el._epAfxFailed = true; return; }
            el._epAfx.gain.gain.value = el.volume;
            el.volume = 1;
        }
        const r = el._epAfx;
        const bus = A.afxActive(tchain) || metered || (track && ctx.__buses[track]) ? this._epAfxBus(ctx, track, tchain) : null;
        const sig = JSON.stringify([chain, bus ? track : ""]);
        r.origin = Number(origin) || 0;
        r.track = track;
        if (r.sig !== sig) {
            try { r.src.disconnect(); r.gain.disconnect(); } catch (_) {}
            r.keyed = this._epAfxWire(ctx, chain, r.src, r.gain);
            r.gain.connect(bus ? bus.input : this._epAfxMaster(ctx).input);
            r.sig = sig;
        }
    },

    /** An element's loudness: its gain node once it goes through WebAudio, else its own volume. */
    _epVol(el, v) {
        if (!el) return;
        const x = Math.max(0, Math.min(1, Number(v) || 0));
        if (el._epAfx) {
            if (Math.abs(el._epAfx.gain.gain.value - x) > 1e-4) el._epAfx.gain.gain.value = x;
            if (el.volume !== 1) el.volume = 1;
        } else if (el.volume !== x) el.volume = x;
    },

    /** Every frame while playing: the keyed effect params at the film's moment `t`. */
    _editAfxTick(t) {
        const els = [...(this._epSlots || []), ...((this._ep && this._ep.bed) || [])];
        for (const el of els) {
            const r = el && el._epAfx;
            if (!r || !r.keyed.length) continue;
            for (const k of r.keyed) k.set(A.afxParam(k.fx, k.k, t - r.origin));
        }
        const ctx = ((this._viewerWindow && this._viewerWindow()) || window).__imageViewerAfxCtx;
        for (const bus of Object.values((ctx && ctx.__buses) || {})) for (const k of bus.keyed) k.set(A.afxParam(k.fx, k.k, t));
    },
};
