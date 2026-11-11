// imageViewer_previzPlayblast.js
// Playblast: a quick film of the shot as the 3D view draws it, with a
// heads-up display (imageViewer_playblastHud.js) burnt in, straight into the
// History. The 3D menu's "Playblast…".
//
// It is the render (imageViewer_previzRender.js, previzRender) with its own
// few choices and a frame filter that writes the display over each frame, so
// it lands where every export lands - output/previz/<name>_playblast as the
// next version - and in the History, without a loader node on the graph and
// without touching the shot's own render settings.
import * as S from "./imageViewer_scene3d.js";
import { drawHud, hudFields } from "./imageViewer_playblastHud.js";
import { notice } from "./imageViewer_exportUI.js";

const SCALES = [25, 50, 75, 100];
const FORMATS = [["mp4", "MP4 (H.264)"], ["mov", "MOV"], ["webm", "WebM (VP9)"]];

export const PrevizPlayblastMixin = {

    /** What a playblast starts from: the last one's choices, else the playback range at half size. */
    _pbSettings() {
        const scene = this.previzScene();
        const last = Math.max(0, (scene.length || 1) - 1);
        const kept = this._pbKept || {};
        const range = this.playbackRange && Number.isFinite(this.playbackRange.start) && Number.isFinite(this.playbackRange.end)
            ? { start: Math.max(0, Math.floor(this.playbackRange.start)), end: Math.min(last, Math.floor(this.playbackRange.end)) }
            : { start: 0, end: last };
        const st = S.renderSettings(scene);
        return {
            camera: kept.camera !== undefined ? kept.camera : this._renderCameraId(st, scene),
            scale: kept.scale || 50,
            format: kept.format || "mp4",
            shading: kept.shading || "original",
            hud: kept.hud !== false,
            note: kept.note || "",
            start: range.start, end: range.end,
        };
    },

    /** Burn the display into one frame (a PNG data URL in, one out). */
    async _pbBurn(dataurl, frame, ctx) {
        const doc = this.container.ownerDocument;
        const img = doc.createElement("img");
        img.src = dataurl;
        await img.decode();
        const c = doc.createElement("canvas");
        c.width = ctx.w; c.height = ctx.h;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, ctx.w, ctx.h);
        drawHud(g, ctx.w, ctx.h, hudFields({ ...ctx.info, frame,
            fov: ctx.cam ? S.valueAt(ctx.cam, "fov", frame) : (ctx.viewFov ?? null) }));
        return c.toDataURL("image/png");
    },

    /**
     * Make a playblast. opts: { camera ("" = the view), start, end, scale, format,
     * shading, hud, note }. Returns previzRender's result.
     */
    async previzPlayblast(opts = {}) {
        if (!this.isPrevizTab || !this.isPrevizTab()) return null;
        const scene = this.previzScene();
        const st = { ...this._pbSettings(), ...opts };
        const shot = (this.previzRenderName && this.previzRenderName()) || "shot";
        const cam = st.camera ? S.itemById(scene, st.camera) : null;
        const view = this._modelView();
        const viewFov = view && view.camera && view.camera.fov;
        const info = { shot, camera: cam ? cam.name : "Free view", start: st.start, end: st.end,
                       fps: scene.fps || 24, note: st.note, date: new Date() };
        const settings = {
            name: `${shot}_playblast`, camera: st.camera || "", useCameraRes: true,
            scale: st.scale, format: st.format, quality: "medium", codec: st.format === "mov" ? "h264" : "",
            start: st.start, end: st.end, fps: scene.fps || 24,
            shading: st.shading, background: "viewer", aa: 1, grid: false, helpers: false, addNode: false,
        };
        const filter = st.hud ? (dataurl, frame, ctx) => this._pbBurn(dataurl, frame,
            { ...ctx, cam, viewFov, info: { ...info, width: ctx.w, height: ctx.h } }) : null;
        return this.previzRender(settings, { onProgress: opts.onProgress || null, frameFilter: filter, label: "Playblast" });
    },

    previzPlayblastDialog() {
        if (!this.isPrevizTab || !this.isPrevizTab()) return;
        if (this._pbDlg && this._pbDlg.isConnected) { if (!this._previzRendering) this._pbDlg.remove(); return; }
        const host = this.container;
        const doc = host.ownerDocument;
        const scene = this.previzScene();
        const st = this._pbSettings();
        const last = Math.max(0, (scene.length || 1) - 1);
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const select = (options, value) => {
            const s = el("select", "rd-in");
            for (const [v, label] of options) s.append(Object.assign(el("option"), { value: String(v), textContent: label }));
            s.value = String(value);
            return s;
        };
        const number = (value) => {
            const n = el("input", "rd-in rd-num");
            n.type = "number"; n.min = "0"; n.max = String(last); n.value = String(value);
            return n;
        };
        const row = (label, ...kids) => {
            const r = el("div", "rd-row");
            r.append(el("span", "rd-label", label), ...kids);
            return r;
        };
        const shade = el("div", "rd-shade pb-shade");
        const box = el("div", "rd-box pb-box");
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "Playblast");
        const head = el("div", "rd-head");
        const x = el("button", "rd-x", "✕");
        head.append(el("span", "rd-title", "Playblast"), x);

        const camera = select([...S.cameras(scene).map((c) => [c.id, c.name]), ["", "The view as it is"]], st.camera);
        const start = number(st.start), end = number(st.end);
        const rangeWrap = el("span", "rd-inline");
        rangeWrap.append(start, el("span", "rd-sub", "to"), end);
        const scale = select(SCALES.map((v) => [v, `${v}%`]), st.scale);
        const format = select(FORMATS, st.format);
        const shading = select([["original", "Original"], ["clay", "Clay"], ["normal", "Normals"], ["wireframe", "Wireframe"]], st.shading);
        const hudWrap = el("label", "rd-check");
        const hud = el("input");
        hud.type = "checkbox"; hud.checked = st.hud;
        hudWrap.append(hud, doc.createTextNode(" Shot, camera, lens, frame and timecode on every frame"));
        const note = el("input", "rd-in rd-text");
        note.placeholder = "A note for the bottom of the frame (optional)";
        note.value = st.note;
        const progress = el("div", "rd-progress");
        const bar = el("div", "rd-bar");
        progress.append(bar);
        const message = el("div", "rd-message");
        const cancel = el("button", "rd-btn", "Cancel");
        const go = el("button", "rd-btn rd-go", "Playblast");
        const foot = el("div", "rd-foot");
        foot.append(cancel, go);
        box.append(head, row("Camera", camera), row("Frames", rangeWrap), row("Size", scale), row("Format", format),
                   row("Shading", shading), row("HUD", hudWrap), row("Note", note),
                   el("div", "rd-summary", "Lands in the History; output/previz/…_playblast, next version."),
                   progress, message, foot);
        shade.append(box);
        host.append(shade);
        this._pbDlg = shade;

        const close = () => { if (!this._previzRendering) shade.remove(); };
        box.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); close(); }
            if (e.key === "Enter" && e.target.tagName !== "SELECT") { e.preventDefault(); go.click(); }
        });
        shade.addEventListener("pointerdown", (e) => { if (e.target === shade) close(); });
        x.onclick = cancel.onclick = () => {
            if (this._previzRendering) { this._previzRenderStop = true; return; }
            close();
        };
        go.onclick = async () => {
            if (this._previzRendering) { this._previzRenderStop = true; return; }
            const s = { camera: camera.value, start: Number(start.value) || 0, end: Number(end.value),
                        scale: Number(scale.value) || 50, format: format.value, shading: shading.value,
                        hud: hud.checked, note: note.value.trim() };
            if (!(s.end >= s.start)) { message.textContent = "The range has to end after it starts."; return; }
            this._pbKept = { camera: s.camera, scale: s.scale, format: s.format, shading: s.shading, hud: s.hud, note: s.note };
            go.textContent = "Stop"; cancel.textContent = "Stop";
            const result = await this.previzPlayblast({ ...s, onProgress: (done, total) => {
                bar.style.width = `${Math.round(100 * done / Math.max(1, total))}%`;
                message.textContent = done < total ? `Frame ${done + 1} of ${total}…` : "Encoding…";
            } });
            go.textContent = "Playblast"; cancel.textContent = "Close";
            if (result && result.ok && !result.stopped) { shade.remove(); return; }
            message.textContent = result ? result.message : "Nothing was made.";
            if (!result) notice("info", "Playblast", "Another render is running.");
        };
        (doc.defaultView || window).requestAnimationFrame(() => go.focus());
    },
};
