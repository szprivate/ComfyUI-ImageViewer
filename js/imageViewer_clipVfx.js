// imageViewer_clipVfx.js
// VFX on a clip of the History: right-click a film › Convert Footage › Alpha matte / SDR to HDR / Reframe… / Upscale…
// Each runs LTX-2.5's IC-LoRA workflow for it (src/clip_vfx.py, src/clip_vfx_workflows/): the server makes the
// graphs (the clip cut to 8n + 1 frames, a long clip's alpha in runs of 121), the page queues them with the
// sign-in as Generate does (PaintPanelMixin._paintQueue / _paintWait - one `this`) and hands the outputs back;
// the result goes into the History in the source's group, so the two lie side by side (an HDR pass also
// brings its ACEScg EXR sequence). The dialog shows how far it is and can stop it; closed, the run goes on and
// its result still arrives.
import { api } from "../../scripts/api.js";
import { notice } from "./imageViewer_exportUI.js";
import { snapshotGroup, setSnapshotGroup } from "./imageViewer_historyData.js";
import * as V from "./imageViewer_clipVfxData.js";

async function postJson(route, body) {
    const res = await api.fetchApi(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
}

export const ClipVfxMixin = {

    /** What the server offers, asked once ({actions, reframe, sizes, chunk}); null from an older server. */
    async _clipVfxOffer() {
        if (this._clipVfxOffered !== undefined) return this._clipVfxOffered;
        try {
            const res = await api.fetchApi("/imageviewer/clip_vfx");
            this._clipVfxOffered = res.ok ? await res.json() : null;
        } catch (_) { this._clipVfxOffered = null; }
        return this._clipVfxOffered;
    },

    /** "✨ Convert Footage ▸" on the thumbnail menu of a film: its rows open below it, the menu stays up. */
    clipVfxMenuRow(doc, menu, snap, before) {
        const fr = snap && snap[0];
        if (!V.isClip(fr) || !V.clipRef(fr)) return;
        const head = doc.createElement("div");
        head.className = "thumb-ctx-item thumb-ctx-group thumb-ctx-keep clip-vfx-item";
        head.textContent = "✨ Convert Footage ▸";
        head.title = "LTX-2.5 passes on this clip: alpha matte, SDR to HDR, reframe, upscale";
        const rows = [];
        const labels = { alpha: "Alpha matte", hdr: "SDR to HDR", reframe: "Reframe…", upscale: "Upscale…" };
        head.onclick = (e) => {
            e.stopPropagation();
            if (rows.length) { rows.forEach((r) => r.remove()); rows.length = 0; head.textContent = "✨ Convert Footage ▸"; return; }
            head.textContent = "✨ Convert Footage ▾";
            let at = head;
            for (const a of V.ACTION_ORDER) {
                const el = doc.createElement("div");
                el.className = "thumb-ctx-item thumb-ctx-sub";
                el.dataset.vfx = a;
                el.textContent = `${V.ACTION_ICONS[a]} ${labels[a]}`;
                el.onclick = (ev) => { ev.stopPropagation(); menu.remove(); this.clipVfxDialog(snap, a); };
                at.after(el); at = el; rows.push(el);
            }
        };
        if (before && before.parentNode === menu) menu.insertBefore(head, before); else menu.appendChild(head);
    },

    /** The dialog of *action* on the film of *snap*: its settings, Run, then how far it is. */
    async clipVfxDialog(snap, action) {
        const host = this.container;
        if (!host) return;
        const offer = await this._clipVfxOffer();
        if (!offer || !offer.actions || !offer.actions[action]) {
            notice("error", "Convert Footage is not available", "The viewer's server does not offer it (restart ComfyUI after an update).");
            return;
        }
        const info = offer.actions[action];
        const fr = snap[0];
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const shade = el("div", "rd-shade clip-vfx-dlg");
        shade.dataset.action = action;
        const box = el("div", "rd-box");
        box.setAttribute("role", "dialog");
        const x = el("button", "rd-x", "✕");
        x.title = "Close (the run goes on; its result still comes into the History)";
        const head = el("div", "rd-head");
        head.append(el("span", "rd-title", `${info.label}: ${V.clipStem(fr)}`), x);
        box.append(head);
        const row = (label, ...kids) => {
            const r = el("div", "rd-row");
            r.append(el("span", "rd-label", label), ...kids);
            box.append(r);
            return r;
        };
        const fields = {};
        if (action === "reframe") {
            const sel = el("select", "rd-in");
            for (const p of offer.reframe || []) {
                const o = el("option", "", `${p.label}  (${p.width} x ${p.height})`);
                o.value = p.label;
                sel.append(o);
            }
            const custom = el("option", "", "Custom");
            custom.value = "custom";
            sel.append(custom);
            const w = el("input", "rd-in rd-num"), h = el("input", "rd-in rd-num");
            w.type = h.type = "number"; w.step = h.step = "64"; w.min = h.min = "256"; w.max = h.max = "1920";
            const setFrom = () => {
                const p = (offer.reframe || []).find((q) => q.label === sel.value);
                if (p) { w.value = p.width; h.value = p.height; }
            };
            sel.onchange = setFrom;
            const snapBoth = () => {
                w.value = V.snapSide(w.value); h.value = V.snapSide(h.value);
                sel.value = V.presetOf(offer.reframe, Number(w.value), Number(h.value));
            };
            w.onchange = h.onchange = snapBoth;
            setFrom();
            row("Frame", sel);
            row("Size", w, el("span", "rd-sub", "x"), h, el("span", "rd-sub", "px, multiples of 64"));
            fields.width = w; fields.height = h;
        }
        if (action === "upscale") {
            const mode = el("select", "rd-in");
            for (const [v, t] of [["refine", "Refine details (stays close to the clip)"], ["restore", "Restore (damaged or archival footage)"]]) {
                const o = el("option", "", t); o.value = v; mode.append(o);
            }
            const size = el("select", "rd-in");
            for (const s of offer.sizes || ["FullHD"]) { const o = el("option", "", s); o.value = s; size.append(o); }
            row("Mode", mode);
            row("Size", size, el("span", "rd-sub", "4K needs more memory than FullHD"));
            fields.mode = mode; fields.size = size;
        }
        if (info.prompt) {
            const p = el("textarea", "rd-in");
            p.rows = 2;
            p.style.width = "100%";
            p.placeholder = action === "reframe" ? "Optional: what the new parts of the frame show" : "Optional: what the clip shows";
            row("Prompt", p).style.alignItems = "flex-start";
            fields.prompt = p;
        }
        const hint = {
            alpha: `A greyscale matte film (white = opaque) of the clip's main subject. Runs of at most ${offer.chunk || 121} frames, joined.`,
            hdr: "An HLG BT.2020 film and a half-float ACEScg EXR sequence of the clip (both go into the History).",
            reframe: "The clip outpainted into the new frame.",
            upscale: "The clip upscaled with LTX-2.5's detail IC-LoRA.",
        }[action];
        box.append(el("div", "rd-hint", `${hint} Local, ${info.minutes}; the clip is cut to 8n + 1 frames.`));
        const progress = el("div", "rd-progress"), bar = el("div", "rd-bar");
        progress.append(bar);
        const message = el("div", "rd-message");
        const stop = el("button", "rd-btn", "Stop");
        stop.style.display = "none";
        const cancel = el("button", "rd-btn", "Close");
        const go = el("button", "rd-btn rd-go", "Run");
        const foot = el("div", "rd-foot");
        foot.append(stop, cancel, go);
        box.append(progress, message, foot);
        shade.append(box);
        host.append(shade);
        const close = () => shade.remove();
        x.onclick = cancel.onclick = close;
        shade.addEventListener("pointerdown", (e) => { if (e.target === shade) close(); });
        shade.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
        const say = (text, cls = "") => { message.textContent = text; message.className = "rd-message" + (cls ? " " + cls : ""); };
        go.onclick = async () => {
            const options = {};
            for (const [k, f] of Object.entries(fields)) options[k] = f.type === "number" ? Number(f.value) : f.value;
            go.disabled = true;
            for (const f of Object.values(fields)) f.disabled = true;
            box.classList.add("rendering");
            stop.style.display = "";
            const ok = await this.clipVfxRun(snap, action, options, {
                say, bar: (s) => { bar.style.width = s == null ? "100%" : `${Math.round(s * 100)}%`; bar.style.opacity = s == null ? "0.35" : "1"; },
                stopper: (fn) => { stop.onclick = () => { stop.disabled = true; fn(); }; },
            });
            stop.style.display = "none";
            box.classList.remove("rendering");
            if (ok) setTimeout(close, 1500);
            else { go.disabled = false; for (const f of Object.values(fields)) f.disabled = false; }
        };
        go.focus();
        return shade;
    },

    /**
     * Run *action* on the film of *snap*: prepared by the server, queued here, the result into the History.
     * `ui` = {say(text, cls), bar(share | null), stopper(fn)} - the dialog's, or nothing. -> whether it worked.
     */
    async clipVfxRun(snap, action, options = {}, ui = {}) {
        const fr = snap[0];
        const say = (t, cls) => { try { ui.say && ui.say(t, cls); } catch (_) { /* the dialog is gone */ } };
        const bar = (s) => { try { ui.bar && ui.bar(s); } catch (_) { /* the dialog is gone */ } };
        say("Getting the clip ready…");
        bar(null);
        let prep;
        try {
            prep = await postJson("/imageviewer/clip_vfx/prepare", { source: V.clipRef(fr), action, options });
        } catch (e) {
            const miss = e.data && e.data.missing;
            const why = miss && miss.length
                ? "Not here: " + miss.map((m) => (m.kind === "model" ? `${m.what} (models/${m.folder})` : `node ${m.what}`)).join(", ")
                : String(e.message || e);
            say(why, "error");
            notice("error", "Convert Footage did not start", why);
            return false;
        }
        const n = prep.graphs.length;
        const runs = prep.graphs.map((g) => ({ graph: g, id: null, done: false, value: 0, max: 0, node: null, stop: null }));
        let stopped = false;
        if (ui.stopper) ui.stopper(() => { stopped = true; for (const r of runs) if (!r.done && r.stop) r.stop(); });
        const show = () => {
            const k = runs.findIndex((r) => !r.done);
            const of = n > 1 ? ` (part ${k + 1} of ${n})` : "";
            const r = runs[k];
            if (!r) return;
            const node = r.node && r.graph[r.node];
            const what = node ? ((node._meta && node._meta.title) || node.class_type) : (r.started ? "Running" : "Waiting in ComfyUI's queue");
            say(`${prep.label}${of}: ${what}` + (prep.note && k <= 0 ? `\n${prep.note}` : ""));
            bar(V.share(runs));
        };
        const outs = [];
        let failed = null;
        try {
            const waits = [];
            for (const r of runs) {
                r.id = await this._paintQueue(r.graph);
                const p = this._paintWait(r.id, prep.output, {
                    start: () => { r.started = true; show(); },
                    node: (id) => { r.started = true; r.node = id; r.value = 0; r.max = 0; show(); },
                    progress: (v, m, id) => { r.started = true; if (id != null) r.node = id; r.value = v; r.max = m; show(); },
                    stop: (fn) => { r.stop = fn; },
                });
                p.then(() => { r.done = true; show(); }, () => { r.done = true; show(); });
                waits.push(p);
            }
            show();
            for (const p of waits) outs.push(await p);
        } catch (e) { failed = e; }
        if (failed || stopped) {
            const why = stopped ? "Stopped" : String((failed && failed.message) || failed);
            say(why, stopped ? "" : "error");
            if (!stopped) notice("error", `${prep.label} did not work`, why);
            for (const r of runs) if (!r.done && r.stop) r.stop();
            return false;
        }
        say(n > 1 ? "Joining the parts…" : "Bringing the result in…");
        bar(null);
        let res;
        try { res = await postJson("/imageviewer/clip_vfx/finish", { job: prep.job, results: outs }); }
        catch (e) { say(String(e.message || e), "error"); notice("error", `${prep.label}: no result`, String(e.message || e)); return false; }
        await this._clipVfxLand(snap, res, prep.label);
        bar(1);
        say(`Done: ${String(res.path).split(/[\\/]/).pop()}` + (res.exr && res.exr.length ? ` and ${res.exr.length} EXR frames` : ""));
        notice("success", `${prep.label} done`, String(res.path));
        return true;
    },

    /** The result (and an HDR pass's EXR sequence) into the History, in the source's group. */
    async _clipVfxLand(snap, res, label) {
        if (!this._browserFramesFor) return;
        const group = V.resultGroup(snapshotGroup(snap), snap[0]);
        const lists = [[res.path]];
        if (res.exr && res.exr.length) lists.push(res.exr);
        const snaps = [];
        for (const paths of lists) {
            const frames = (await this._browserFramesFor(paths)).filter(Boolean);
            if (!frames.length) continue;
            setSnapshotGroup(frames, group);
            if (frames[0] && typeof frames[0] === "object") {
                frames[0].vfx = { label, from: V.clipRef(snap[0]) };
                frames[0].label = V.resultLabel(snap[0], snaps.length ? `${label} (EXR)` : label);
            }
            snaps.push(frames);
        }
        if (snaps.length) this.showInViewerTab(snaps, { show: false, dedupe: false });
    },
};
