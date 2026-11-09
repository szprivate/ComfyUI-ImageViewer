// imageViewer_editMixer.js
// The Edit tab's Mixer (dock id `editMixer`, the bar's Timeline group), as
// Resolve's: a strip per sound source - V1 (the films' own sound), A1 (the bed)
// and every sound track - with a meter, a fader, a pan, the track's switch (M)
// and its solo (S), and a master meter.
//
// It is a face over what is there, not a second model: the fader is the track's
// last Gain effect and the pan its last Pan effect (imageViewer_audioFxData.js
// mixerLevel / setMixerLevel), so the render, the file and Export to Resolve's
// bake already know them. V1 has no track effects (its sound is each film's own,
// at the clip's volume), so its strip is a meter. A keyed fader or pan takes a
// key at the playhead. A move is one undo step, made when the fader is let go;
// while it is dragged the bus's gain follows it (`_editMixLive`).
//
// The meters read an AnalyserNode beside each track's bus and beside the master
// (imageViewer_editAfxPlay.js): while the Mixer is up every element the player
// sounds is put through WebAudio (`_editMixOn`), its track's bus included - an
// element once put through WebAudio stays so, which is all that costs.
import * as A from "./imageViewer_audioFxData.js";
import * as D from "./imageViewer_editTimelineData.js";

export const MIXER_ID = "editMixer";
const FLOOR = -60;                 // dB at the meter's foot
const HOLD_MS = 1200;              // a peak's mark stays this long
const FADER_TOP = 12;              // dB at the fader's top (Gain goes to +24, the Inspector reaches it)

export const EditMixerMixin = {

    /** Is the Mixer up (and so every sound metered)? */
    _editMixOn() {
        return !!(this.isPanelDocked && this.isPanelDocked(MIXER_ID) && this.isEditTab && this.isEditTab());
    },

    /** The strips: [{ id, name, fader }] - V1 (meter only), A1, the sound tracks in their order. */
    _editMixStrips(cut) {
        const out = [{ id: "V1", name: "V1", note: "the films' own sound", fader: false }];
        out.push({ id: "A1", name: "A1", note: "the bed", fader: true });
        for (const k of (cut && cut.tracks) || []) {
            if (k.kind === "audio") out.push({ id: k.id, name: k.name || k.id, note: "", fader: true });
        }
        return out;
    },

    _editMixTime() {
        const fps = (this._editTlCut && this._editTlCut.fps) || 24;
        return (Number(this.currentFrame) || 0) / fps;
    },

    _editMixRender() {
        const host = this.editMixerPanel;
        if (!host || !this._editMixOn()) { this._editMixStop(); return; }
        const cut = this._editTlCut;
        if (!cut) return;
        if (this._editMixDrag) return;                     // a fader in the hand: not drawn from under it
        const t = this._editMixTime();
        const view = this._editTlView || {};
        const strips = this._editMixStrips(cut);
        const sig = JSON.stringify([strips.map((s) => [s.id, s.name]), strips.map((s) => s.fader ? [
            A.mixerLevel(D.trackAfx(cut, s.id), "gain", t), A.mixerLevel(D.trackAfx(cut, s.id), "pan", t),
            D.trackAfx(cut, s.id).length] : 0),
            strips.map((s) => [this._editMixOff(cut, s.id), !!(view.solo && view.solo[s.id]), !!D.trackFlags(cut, s.id).lock])]);
        if (host._mixSig === sig && host.querySelector(":scope > .mix-body")) { this._editMixStart(); return; }
        host._mixSig = sig;
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const body = el("div", "mix-body");
        for (const s of strips) body.append(this._editMixStrip(doc, el, cut, s, t, view));
        const master = el("div", "mix-strip mix-master");
        master.dataset.track = "master";
        master.append(el("div", "mix-name", "Master"), this._editMixMeter(el, "master"), el("div", "mix-db", ""));
        body.append(master);
        // Only the strips are redrawn: the panel's title bar (the dock's, its drag handle) stays.
        const old = host.querySelector(":scope > .mix-body");
        if (old) old.replaceWith(body); else host.append(body);
        this._editMixStart();
    },

    _editMixOff(cut, id) {
        if (id === "V1" || id === "A1") return !!(cut.off && cut.off[id]);
        return !!(D.trackOf(cut, id) || {}).off;
    },

    _editMixMeter(el, id) {
        const box = el("div", "mix-meter");
        box.dataset.meter = id;
        const fill = el("div", "mix-meter-fill");
        const hold = el("div", "mix-meter-hold");
        box.append(fill, hold);
        return box;
    },

    _editMixStrip(doc, el, cut, s, t, view) {
        const strip = el("div", "mix-strip");
        strip.dataset.track = s.id;
        const name = el("div", "mix-name", s.name);
        name.title = s.note ? `${s.name}: ${s.note}` : s.name;
        strip.append(name);
        const mid = el("div", "mix-mid");
        mid.append(this._editMixMeter(el, s.id));
        const locked = !!D.trackFlags(cut, s.id).lock;
        const read = el("div", "mix-db", "");
        if (s.fader) {
            const chain = D.trackAfx(cut, s.id);
            const g = A.mixerLevel(chain, "gain", t);
            const fader = el("input", "mix-fader");
            fader.type = "range";
            fader.min = String(FLOOR);
            fader.max = String(FADER_TOP);
            fader.step = "0.5";
            fader.value = String(Math.max(FLOOR, Math.min(FADER_TOP, g.v)));
            fader.dataset.field = "gain";
            fader.disabled = locked;
            fader.title = `${s.name}: the track's level (its Gain effect)` + (g.keyed ? " - keyed: a move is a key at the playhead" : "")
                + ". Double-click: 0 dB.";
            const say = (v) => { read.textContent = (v > 0 ? "+" : "") + (Math.round(v * 10) / 10).toFixed(1) + " dB"; };
            say(g.v);
            fader.addEventListener("pointerdown", () => { this._editMixDrag = true; });
            for (const ev of ["pointerup", "pointercancel", "blur"]) fader.addEventListener(ev, () => { this._editMixDrag = false; });
            fader.addEventListener("input", () => { say(Number(fader.value)); this._editMixLive(s.id, Number(fader.value)); });
            fader.addEventListener("change", () => { this._editMixDrag = false; this.editMixSet(s.id, "gain", Number(fader.value)); });
            fader.addEventListener("dblclick", () => { this._editMixDrag = false; this.editMixSet(s.id, "gain", 0); });
            if (g.keyed) strip.classList.add("keyed");
            mid.append(fader);
            strip.append(mid, read);
            const p = A.mixerLevel(chain, "pan", t);
            const pan = el("input", "mix-pan");
            pan.type = "range";
            pan.min = "-1";
            pan.max = "1";
            pan.step = "0.05";
            pan.value = String(p.v);
            pan.dataset.field = "pan";
            pan.disabled = locked;
            pan.title = `${s.name}: pan (its Pan effect), ${p.v === 0 ? "centre" : p.v < 0 ? Math.round(-p.v * 100) + " % left" : Math.round(p.v * 100) + " % right"}. Double-click: centre.`;
            pan.addEventListener("change", () => this.editMixSet(s.id, "pan", Number(pan.value)));
            pan.addEventListener("dblclick", () => this.editMixSet(s.id, "pan", 0));
            strip.append(pan);
            const n = chain.filter((fx) => fx.type !== "gain" && fx.type !== "pan").length;
            if (n) {
                const fx = el("button", "edit-btn mix-fx", `fx ${n}`);
                fx.title = `${s.name}: ${n} more effect${n > 1 ? "s" : ""} - open the track's effects in the Inspector`;
                fx.addEventListener("click", () => {
                    this._editTlSel = { kind: "track", track: s.id };
                    this.editTlRefresh();
                });
                strip.append(fx);
            }
        } else {
            read.textContent = "clips";
            read.title = "V1 has no track level: each film plays at its clip's volume";
            strip.append(mid, read);
        }
        const btns = el("div", "mix-btns");
        const btn = (label, title, on, fn) => {
            const b = el("button", "edit-btn mix-btn" + (on ? " on" : ""), label);
            b.title = title;
            b.addEventListener("click", fn);
            return b;
        };
        const off = this._editMixOff(cut, s.id);
        btns.append(btn("M", off ? "Switched off - click to switch it on (as the track header's switch: not heard, not rendered)"
                                 : "Switch this track off (as the track header's switch: not heard, not rendered)", off, () => {
            this._editTlApply(D.setTrackOff(this._editTlCut, s.id, !off));
        }));
        btns.append(btn("S", "Solo: play only the soloed tracks (not saved, not rendered)", !!(view.solo && view.solo[s.id]), () => {
            const v = this._editTlView;
            if (!v) return;
            v.solo = v.solo || {};
            if (v.solo[s.id]) delete v.solo[s.id]; else v.solo[s.id] = true;
            if (this.editPlayLiveChanged) this.editPlayLiveChanged();
            this.editTlRefresh();
        }));
        strip.append(btns);
        if (locked) { strip.classList.add("locked"); strip.title = `${s.name} is locked`; }
        return strip;
    },

    /** The fader ("gain", dB) or pan of track `id` set to `v`: one undo step (a keyed one: a key at the playhead). */
    editMixSet(id, type, v) {
        const cut = this._editTlCut;
        if (!cut || !D.afxTrack(cut, id)) return false;
        this._editMixDrag = false;
        this._editMixLive(id, null);                       // the bus back at unity: the chain carries the level now
        const chain = D.trackAfx(cut, id);
        const next = A.setMixerLevel(chain, type, v, this._editMixTime());
        if (JSON.stringify(next) === JSON.stringify(chain)) { this._editMixRender(); return false; }
        const ok = this._editTlApply(D.setTrackAfx(cut, id, next));
        if (ok === false) this._editMixRender();
        return ok !== false;
    },

    // While a fader is dragged: the bus's own gain follows it (the chain is set when it is let go).
    _editMixLive(id, db) {
        const ctx = ((this._viewerWindow && this._viewerWindow()) || window).__imageViewerAfxCtx;
        const bus = ctx && ctx.__buses && ctx.__buses[id];
        if (!bus) return;
        if (db === null) { try { bus.input.gain.value = 1; } catch (_) {} return; }
        const was = A.mixerLevel(D.trackAfx(this._editTlCut, id), "gain", this._editMixTime()).v;
        try { bus.input.gain.value = Math.pow(10, (db - was) / 20); } catch (_) {}
    },

    // ── meters ───────────────────────────────────────────────────────────────

    _editMixStart() {
        if (this._editMixRaf) return;
        const win = (this.editMixerPanel && this.editMixerPanel.ownerDocument.defaultView) || window;
        const tick = () => {
            this._editMixRaf = null;
            if (!this._editMixOn()) { this._editMixDraw(true); return; }
            this._editMixDraw(false);
            this._editMixRaf = win.requestAnimationFrame(tick);
        };
        this._editMixRaf = win.requestAnimationFrame(tick);
    },

    _editMixStop() {
        if (!this._editMixRaf) return;
        const win = (this.editMixerPanel && this.editMixerPanel.ownerDocument.defaultView) || window;
        try { win.cancelAnimationFrame(this._editMixRaf); } catch (_) {}
        this._editMixRaf = null;
    },

    /** One meter frame: each strip's peak (dB) from its analyser, a mark held at the highest for HOLD_MS. */
    _editMixDraw(still) {
        const host = this.editMixerPanel;
        if (!host) return;
        const ctx = ((this._viewerWindow && this._viewerWindow()) || window).__imageViewerAfxCtx;
        const now = Date.now();
        this._editMixPeaks = this._editMixPeaks || {};
        const buf = this._editMixBuf || (this._editMixBuf = new Float32Array(1024));
        for (const box of host.querySelectorAll(".mix-meter")) {
            const id = box.dataset.meter;
            const node = ctx && (id === "master" ? ctx.__master && ctx.__master.meter : ctx.__buses && ctx.__buses[id] && ctx.__buses[id].meter);
            let db = FLOOR;
            if (node && !still && this.isPlaying) {
                node.getFloatTimeDomainData(buf);
                db = A.peakDb(buf, FLOOR);
            }
            const held = this._editMixPeaks[id];
            if (!held || db >= held.db || now - held.at > HOLD_MS) this._editMixPeaks[id] = { db, at: now };
            const share = (x) => Math.max(0, Math.min(1, (x - FLOOR) / -FLOOR));
            box.firstChild.style.height = (share(db) * 100).toFixed(1) + "%";
            box.dataset.db = db.toFixed(1);
            box.classList.toggle("over", db > -0.1);
            box.classList.toggle("hot", db > -6);
            const h = this._editMixPeaks[id].db;
            box.lastChild.style.bottom = (share(h) * 100).toFixed(1) + "%";
            box.lastChild.style.display = h > FLOOR ? "" : "none";
        }
    },
};
