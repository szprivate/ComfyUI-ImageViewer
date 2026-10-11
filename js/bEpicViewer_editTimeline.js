// bEpicViewer_editTimeline.js
// The cut that lies beside a film, drawn as a strip over the scrub bar.
//
// A film that was edited rather than generated usually has its edit next to it:
// an OpenTimelineIO file of the same name (agentY's edit stage writes one, and so
// can Resolve, Nuke Studio or Premiere). The server flattens it (/bepic/timeline,
// timeline_io.py) and this draws it: one block per shot, a mark on every
// dissolve, the texts on a track above and the sound on one below. Click a shot
// to go to its first frame; the strip is as wide as the scrub bar, so a block
// sits exactly over the frames it covers.
//
// It only shows. A film with no timeline beside it - the ordinary case - shows
// nothing, and costs one small request per film.
//
// Where things sit is worked out in bEpicViewer_editTimelineData.js (plain
// functions, run under node); this is the panel side.
import { api } from "../../scripts/api.js";
import { layoutTimeline, shotAt, timelineQuery } from "./bEpicViewer_editTimelineData.js";

const pct = (v) => Math.max(0, Math.min(100, v));

export const EditTimelineMixin = {

    // The row the strip lives in, made on first use (the panel's HTML may be an
    // older cached copy that does not carry it). It goes straight above the scrub
    // bar's own row and is padded like it, so the two are the same width.
    _editTlEnsure() {
        if (this._editTlRow && this._editTlRow.isConnected) return this._editTlRow;
        const bar = this.container && this.container.querySelector("#timeline-container");
        const row = bar && bar.parentElement;
        if (!row || !row.parentElement) return null;
        const doc = row.ownerDocument;
        const el = doc.createElement("div");
        el.className = "edit-tl-row";
        el.hidden = true;
        el.innerHTML = '<div class="edit-tl" id="edit-tl">'
            + '<div class="edit-tl-track edit-tl-texts"></div>'
            + '<div class="edit-tl-track edit-tl-shots"></div>'
            + '<div class="edit-tl-track edit-tl-audio"></div>'
            + '<div class="edit-tl-head"></div></div>';
        row.parentElement.insertBefore(el, row);
        this._editTlRow = el;
        return el;
    },

    // A film came on screen (or left: pass null). Asks once per film; a film that
    // has gone again by the time the answer arrives is not drawn.
    async editTlShow(obj) {
        const query = timelineQuery(obj);
        const key = query || "";
        if (key === this._editTlKey) return;
        this._editTlKey = key;
        this._editTlData = null;
        this._editTlDraw();
        if (!query) return;
        let data = null;
        try {
            const res = await api.fetchApi("/bepic/timeline" + query);
            if (res.ok) data = await res.json();
        } catch (e) { data = null; }
        if (this._editTlKey !== key) return;
        this._editTlData = data;
        this._editTlDraw();
    },

    _editTlDuration() {
        const v = this.videoBase;
        if (v && Number.isFinite(v.duration) && v.duration > 0) return v.duration;
        const fps = this._videoFps || 24;
        return this._videoFrames > 0 ? this._videoFrames / fps : 0;
    },

    _editTlDraw() {
        const row = this._editTlEnsure();
        if (!row) return;
        const data = this._editTlData;
        const lay = layoutTimeline(data, this._editTlDuration());
        if (!data || !lay.shots.length) { row.hidden = true; this._editTlLayout = null; return; }
        this._editTlLayout = lay;
        const doc = row.ownerDocument;
        const block = (cls, item, text) => {
            const b = doc.createElement("div");
            b.className = cls;
            b.style.left = item.left + "%";
            b.style.width = item.width + "%";
            b.title = item.title || "";
            if (text) b.textContent = text;
            return b;
        };
        const shots = row.querySelector(".edit-tl-shots");
        const kids = lay.shots.map((s, i) => {
            const b = block("edit-tl-shot" + (s.gap ? " gap" : ""), s, s.gap ? "" : s.name);
            if (!s.gap) {
                b.dataset.shot = String(i);
                b.addEventListener("click", () => this._editTlGo(s.start));
            }
            return b;
        });
        // A dissolve is drawn over the join it sits on.
        for (const t of lay.transitions) kids.push(block("edit-tl-mix", t, ""));
        shots.replaceChildren(...kids);
        const texts = row.querySelector(".edit-tl-texts");
        texts.replaceChildren(...lay.texts.map((t) => {
            const b = block("edit-tl-text", t, t.name);
            b.addEventListener("click", () => this._editTlGo(t.start));
            return b;
        }));
        texts.hidden = !lay.texts.length;
        const audio = row.querySelector(".edit-tl-audio");
        audio.replaceChildren(...lay.audio.map((a) => block("edit-tl-sound", a, a.name)));
        audio.hidden = !lay.audio.length;
        row.hidden = false;
        this._editTlPlayhead();
    },

    // Go to a moment of the film: the first frame at or after it, which for a
    // shot is the frame it cuts in on.
    _editTlGo(seconds) {
        const fps = this._videoFps || this.fps || 24;
        const frame = Math.max(0, Math.ceil(seconds * fps - 1e-6));
        if (this.stop && this.isPlaying) this.stop();
        this.setFrame(frame);
    },

    // The line that follows the frame, and which shot is lit. Called whenever the
    // frame moves (_toolsFrameChanged), so it has to cost nothing when no strip is up.
    _editTlPlayhead() {
        const lay = this._editTlLayout;
        const row = this._editTlRow;
        if (!lay || !row || row.hidden) return;
        const fps = this._videoFps || this.fps || 24;
        const seconds = ((this.currentFrame || 0) + 0.5) / fps;
        const head = row.querySelector(".edit-tl-head");
        if (head) head.style.left = pct((seconds / lay.total) * 100) + "%";
        const now = shotAt(lay.shots, seconds);
        if (now === this._editTlNow) return;
        this._editTlNow = now;
        for (const b of row.querySelectorAll(".edit-tl-shot")) {
            b.classList.toggle("on", b.dataset.shot === String(now));
        }
    },
};
