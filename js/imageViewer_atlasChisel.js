// imageViewer_atlasChisel.js
// "Chisel this view" in the 3D space: with an Atlas world open, World Labs Atlas Chisel paints the view the
// camera looks through - from words alone, or by changing only the part of a picture of that view you paint
// over (white in the mask Atlas gets: "change this"). The picture is the view as the 3D space draws it (one
// click), or one you bring: dropped from Windows Explorer / the desktop / the History, picked, or the
// History's selection (e.g. an earlier Atlas render of this camera). A style picture is optional, and the
// world's nearest views go along so the result stays the same place.
//
// No agent turn: the request goes through ComfyUI (POST /imageviewer/atlas_chisel, which resolves and checks
// every picture) to the agentY host, which runs the core function the agent's atlas_chisel tool runs. The
// arithmetic (buildChiselRequest, chiselCamera) is in imageViewer_atlasRender.js, tested under node.
import { api } from "../../scripts/api.js";
import { notice, openFilePicker } from "./imageViewer_exportUI.js";
import * as A from "./imageViewer_atlasRender.js";
import { canvasFile, uploadPicture, wirePictureDrop } from "./imageViewer_atlasDrops.js";

async function asJson(res) {
    let body = {};
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error(body.error || `the viewer server answered ${res.status}`);
    return body;
}

const postChisel = async (body) => asJson(await api.fetchApi("/imageviewer/atlas_chisel", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
const getChisel = async (id) => asJson(await api.fetchApi(`/imageviewer/atlas_chisel?id=${encodeURIComponent(id)}`));

const MODE_HINT = {
    paint: "No picture: Atlas paints this view from the words, with the world's nearest views as the place. "
         + "Add a picture to change only part of it.",
    restyle: "Atlas repaints the whole picture from the words. Paint over a part of it to change only that part.",
    edit: "Atlas changes only the painted part and keeps the rest of the picture.",
};

export const AtlasChiselMixin = {

    /** The view as the 3D space draws it, at 1280 x 720, and the camera of exactly that picture. */
    _atlasChiselSnapshot(item) {
        const view = this._modelView();
        if (!view) throw new Error("the 3D view is not up");
        const camera = A.chiselCamera(A.captureCamera(view, item));
        if (!view.beginRender({ grid: false, helpers: false })) throw new Error("the 3D view is busy (a render is running)");
        let url = null;
        try { url = view.renderFrame(null, A.CHISEL_W, A.CHISEL_H); } finally { view.endRender(); }
        if (!url) throw new Error("could not read the view back");
        return { url, camera };
    },

    /** Open the dialog (the Previz panel's "Chisel" button, the 3D menu's "Chisel this view…"). */
    atlasChiselDialog() {
        if (this._atlasChiselDlg && this._atlasChiselDlg.isConnected) {
            if (!this._atlasChiselBusy) this._atlasChiselDlg.remove();
            return;
        }
        const item = this.isPrevizTab && this.isPrevizTab() && this.previzAtlasItem ? this.previzAtlasItem() : null;
        const host = this.container;
        if (!host) return;
        if (!item) {
            notice("warn", "Chisel this view", "Open an Atlas world in the 3D space first (3D › New Atlas world…, or a world agentY made).");
            return;
        }
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const worldName = A.atlasWorldName(item.src.path);
        // pic: {path | filename..., name, url, camera?, w, h} - camera only when it is a picture of this view made here.
        let pic = null, style = null, painted = false, erase = false;

        const shade = el("div", "rd-shade atlas-dlg atlas-chisel");
        const box = el("div", "rd-box atlas-chisel-box");
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "Chisel this view");
        const head = el("div", "rd-head");
        const x = el("button", "rd-x", "✕");
        x.title = "Close (Esc)";
        head.append(el("span", "rd-title", `Chisel this view — ${worldName}`), x);

        // The picture of the view, with the mask painted over it.
        const stage = el("div", "atlas-stage");
        const img = el("img", "atlas-stage-img");
        img.alt = "";
        const mask = el("canvas", "atlas-stage-mask");
        const empty = el("div", "atlas-stage-empty");
        empty.append(el("div", "atlas-stage-big", "No picture — Atlas paints this view fresh"),
                     el("div", "", "Drop a picture of this view here (Windows Explorer, the desktop, the History), "
                        + "or take the view as it is shown"));
        stage.append(img, mask, empty);
        const picTools = el("div", "atlas-tools");
        const viewBtn = el("button", "rd-btn", "Use this view");
        viewBtn.title = "The view as the 3D space draws it now (1280 × 720), with its camera";
        const addBtn = el("button", "rd-btn", "Picture…");
        addBtn.title = "Pick a picture of this view from the folders the viewer can open";
        const histBtn = el("button", "rd-btn", "History selection");
        histBtn.title = "The picture selected in the History strip (e.g. an earlier Atlas render of this camera)";
        const noneBtn = el("button", "rd-btn", "No picture");
        noneBtn.title = "Leave the picture out: Atlas paints the view from the words";
        picTools.append(viewBtn, addBtn, histBtn, noneBtn);
        const maskTools = el("div", "atlas-tools atlas-masktools");
        const brushBtn = el("button", "rd-btn active", "Brush");
        brushBtn.title = "Paint where Atlas should change the picture";
        const eraseBtn = el("button", "rd-btn", "Eraser");
        eraseBtn.title = "Take paint away";
        const size = el("input", "atlas-brush");
        size.type = "range"; size.min = "8"; size.max = "240"; size.value = "60";
        size.title = "Brush size (in pixels of the 1280 × 720 picture)";
        const clearBtn = el("button", "rd-btn", "Clear mask");
        maskTools.append(el("span", "rd-sub", "Mask"), brushBtn, eraseBtn, size, el("span", "atlas-gap"), clearBtn);

        const prompt = el("textarea", "rd-in atlas-prompt atlas-chisel-prompt");
        prompt.rows = 3;
        prompt.placeholder = "What Atlas should paint or change — e.g. an old stone fountain where the bench is";
        const styleRow = el("div", "rd-row atlas-style");
        const styleChip = el("div", "atlas-pic atlas-style-chip");
        const styleImg = el("img");
        styleImg.alt = "";
        const styleX = el("button", "atlas-pic-x", "✕");
        styleX.title = "No style picture";
        styleChip.append(styleImg, styleX);
        const styleDrop = el("div", "atlas-dropzone atlas-style-drop", "Drop a style picture here (optional)");
        const styleBtn = el("button", "rd-btn", "Style…");
        styleBtn.title = "A picture whose look to match (no camera or geometry is taken from it)";
        styleRow.append(el("span", "rd-label", "Style"), styleChip, styleDrop, styleBtn);
        const ctx = el("input");
        ctx.type = "checkbox";
        ctx.checked = true;
        const ctxWrap = el("label", "rd-inline");
        ctxWrap.append(ctx, el("span", "rd-sub", "Keep it the same place (the world's nearest views go along)"));
        const enh = el("input");
        enh.type = "checkbox";
        enh.checked = true;
        const enhWrap = el("label", "rd-inline");
        enhWrap.append(enh, el("span", "rd-sub", "Let Atlas expand the prompt"));
        const seed = el("input", "rd-in atlas-seed");
        seed.placeholder = "random";
        seed.inputMode = "numeric";
        seed.title = "A fixed seed paints the same picture again (empty: a new one each time)";
        const optRow = el("div", "rd-row atlas-opts");
        optRow.append(ctxWrap, enhWrap, el("span", "atlas-gap"), el("span", "rd-sub", "Seed"), seed);

        const hint = el("div", "rd-hint", "");
        const message = el("div", "rd-message");
        const progress = el("div", "rd-progress");
        const bar = el("div", "rd-bar");
        progress.append(bar);
        const cancel = el("button", "rd-btn", "Close");
        const go = el("button", "rd-btn rd-go", "Chisel");
        const foot = el("div", "rd-row export-foot");
        foot.append(cancel, go);
        box.append(head, stage, picTools, maskTools, prompt, styleRow, optRow, hint, progress, message, foot);
        shade.append(box);
        host.append(shade);
        this._atlasChiselDlg = shade;

        const mode = () => A.chiselMode({ image: pic, mask: pic && painted });
        const refresh = () => {
            const busy = !!this._atlasChiselBusy;
            stage.classList.toggle("has-pic", !!pic);
            const ratio = pic && pic.w && pic.h ? pic.w / pic.h : 16 / 9;
            stage.style.aspectRatio = String(ratio);
            stage.style.width = `min(100%, calc(48vh * ${ratio.toFixed(4)}))`;
            maskTools.style.display = pic ? "" : "none";
            noneBtn.disabled = !pic || busy;
            brushBtn.classList.toggle("active", !erase);
            eraseBtn.classList.toggle("active", erase);
            styleChip.style.display = style ? "" : "none";
            styleDrop.style.display = style ? "none" : "";
            hint.textContent = MODE_HINT[mode()] + " One billed World Labs task; the picture is 1280 × 720.";
            go.textContent = { paint: "Paint the view", restyle: "Repaint the picture", edit: "Change the painted part" }[mode()];
            go.disabled = busy || !prompt.value.trim();
        };
        prompt.oninput = refresh;

        const setPicture = (p) => {
            pic = p;
            painted = false;
            if (!p) { img.removeAttribute("src"); refresh(); return; }
            img.onload = () => {
                pic.w = img.naturalWidth;
                pic.h = img.naturalHeight;
                // The mask has the picture's own pixels (the host crops both the same way to 1280 x 720).
                mask.width = pic.w;
                mask.height = pic.h;
                refresh();
            };
            img.onerror = () => { message.classList.add("error"); message.textContent = `Could not show ${p.name || "the picture"}.`; };
            img.src = p.url || this.thumbUrl(p._obj || { path: p.path, filename: p.filename, type: p.type, subfolder: p.subfolder });
            refresh();
        };
        const fromItems = (items) => {
            const it = items[0];
            if (!it) return;
            let url = "";
            try { url = this.buildImgUrl ? this.buildImgUrl(it._obj || { path: it.path, filename: it.filename, type: it.type, subfolder: it.subfolder }, { noColor: true }) : ""; }
            catch (_) { url = ""; }
            setPicture({ ...it, url });
            if (items.length > 1) notice("info", "Chisel this view", "Chisel edits one picture: the first one is used.");
        };
        const setStyle = (it) => {
            style = it || null;
            if (style) {
                try { styleImg.src = this.thumbUrl(style._obj || { path: style.path, filename: style.filename, type: style.type, subfolder: style.subfolder }); }
                catch (_) { /* a chip without a picture */ }
                styleChip.title = style.name || style.path || "";
            }
            refresh();
        };
        styleX.onclick = () => setStyle(null);

        viewBtn.onclick = () => {
            try {
                const snap = this._atlasChiselSnapshot(item);
                setPicture({ url: snap.url, camera: snap.camera, name: "this view", snapshot: true });
                message.classList.remove("error");
                message.textContent = "";
            } catch (e) {
                message.classList.add("error");
                message.textContent = (e && e.message) || String(e);
            }
        };
        noneBtn.onclick = () => setPicture(null);
        const fromHistory = () => {
            const picked = this.selectedHistorySnapshots ? this.selectedHistorySnapshots() : [];
            return picked.map((p) => p.imgObj).filter((f) => f && A.isAtlasPicture(f) && A.pictureRef(f))
                .map((f) => ({ ...A.pictureRef(f), name: f.filename || String(f.path || "").split(/[\\/]/).pop(), _obj: f }));
        };
        histBtn.onclick = () => {
            const got = fromHistory();
            if (!got.length) { notice("info", "Chisel this view", "Select a picture in the History strip first."); return; }
            fromItems(got);
        };
        const pick = (id, title, note, take) => openFilePicker(this.container, {
            id, title, kind: "image", exts: [".png", ".jpg", ".jpeg", ".webp"], multiple: false, go: "Use", note,
            onPick: async (files) => { if (files[0]) take([{ path: files[0].path, name: files[0].name }]); return { ok: true }; },
        });
        addBtn.onclick = () => pick("atlas-chisel-picture", "Picture of this view",
            "A picture taken from the camera you look through (an Atlas render of it, a paint-over, a photo).", fromItems);
        styleBtn.onclick = () => pick("atlas-chisel-style", "Style picture", "A picture whose look to match.", (l) => setStyle(l[0]));

        const status = (text, bad) => { message.classList.toggle("error", !!bad); message.textContent = text; };
        const skipped = (n) => notice("warn", "Chisel this view", `${n} file(s) left out: only pictures (png, jpg, webp).`);
        wirePictureDrop(styleRow, { onItems: (l) => setStyle(l[0]), onStatus: status, onSkipped: skipped });
        // Anywhere else on the dialog (the picture above all): the picture to chisel.
        wirePictureDrop(box, { shade, onItems: fromItems, onStatus: status, onSkipped: skipped });

        // The mask brush: drawn in the picture's own pixels, shown as a red wash over it.
        let drawing = false, last = null;
        const at = (e) => {
            const r = mask.getBoundingClientRect();
            return [(e.clientX - r.left) * (mask.width / Math.max(1, r.width)), (e.clientY - r.top) * (mask.height / Math.max(1, r.height))];
        };
        const radius = () => Number(size.value) * (mask.width / A.CHISEL_W) / 2;
        const dab = (p) => {
            const g = mask.getContext("2d");
            g.globalCompositeOperation = erase ? "destination-out" : "source-over";
            g.strokeStyle = g.fillStyle = "rgb(255, 64, 64)";
            g.lineCap = g.lineJoin = "round";
            g.lineWidth = radius() * 2;
            g.beginPath();
            if (last) { g.moveTo(last[0], last[1]); g.lineTo(p[0], p[1]); g.stroke(); }
            else { g.arc(p[0], p[1], radius(), 0, Math.PI * 2); g.fill(); }
            last = p;
        };
        const anyPaint = () => {
            if (!mask.width || !mask.height) return false;
            const d = mask.getContext("2d").getImageData(0, 0, mask.width, mask.height).data;
            for (let i = 3; i < d.length; i += 16) if (d[i] > 8) return true;
            return false;
        };
        mask.addEventListener("pointerdown", (e) => {
            if (!pic || this._atlasChiselBusy || e.button !== 0) return;
            e.preventDefault();
            mask.setPointerCapture(e.pointerId);
            drawing = true;
            last = null;
            dab(at(e));
        });
        mask.addEventListener("pointermove", (e) => { if (drawing) dab(at(e)); });
        const up = () => {
            if (!drawing) return;
            drawing = false;
            last = null;
            painted = anyPaint();
            refresh();
        };
        mask.addEventListener("pointerup", up);
        mask.addEventListener("pointercancel", up);
        brushBtn.onclick = () => { erase = false; refresh(); };
        eraseBtn.onclick = () => { erase = true; refresh(); };
        clearBtn.onclick = () => { mask.getContext("2d").clearRect(0, 0, mask.width, mask.height); painted = false; refresh(); };

        /** The mask as Atlas is told it here: white = change, black = keep, the picture's size. */
        const maskFile = async () => {
            const out = doc.createElement("canvas");
            out.width = mask.width;
            out.height = mask.height;
            const g = out.getContext("2d");
            const white = doc.createElement("canvas");
            white.width = mask.width;
            white.height = mask.height;
            const w = white.getContext("2d");
            w.drawImage(mask, 0, 0);
            w.globalCompositeOperation = "source-in";
            w.fillStyle = "#fff";
            w.fillRect(0, 0, white.width, white.height);
            g.fillStyle = "#000";
            g.fillRect(0, 0, out.width, out.height);
            g.drawImage(white, 0, 0);
            return canvasFile(out, "chisel_mask");
        };

        const win = this._viewerWindow ? this._viewerWindow() : window;
        const onKey = (e) => {
            if (e.key === "Escape") { e.stopPropagation(); close(); }
            else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); go.click(); }
        };
        const close = () => {
            if (this._atlasChiselBusy) return;
            shade.remove();
            win.removeEventListener("keydown", onKey, true);
        };
        win.addEventListener("keydown", onKey, true);
        x.onclick = close;
        cancel.onclick = close;
        refresh();
        setTimeout(() => { try { prompt.focus(); } catch (_) { /* gone */ } }, 0);

        go.onclick = async () => {
            if (this._atlasChiselBusy) return;
            let camera;
            try {
                // A picture made here carries its own camera; anything else is taken to be from the camera NOW.
                camera = pic && pic.camera ? pic.camera : A.captureCamera(this._modelView(), item);
            } catch (e) { status((e && e.message) || String(e), true); return; }
            this._atlasChiselBusy = true;
            for (const n of [go, prompt, viewBtn, addBtn, histBtn, noneBtn, styleBtn, ctx, enh, seed]) n.disabled = true;
            box.classList.add("rendering");
            status("Getting the pictures ready…", false);
            bar.style.width = "8%";
            const fail = (e) => {
                status(A.explainError(e), true);
                box.classList.remove("rendering");
                for (const n of [prompt, viewBtn, addBtn, histBtn, styleBtn, ctx, enh, seed]) n.disabled = false;
                this._atlasChiselBusy = false;
                refresh();
            };
            try {
                let image = pic;
                if (pic && pic.snapshot && !pic.path) {
                    image = { ...pic, ...(await uploadPicture(await canvasFile(pic.url, "chisel_view"))) };
                    pic.path = image.path;            // the same view again needs no second upload
                }
                const maskItem = image && painted ? await uploadPicture(await maskFile()) : null;
                const body = A.buildChiselRequest({ item, camera, prompt: prompt.value, image, mask: maskItem, style,
                                                    context: ctx.checked, seed: seed.value, enhance: enh.checked });
                if (body.error) throw new Error(body.error);
                status("Sending it to agentY…", false);
                bar.style.width = "20%";
                const state = await A.runAtlasRender({
                    post: postChisel, get: getChisel, request: body, pollMs: 2500, timeoutMs: 20 * 60 * 1000,
                    onState: (s) => { status(A.chiselProgress(s), false); bar.style.width = "55%"; },
                });
                bar.style.width = "100%";
                const where = this.previzAtlasShow ? await this.previzAtlasShow(state, worldName, "Atlas chisel") : "";
                this._atlasChiselBusy = false;
                notice(state.message ? "warn" : "success", "Atlas chisel ready", state.message || where || state.path || "");
                close();
            } catch (e) {
                fail(e);
            }
        };
    },
};
