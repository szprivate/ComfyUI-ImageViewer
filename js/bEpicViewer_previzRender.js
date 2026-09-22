// bEpicViewer_previzRender.js
// Rendering the shot: a dialog with every setting a render has, and the loop
// that plays the shot through a camera and hands each frame to the server.
//
// The settings are kept on the scene (scene3d's `render`), so the next render
// of the same shot — on this machine or on the next one the workflow lands
// on — starts from the same choices.
//
// Frames go up one at a time, because a canvas hands over one picture at a
// time. A video format then has the server encode them into
// output/previz/<name>.<format> and drop the stills; PNG keeps the stills,
// numbered by their frame in the shot. The bEpic 3D Scene node reads back
// whichever is there.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import * as S from "./bEpicViewer_scene3d.js";

const FORMATS = [
    ["mp4", "MP4 (H.264)"], ["mov", "MOV (H.264)"], ["webm", "WebM (VP9)"], ["png", "PNG sequence"],
];
const RES_PRESETS = [
    ["HD 1080", 1920, 1080], ["HD 720", 1280, 720], ["UHD 4K", 3840, 2160],
    ["DCI 2K", 2048, 1080], ["DCI 4K", 4096, 2160], ["Square 1080", 1080, 1080],
    ["Vertical 1080", 1080, 1920], ["Scope 2.39", 2048, 858],
];
const SCALES = [25, 50, 75, 100, 150, 200];

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

export const PrevizRenderMixin = {

    // ── Settings ─────────────────────────────────────────────────────────────

    /** The camera a render goes through: an item id, or "" for the free view. */
    _renderCameraId(st, scene) {
        const cams = S.cameras(scene);
        if (st.camera === "") return "";
        if (st.camera && cams.some((c) => c.id === st.camera)) return st.camera;
        if (scene.activeCamera && cams.some((c) => c.id === scene.activeCamera)) return scene.activeCamera;
        return cams.length ? cams[0].id : "";
    },

    /** The picture size a render will have, after the camera and the scale. */
    _renderSize(st, scene) {
        const camId = this._renderCameraId(st, scene);
        const cam = camId ? S.itemById(scene, camId) : null;
        const [bw, bh] = (cam && st.useCameraRes) ? S.cameraResolution(cam) : [st.width, st.height];
        const k = (st.scale || 100) / 100;
        // Video encoders want even sizes; a still would not mind, but one rule
        // is easier to predict than two.
        return { w: even(bw * k), h: even(bh * k) };
    },

    _renderRange(st, scene) {
        const last = Math.max(0, (scene.length || 1) - 1);
        const start = Math.min(last, Math.max(0, st.start || 0));
        const end = Math.min(last, Math.max(start, st.end === null ? last : st.end));
        return { start, end, count: end - start + 1 };
    },

    /** Keep the settings on the scene (and so on the node), without an undo step. */
    _renderKeep(st) {
        const scene = this.previzScene();
        if (!scene) return;
        scene.render = S.renderSettings({ render: st });
        this.previzPersist();
        this.queuePersistViewerState && this.queuePersistViewerState();
    },

    /** The render name, and the node's render_name widget kept in step with it. */
    _renderSetName(name) {
        const key = this.activeTab;
        if (!this._previzRenderNames) this._previzRenderNames = {};
        this._previzRenderNames[key] = name;
        const nodeId = this.tabSourceNodeIds && this.tabSourceNodeIds[key];
        if (nodeId == null) return;
        try {
            const node = app.graph.getNodeById(nodeId);
            const w = node && (node.widgets || []).find((x) => x && x.name === "render_name");
            // The node reads the shot back by this name: they must agree.
            if (w && w.value !== name) { w.value = name; app.graph.setDirtyCanvas(true, false); }
        } catch (e) { /* no graph: the viewer alone still renders */ }
    },

    // ── The dialog ───────────────────────────────────────────────────────────

    /** Open the render dialog — or close it, when it is already open. */
    previzRenderDialog() {
        if (!this.isPrevizTab()) return;
        if (this._renderDlg && this._renderDlg.root.isConnected) {
            if (!this._previzRendering) this._renderDlgClose();
            return;
        }
        // Over the whole viewer, which is positioned and always an ancestor
        // of wherever the panels are docked.
        const host = this.container;
        if (!host) return;
        const doc = host.ownerDocument;
        const scene = this.previzScene();
        const st = S.renderSettings(scene);
        st.camera = this._renderCameraId(st, scene);
        st.name = this.previzRenderName();

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
        const number = (value, min, max, step = 1) => {
            const n = el("input", "rd-in rd-num");
            n.type = "number"; n.min = String(min); n.max = String(max); n.step = String(step);
            n.value = String(value);
            return n;
        };
        const check = (label, on) => {
            const wrap = el("label", "rd-check");
            const box = el("input");
            box.type = "checkbox"; box.checked = !!on;
            wrap.append(box, doc.createTextNode(" " + label));
            return { wrap, box };
        };
        const row = (label, ...kids) => {
            const r = el("div", "rd-row");
            r.append(el("span", "rd-label", label), ...kids);
            return r;
        };
        const section = (title) => el("div", "rd-section", title);

        const shade = el("div", "rd-shade");
        const box = el("div", "rd-box");
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "Render the shot");
        const head = el("div", "rd-head");
        const close = el("button", "rd-x", "✕");
        close.title = "Close (Esc)";
        head.append(el("span", "rd-title", "Render Shot"), close);

        // Output
        const name = el("input", "rd-in rd-text");
        name.value = st.name; name.spellcheck = false;
        const where = el("span", "rd-hint");
        const format = select(FORMATS, st.format);
        const quality = select([["high", "High"], ["medium", "Medium"], ["low", "Low"]], st.quality);
        const qualityWrap = el("span", "rd-inline");
        qualityWrap.append(el("span", "rd-sub", "Quality"), quality);

        // Camera and size
        const cams = S.cameras(scene);
        const camera = select([...cams.map((c) => [c.id, c.name]), ["", "Free view (perspective)"]], st.camera);
        const useCam = check("Use the camera's resolution", st.useCameraRes);
        const width = number(st.width, 16, 8192);
        const height = number(st.height, 16, 8192);
        const preset = select([["", "Preset…"], ...RES_PRESETS.map(([l, w, h]) => [`${w}x${h}`, `${l}  ${w}×${h}`])], "");
        const sizeWrap = el("span", "rd-inline");
        sizeWrap.append(width, el("span", "rd-sub", "×"), height, preset);
        const scale = select(SCALES.map((v) => [v, `${v}%`]), SCALES.includes(st.scale) ? st.scale : 100);
        const outSize = el("span", "rd-hint");

        // Frames
        const last = Math.max(0, (scene.length || 1) - 1);
        const start = number(st.start, 0, last);
        const end = number(st.end === null ? last : st.end, 0, last);
        const whole = el("button", "rd-btn", "Whole shot");
        const here = el("button", "rd-btn", "This frame");
        const rangeWrap = el("span", "rd-inline");
        rangeWrap.append(start, el("span", "rd-sub", "to"), end, whole, here);
        const fps = number(st.fps || scene.fps || 24, 1, 240, 0.01);

        // Look
        const shading = select([["original", "Original"], ["clay", "Clay"], ["normal", "Normals"], ["wireframe", "Wireframe"]], st.shading);
        const background = select([["viewer", "Viewer colour"], ["color", "Colour"], ["transparent", "Transparent"]], st.background);
        const color = el("input", "rd-color");
        color.type = "color"; color.value = st.color;
        const bgWrap = el("span", "rd-inline");
        bgWrap.append(background, color);
        const aa = select([[1, "Off"], [2, "2× supersampling"], [4, "4× supersampling"]], st.aa);
        const grid = check("Grid", st.grid);
        const helpers = check("Camera frustums & helpers", st.helpers);
        const includeWrap = el("span", "rd-inline");
        includeWrap.append(grid.wrap, helpers.wrap);

        // After
        const addNode = check("Put a loader node on the graph", st.addNode);

        const summary = el("div", "rd-summary");
        const progress = el("div", "rd-progress");
        const bar = el("div", "rd-bar");
        progress.append(bar);
        const message = el("div", "rd-message");
        const cancel = el("button", "rd-btn", "Cancel");
        const go = el("button", "rd-btn rd-go", "Render");
        const foot = el("div", "rd-foot");
        foot.append(cancel, go);

        const fpsRow = row("Frame rate", fps, el("span", "rd-sub", "fps"));
        const useCamRow = row("Resolution", useCam.wrap);
        const qualityRow = row("", qualityWrap);
        box.append(
            head,
            section("Output"),
            row("Name", name, where),
            row("Format", format),
            qualityRow,
            section("Camera"),
            row("Camera", camera),
            useCamRow,
            row("", sizeWrap),
            row("Scale", scale, outSize),
            section("Frames"),
            row("Range", rangeWrap),
            fpsRow,
            section("Look"),
            row("Shading", shading),
            row("Background", bgWrap),
            row("Anti-aliasing", aa),
            row("Include", includeWrap),
            section("After"),
            row("", addNode.wrap),
            summary, progress, message, foot,
        );
        shade.append(box);
        host.append(shade);

        const read = () => ({
            name: (name.value || "").trim() || "shot",
            format: format.value, quality: quality.value,
            camera: camera.value, useCameraRes: useCam.box.checked,
            width: Number(width.value) || 1920, height: Number(height.value) || 1080,
            scale: Number(scale.value) || 100,
            start: Number(start.value) || 0, end: Number(end.value),
            fps: Number(fps.value) || scene.fps || 24,
            shading: shading.value, background: background.value, color: color.value,
            aa: Number(aa.value) || 1, grid: grid.box.checked, helpers: helpers.box.checked,
            addNode: addNode.box.checked,
        });

        // Everything that depends on something else, in one place.
        const sync = () => {
            const s = read();
            const isVideo = s.format !== "png";
            const cam = s.camera ? S.itemById(scene, s.camera) : null;
            // The free view has no resolution of its own to offer.
            useCamRow.style.display = cam ? "" : "none";
            const fromCam = !!cam && s.useCameraRes;
            if (fromCam) {
                const [w, h] = S.cameraResolution(cam);
                width.value = String(w); height.value = String(h);
            }
            width.disabled = height.disabled = preset.disabled = fromCam;
            qualityRow.style.display = isVideo ? "" : "none";
            fpsRow.style.display = isVideo ? "" : "none";
            // A video has no alpha to put a transparent background in.
            const tOpt = [...background.options].find((o) => o.value === "transparent");
            if (tOpt) tOpt.disabled = isVideo;
            if (isVideo && background.value === "transparent") background.value = "viewer";
            color.style.display = background.value === "color" ? "" : "none";
            const safe = (name.value || "").trim() || "shot";
            where.textContent = isVideo ? `→ output/previz/${safe}.${s.format}` : `→ output/previz/${safe}/`;
            const size = this._renderSize({ ...s, camera: s.camera }, scene);
            outSize.textContent = `→ ${size.w} × ${size.h} px`;
            const range = this._renderRange({ ...s, end: Number.isFinite(s.end) ? s.end : null }, scene);
            const secs = range.count / (s.fps || 24);
            summary.textContent = `${range.count} frame${range.count === 1 ? "" : "s"} · ${size.w}×${size.h}`
                + ` · ${FORMATS.find(([v]) => v === s.format)[1]}`
                + (isVideo ? ` · ${secs.toFixed(secs < 10 ? 2 : 1)} s at ${s.fps} fps` : "")
                + (s.aa > 1 ? ` · ${s.aa}× AA` : "");
        };
        for (const n of [name, format, quality, camera, width, height, scale, start, end, fps,
                         shading, background, color, aa, useCam.box, grid.box, helpers.box, addNode.box]) {
            n.addEventListener("input", sync);
            n.addEventListener("change", sync);
        }
        preset.onchange = () => {
            const [w, h] = preset.value.split("x").map(Number);
            if (w && h) { width.value = String(w); height.value = String(h); }
            preset.value = "";
            sync();
        };
        whole.onclick = () => { start.value = "0"; end.value = String(last); sync(); };
        here.onclick = () => {
            const f = Math.min(last, Math.max(0, Math.round(this.currentFrame || 0)));
            start.value = end.value = String(f);
            sync();
        };
        // Nothing typed here is a hotkey — neither the viewer's nor ComfyUI's.
        box.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); if (!this._previzRendering) this._renderDlgClose(); }
        });
        shade.addEventListener("pointerdown", (e) => {
            if (e.target === shade && !this._previzRendering) this._renderDlgClose();
        });
        close.onclick = cancel.onclick = () => {
            if (this._previzRendering) { this._previzRenderStop = true; return; }
            this._renderDlgClose();
        };
        go.onclick = async () => {
            if (this._previzRendering) { this._previzRenderStop = true; return; }
            const s = read();
            this._renderKeep({ ...s, end: s.end >= last ? null : s.end,
                               fps: Math.abs(s.fps - (scene.fps || 24)) < 1e-6 ? null : s.fps });
            this._renderSetName(s.name);
            const fields = [...box.querySelectorAll("input, select"), whole, here];
            fields.forEach((n) => { n.disabled = true; });
            go.textContent = "Stop";
            cancel.textContent = "Stop";
            message.textContent = "";
            message.classList.remove("error");
            box.classList.add("rendering");
            const result = await this.previzRender(s, {
                onProgress: (done, total) => {
                    bar.style.width = `${Math.round(100 * done / Math.max(1, total))}%`;
                    message.textContent = done < total ? `Frame ${done + 1} of ${total}…` : "Encoding…";
                },
            });
            box.classList.remove("rendering");
            go.textContent = "Render";
            cancel.textContent = "Close";
            fields.forEach((n) => { n.disabled = false; });
            sync();
            if (result && result.ok && !result.stopped) { this._renderDlgClose(); return; }
            message.textContent = result ? result.message : "Nothing was rendered.";
            message.classList.toggle("error", !!(result && result.error));
        };

        this._renderDlg = { root: shade, box, go };
        sync();
        (doc.defaultView || window).requestAnimationFrame(() => go.focus());
    },

    _renderDlgClose() {
        const d = this._renderDlg;
        this._renderDlg = null;
        if (d && d.root) d.root.remove();
    },

    // ── The render ───────────────────────────────────────────────────────────

    /**
     * Render the shot with `settings` (the dialog's; anything left out comes
     * from the scene's saved ones). Returns { ok, frames, stopped, error,
     * message }. `onProgress(done, total)` is told as each frame goes up.
     */
    async previzRender(settings = {}, { onProgress = null } = {}) {
        const scene = this.previzScene();
        if (!scene || this._previzRendering) return null;
        const st = { ...S.renderSettings(scene), ...settings };
        const view = this._modelView();
        const name = (st.name || this.previzRenderName() || "shot").trim() || "shot";
        const cameraId = this._renderCameraId(st, scene);
        const { w, h } = this._renderSize(st, scene);
        const { start, end, count } = this._renderRange({ ...st, end: Number.isFinite(st.end) ? st.end : null }, scene);
        const isVideo = st.format !== "png";
        const fps = Number(st.fps) || scene.fps || 24;
        const wasFrame = Math.round(this.currentFrame || 0);
        this._previzRendering = true;
        this._previzRenderStop = false;
        let done = 0, firstPath = null, framesDir = null, moviePath = null;
        const result = { ok: false, frames: 0, stopped: false, error: false, message: "" };
        try {
            if (!view.beginRender({
                camera: cameraId, shading: st.shading,
                background: isVideo && st.background === "transparent" ? "viewer" : st.background,
                color: st.color, grid: st.grid, helpers: st.helpers, aa: st.aa,
            })) throw new Error("the 3D view is not ready");
            for (let f = start; f <= end; f++) {
                if (this._previzRenderStop) { result.stopped = true; break; }
                if (onProgress) onProgress(done, count);
                const dataurl = view.renderFrame(f, w, h);
                if (!dataurl) throw new Error("the renderer produced no image");
                const res = await fetch(api.apiURL("/bepic/previz_frame"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, index: f, dataurl, first: f === start }),
                });
                const info = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(info.error || `the server answered ${res.status}`);
                if (f === start) { firstPath = info.path || null; framesDir = info.dir || null; }
                done++;
                view._setStatus(`Rendering ${name}: frame ${done} of ${count}…`);
            }
            view.endRender();
            result.frames = done;
            if (result.stopped) {
                result.message = `Stopped after ${done} of ${count} frames. They are in output/previz/${name}/`
                    + (isVideo ? " — not encoded." : ".");
                view._setStatus(result.message);
            } else if (!isVideo) {
                result.message = `Wrote ${done} PNG${done === 1 ? "" : "s"} into output/previz/${name}/`;
                view._setStatus(result.message);
            } else {
                if (onProgress) onProgress(count, count);
                view._setStatus(`Encoding ${done} frames…`);
                const enc = await fetch(api.apiURL("/bepic/previz_encode"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, fps, format: st.format, quality: st.quality }),
                });
                const encData = await enc.json().catch(() => ({}));
                if (!enc.ok) throw new Error(encData.error || `the server answered ${enc.status}`);
                moviePath = encData.path || null;
                result.message = `Wrote output/previz/${name}.${st.format}, ${done} frames long.`;
                view._setStatus(result.message);
            }
            result.ok = done > 0;
            // The shot goes back to the graph it was built for, as dragging a
            // history frame onto the canvas would put it there.
            if (result.ok && st.addNode && !(result.stopped && isVideo)) {
                const made = await this.previzNodeForRender(
                    isVideo && !result.stopped
                        ? { kind: "video", path: moviePath }
                        : { kind: "image", isSequence: done > 1, seqDir: framesDir, path: firstPath });
                if (made) view._setStatus(`${result.message} Dropped a ${made} node on the graph.`);
            }
        } catch (e) {
            console.warn("[bEpicViewer] previz render failed", e);
            if (view._rendering) view.endRender();
            result.error = true;
            result.message = `Render stopped after ${done} frames: ${(e && e.message) || e}`;
            view._setStatus(result.message, true);
        } finally {
            this._previzRendering = false;
            this._previzRenderStop = false;
            if (view._rendering) view.endRender();
            this.setFrame(wasFrame);
            const win = this._viewerWindow();
            win.setTimeout(() => { if (!this._previzRendering) view._setStatus(""); }, 5000);
        }
        return result;
    },
};
