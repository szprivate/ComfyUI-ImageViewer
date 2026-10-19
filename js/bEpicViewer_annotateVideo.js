// bEpicViewer_annotateVideo.js
// AnnotateVideoMixin - the Annotation tool over a VIDEO, and "Send to agentY".
//
// A mark drawn over a clip belongs to frames: the one on screen, and as many after
// it as "Hold" says (or up to where "Out here" is pressed). It is shown only on
// those frames, drawn on the timeline as a marker, and written to a sidecar beside
// the file (cut.mp4 -> cut.annotations.json, annotation_io.py) so it is still
// there tomorrow and the agent can read it without the viewer.
//
// "Send to agentY" is feedback: for each annotation (a set of marks sharing a frame
// range) the clip's frame is flattened with the marks, saved as a PNG, and the
// message to the agent carries that picture, the frame / timecode / range, the
// notes as text with their position, and the video's path. It goes through the
// panel's bridge (window.agentYViewerBridge.feedback) - the one path the viewer
// already has to agentY - and from there into the conversation like a typed
// message, so a stopped review is answered by it and never continued.
//
// agentY.js-style optional coupling: without the bridge the send button is hidden.

import { notice } from "./bEpicViewer_exportUI.js";
import { buildFeedback } from "./bEpicViewer_annotateReport.js";
import { api } from "../../scripts/api.js";

const SAVE_DELAY_MS = 600;

function el(tag, props) {
    const e = document.createElement(tag);
    if (props) for (const k in props) e[k] = props[k];
    return e;
}

/** The marks of a store grouped by their frame range, in frame order. */
export function groupMarks(items) {
    const by = new Map();
    for (const it of items || []) {
        if (it.f === undefined) continue;
        const k = it.f + ":" + (it.fe === undefined ? it.f : it.fe);
        if (!by.has(k)) by.set(k, { frame: it.f, end: it.fe === undefined ? it.f : it.fe, items: [] });
        by.get(k).items.push(it);
    }
    return [...by.values()].sort((a, b) => a.frame - b.frame || a.end - b.end);
}

export const AnnotateVideoMixin = {

    // ── which file, and what it is called to the server ───────────────────────
    _annotVideoRef() {
        const fr = (this._baseFrames && this._baseFrames() || [])[0];
        if (!fr) return null;
        if (typeof fr.path === "string" && fr.path) return { path: fr.path, external: fr.external ? 1 : 0 };
        if (fr.filename && !fr.url) {
            return { filename: fr.filename, subfolder: fr.subfolder || "", type: fr.type || "output" };
        }
        return null;
    },

    _annotVideoStoreKey() { return this._videoKey ? "vid:" + this._videoKey : null; },

    // ── loading and saving the sidecar ────────────────────────────────────────
    async _annotVideoLoad() {
        if (!this._videoMode || !this._videoKey) return;
        const key = this._videoKey;
        const st = this._annotVid;
        if (st && st.key === key) return;
        const ref = this._annotVideoRef();
        const mine = this._annotVid = { key, ref, loaded: false, persist: !!ref, mediaPath: ref && ref.path || "" };
        if (!ref) { mine.loaded = true; return; }
        let doc = null;
        try {
            const q = new URLSearchParams(Object.entries(ref).map(([k, v]) => [k, String(v)]));
            const r = await api.fetchApi("/bepic/video_annotations?" + q.toString());
            if (r.ok) doc = await r.json();
        } catch (e) { doc = null; }
        if (this._annotVid !== mine) return;          // another clip came up meanwhile
        if (!doc) { mine.persist = false; mine.loaded = true; return; }   // never overwrite what was not read
        const sk = "vid:" + key;
        const local = this._annotStore[sk] || [];
        const loaded = (doc.items || []).map((it, i) => Object.assign({ id: `v${i}_${Date.now() % 1e6}` }, it));
        this._annotStore[sk] = loaded.concat(local);
        if (doc.media_path) mine.mediaPath = doc.media_path;
        mine.loaded = true;
        this._annotVideoMarks(true);
        this._toolRedraw && this._toolRedraw();
        this._annotUpdateInfo && this._annotUpdateInfo();
        if (local.length) this._annotVideoChanged();
    },

    _annotVideoChanged() {
        if (!this._videoMode) return;
        this._annotVideoMarks(true);
        this._annotVideoRefreshPanel();
        const st = this._annotVid;
        if (!st || !st.persist || !st.loaded || st.key !== this._videoKey) return;
        clearTimeout(st.timer);
        st.timer = setTimeout(() => this._annotVideoSave(), SAVE_DELAY_MS);
    },

    async _annotVideoSave() {
        const st = this._annotVid;
        if (!st || !st.persist || !st.loaded) return false;
        clearTimeout(st.timer);
        const items = (this._annotStore["vid:" + st.key] || []).filter((it) => it.f !== undefined)
            .map((it) => { const c = Object.assign({}, it); delete c._editing; return c; });
        const base = String(st.mediaPath || st.key).split(/[\\/]/).pop();
        try {
            const r = await api.fetchApi("/bepic/video_annotations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({}, st.ref, {
                    items, fps: this._videoFps || 0, frames: this._videoFrames || 0, media: base })),
            });
            const j = await r.json().catch(() => ({}));
            if (r.ok && j.media_path) st.mediaPath = j.media_path;
            return r.ok;
        } catch (e) {
            console.warn("[annot] could not save the marks beside the video", e);
            return false;
        }
    },

    // ── marks belong to frames ────────────────────────────────────────────────
    _annotVideoStamp(it) {
        if (!this._videoMode) return;
        const cur = Math.max(0, Math.round(this.currentFrame || 0));
        const hold = Math.max(1, Math.round(this._annot.hold || 1));
        let end = cur + hold - 1;
        if (this._videoFrames > 0) end = Math.min(end, this._videoFrames - 1);
        it.f = cur;
        it.fe = Math.max(cur, end);
    },

    // Every move of the playhead: the marks on screen follow it.
    _annotFrameChanged() {
        this._annotVideoLoad();
        this._annotVideoMarks();
        this._annotVideoRefreshPanel();
        if (this._toolState && this._toolState.active === "annotate") {
            const sig = this._videoMode ? this._annotVisible().map((i) => i.id).join(",") + "|" + this._annot.sel : "";
            if (sig !== this._annotVisSig) {
                this._annotVisSig = sig;
                this._toolRedraw();
                this._annotUpdateInfo();
            }
        }
    },

    _annotGroups() {
        return groupMarks(this._annotStore["vid:" + this._videoKey] || []);
    },

    // ── timeline markers ──────────────────────────────────────────────────────
    _annotVideoMarks(force) {
        const host = this.shadowRoot && this.shadowRoot.getElementById("timeline-container");
        if (!host) return;
        let box = host.querySelector(".timeline-annot");
        if (!box) {
            if (!this.shadowRoot.getElementById("bepic-annot-tl-style")) {
                const s = document.createElement("style");
                s.id = "bepic-annot-tl-style";
                s.textContent = `
                    .timeline-annot { position:absolute; bottom:0; left:4px; right:4px; height:6px;
                        pointer-events:none; z-index:3; }
                    .timeline-annot i { position:absolute; bottom:0; height:100%; min-width:4px;
                        background:#00c7be; border-radius:1px; box-shadow:0 0 0 1px rgba(0,0,0,.6); }
                    .timeline-annot i.cur { background:#ffcc00; }`;
                this.shadowRoot.appendChild(s);
            }
            box = document.createElement("div");
            box.className = "timeline-annot";
            host.appendChild(box);
        }
        const groups = this._videoMode ? this._annotGroups() : [];
        const bounds = this.getTimelineBounds();
        const total = Math.max(1, bounds.max - bounds.min);
        const cur = Math.round(this.currentFrame || 0);
        const sig = groups.map((g) => `${g.frame}-${g.end}${cur >= g.frame && cur <= g.end ? "*" : ""}`).join(",")
            + `|${bounds.min}:${bounds.max}`;
        if (!force && box._sig === sig) return;
        box._sig = sig;
        const pct = (f) => ((f - bounds.min) / total) * 100;
        box.innerHTML = groups.map((g) => {
            const left = pct(g.frame), width = Math.max(0, pct(g.end + 1) - left);
            const words = g.items.filter((i) => i.type === "text").map((i) => i.text).join(" / ");
            const on = cur >= g.frame && cur <= g.end;
            return `<i class="${on ? "cur" : ""}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%"`
                + ` title="${(g.end > g.frame ? `frames ${g.frame}-${g.end}` : `frame ${g.frame}`)}${words ? ": " + words.replace(/"/g, "'") : ""}"></i>`;
        }).join("");
        box.style.display = groups.length ? "block" : "none";
    },

    _annotJump(dir) {
        const cur = Math.round(this.currentFrame || 0);
        const starts = [...new Set(this._annotGroups().map((g) => g.frame))];
        const to = dir < 0 ? Math.max(-1, ...starts.filter((f) => f < cur))
                           : Math.min(Infinity, ...starts.filter((f) => f > cur));
        if (!Number.isFinite(to) || to < 0) return;
        this.setFrame(to);
    },

    // End the marks of the last annotation here: trims the ones on screen, or
    // stretches the nearest one before this frame up to it.
    _annotOutHere() {
        const cur = Math.round(this.currentFrame || 0);
        const items = this._annotStore["vid:" + this._videoKey] || [];
        const on = items.filter((it) => it.f !== undefined && this._annotShown(it));
        let targets = on;
        if (!on.length) {
            const before = items.filter((it) => it.f !== undefined && it.fe < cur);
            if (!before.length) { this._toolSetStatus("<b>Annotate:</b> nothing to extend before this frame"); return; }
            const last = Math.max(...before.map((it) => it.fe));
            targets = before.filter((it) => it.fe === last);
        }
        for (const it of targets) it.fe = Math.max(it.f, cur);
        this._annotAfterChange();
    },

    // ── the panel ─────────────────────────────────────────────────────────────
    _annotBuildSend(p) {
        const box = el("div", { className: "bepic-annot-video" });
        const sec = el("div", { className: "bepic-tool-hint", textContent: "Video" });
        sec.style.cssText += "margin-top:8px;font-weight:600;";
        box.appendChild(sec);

        const hold = el("div", { className: "row" });
        hold.appendChild(el("label", { textContent: "Hold" }));
        const hn = el("input", { type: "number", min: "1", max: "100000", value: this._annot.hold || 1 });
        hn.title = "A new mark stays on this many frames, starting at the current one";
        hn.oninput = () => { this._annot.hold = Math.max(1, Math.round(+hn.value || 1)); };
        hold.appendChild(hn);
        hold.appendChild(el("span", { textContent: "frames" }));
        const out = el("button", { className: "bepic-act", textContent: "Out here" });
        out.title = "End the last annotation at the current frame";
        out.onclick = () => this._annotOutHere();
        hold.appendChild(out);
        box.appendChild(hold);

        const nav = el("div", { className: "bepic-annot-row" });
        const prev = el("button", { className: "bepic-act", textContent: "◀ Mark", title: "Previous annotated frame" });
        const next = el("button", { className: "bepic-act", textContent: "Mark ▶", title: "Next annotated frame" });
        prev.onclick = () => this._annotJump(-1);
        next.onclick = () => this._annotJump(1);
        nav.appendChild(prev); nav.appendChild(next);
        box.appendChild(nav);
        this._annotMarkInfo = el("div", { className: "bepic-tool-hint" });
        box.appendChild(this._annotMarkInfo);
        this._annotVideoBox = box;
        p.appendChild(box);

        // Send.
        const row = el("div", { className: "bepic-annot-row" });
        const send = el("button", { className: "bepic-act", textContent: "Send to agentY" });
        send.style.cssText += "background:#10303a;border-color:#0aa;color:#fff;font-weight:600;";
        send.onclick = () => this._annotSend(false);
        const here = el("button", { className: "bepic-act", textContent: "This frame" });
        here.title = "Send only the marks on the current frame";
        here.onclick = () => this._annotSend(true);
        row.appendChild(send); row.appendChild(here);
        p.appendChild(row);
        this._annotSendBtn = send; this._annotSendHereBtn = here; this._annotSendRow = row;
        this._annotVideoRefreshPanel();
    },

    _annotBridge() {
        const b = typeof window !== "undefined" ? window.agentYViewerBridge : null;
        return b && typeof b.feedback === "function" ? b : null;
    },

    _annotVideoRefreshPanel() {
        const v = !!this._videoMode;
        if (this._annotVideoBox) this._annotVideoBox.style.display = v ? "" : "none";
        if (this._annotSendHereBtn) this._annotSendHereBtn.style.display = v ? "" : "none";
        if (this._annotSendRow) this._annotSendRow.style.display = this._annotBridge() ? "" : "none";
        const clr = this._annotPanel && this._annotPanel.querySelector(".bepic-danger");
        if (clr) clr.textContent = v ? "Clear frame" : "Clear";
        if (this._annotSendBtn) {
            let halted = false;
            try { halted = !!(this._annotBridge()?.state?.().halted); } catch (_) {}
            this._annotSendBtn.textContent = halted ? "Send review feedback" : "Send to agentY";
        }
        if (this._annotMarkInfo && v) {
            const n = this._annotGroups().length;
            this._annotMarkInfo.textContent = n === 1 ? "1 annotated frame range" : `${n} annotated frame ranges`;
        }
    },

    // ── send to agentY ────────────────────────────────────────────────────────
    async _annotSeekTo(frame) {
        const v = this.videoBase;
        try { v.pause(); } catch (_) {}
        const t = this._videoTimeForFrame(frame);
        if (Math.abs(v.currentTime - t) > 1e-4 || v.readyState < 2) {
            await new Promise((res) => {
                let done = false;
                const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); res(); };
                v.addEventListener("seeked", fin);
                v.currentTime = t;
                setTimeout(fin, 4000);
            });
        }
        await new Promise((r) => setTimeout(r, 30));      // let the decoded frame land
    },

    _annotImageSource() {
        try {
            const frames = this._baseFrames() || [];
            const i = this.displayFrameToImageIndex(this.currentFrame, frames.length);
            const fr = frames[i];
            return fr && typeof fr.path === "string" ? fr.path : "";
        } catch (_) { return ""; }
    },

    async _annotSend(onlyHere) {
        const bridge = this._annotBridge();
        if (!bridge) { this._toolSetStatus("<b>Annotate:</b> agentY is not available here"); return; }
        this._annotCommitText();
        const video = !!this._videoMode;
        const src = video ? this.videoBase : this.imgBase;
        const w = video ? (src && src.videoWidth) : (src && src.naturalWidth);
        const h = video ? (src && src.videoHeight) : (src && src.naturalHeight);
        if (!w || !h) { this._toolSetStatus("<b>Annotate:</b> no picture to send"); return; }

        let groups;
        if (video) {
            groups = this._annotGroups();
            if (onlyHere) {
                const cur = Math.round(this.currentFrame || 0);
                groups = groups.filter((g) => cur >= g.frame && cur <= g.end);
            }
        } else {
            const items = this._annotItems(false) || [];
            groups = items.length ? [{ frame: 0, end: 0, items }] : [];
        }
        if (!groups.length) { this._toolSetStatus("<b>Annotate:</b> nothing is marked yet"); return; }

        const btn = this._annotSendBtn;
        if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
        const resume = Math.round(this.currentFrame || 0);
        try {
            if (video) await this._annotVideoSave();
            const files = [];
            for (const g of groups) {
                if (video) await this._annotSeekTo(g.frame);
                const dataurl = this._annotFlatten(src, w, h, g.items, true);
                if (!dataurl) throw new Error("the picture is cross-origin - it cannot be read back");
                const saved = await this._annotSavePng(dataurl,
                    video ? `annotation_f${String(g.frame).padStart(5, "0")}` : "annotation");
                g.image = saved.path || "";
                if (g.image) files.push(g.image);
                if (!video) this._annotAddToHistory(saved);
            }
            const source = video ? ((this._annotVid && this._annotVid.mediaPath) || this._videoKey || "")
                                 : this._annotImageSource();
            let halted = false;
            try { halted = !!(bridge.state && bridge.state().halted); } catch (_) {}
            const text = buildFeedback({
                kind: video ? "video" : "image", source, w, h,
                fps: this._videoFps, frames: this._videoFrames, groups, halted,
            });
            const r = await bridge.feedback({ text, files });
            const ok = !!(r && r.ok);
            this._toolSetStatus(`<b>Annotate:</b> ${(r && r.message) || (ok ? "sent" : "not sent")}`);
            notice(ok ? "success" : "warn", ok ? "Sent to agentY" : "Not sent to agentY",
                   (r && r.message) || `${groups.length} annotation${groups.length === 1 ? "" : "s"}`);
        } catch (e) {
            console.error("[annot] send failed", e);
            this._toolSetStatus("<b>Annotate:</b> could not send");
            notice("error", "Annotation not sent", String((e && e.message) || e));
        } finally {
            if (video) { try { this.setFrame(resume); } catch (_) {} }
            if (btn) btn.disabled = false;
            this._annotVideoRefreshPanel();
        }
    },
};
