// imageViewer_atlasCreate.js
// "New Atlas world" in the 3D space: make a World Labs Atlas world without asking the agent, the way the
// Atlas app starts one - describe the place, or bring pictures of it, and press Create. The request goes
// through ComfyUI (POST /imageviewer/atlas_create) to the agentY host, which has agenty_core and the key and
// runs the same function as the agent's atlas_create_world; when the world is made the host opens it in the
// 3D space, where the Previz panel's Atlas button paints new views of it.
//
// Pictures come from the History selection, the file picker, or are dropped from Windows Explorer / the
// desktop / the History anywhere on the dialog (imageViewer_atlasDrops.js: desktop files are kept in
// <input>/edits by /imageviewer/timeline_upload, like the Edit panel's drops). The arithmetic is in
// imageViewer_atlasRender.js (buildCreateRequest, worldNameFrom), tested under node.
//
// The same dialog makes a world with the second generator, SpAItial Echo (Engine: Echo; the Atlas menu's
// "New Echo world…"): one picture, a 360 panorama or words -> a Gaussian-splat world, made by the host's
// agentY-core echo_create_world and opened in the 3D space. The engine last used is kept per viewer
// (localStorage imageviewer.viewer.worldEngine).
import { api } from "../../scripts/api.js";
import { notice, openFilePicker } from "./imageViewer_exportUI.js";
import * as A from "./imageViewer_atlasRender.js";
import { floatDialog, wirePictureDrop } from "./imageViewer_atlasDrops.js";

async function asJson(res) {
    let body = {};
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error(body.error || `the viewer server answered ${res.status}`);
    return body;
}

const postCreate = async (body) => asJson(await api.fetchApi("/imageviewer/atlas_create", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
const getCreate = async (id) => asJson(await api.fetchApi(`/imageviewer/atlas_create?id=${encodeURIComponent(id)}`));

const ENGINE_KEY = "imageviewer.viewer.worldEngine";
function savedEngine() {
    try { return localStorage.getItem(ENGINE_KEY) === "echo" ? "echo" : "atlas"; } catch (_) { return "atlas"; }
}
function saveEngine(v) {
    try { localStorage.setItem(ENGINE_KEY, v); } catch (_) { /* private window */ }
}

export const AtlasCreateMixin = {

    /** The History's selected pictures, as items the route takes. */
    _atlasCreateFromHistory() {
        const picked = this.selectedHistorySnapshots ? this.selectedHistorySnapshots() : [];
        return picked.map((p) => p.imgObj).filter((f) => f && A.isAtlasPicture(f) && A.pictureRef(f))
            .map((f) => ({ ...A.pictureRef(f), name: f.filename || String(f.path || "").split(/[\\/]/).pop(), _obj: f }));
    },

    /** Open the dialog. `opts.images` starts it with pictures; `opts.engine` ("atlas" | "echo") picks the
     *  generator (else the one used last). */
    atlasCreateDialog(opts = {}) {
        if (this._atlasCreateDlg && this._atlasCreateDlg.isConnected) {
            if (!this._atlasCreateBusy) this._atlasCreateDlg.remove();
            return;
        }
        const host = this.container;
        if (!host) return;
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        let engine = opts.engine === "echo" || opts.engine === "atlas" ? opts.engine : savedEngine();
        const images = [];
        for (const it of (opts.images || this._atlasCreateFromHistory())) {
            if (images.length < A.CREATE_MAX_IMAGES) images.push(it);
        }

        const shade = el("div", "rd-shade atlas-dlg atlas-create");
        const box = el("div", "rd-box atlas-create-box");
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "New world");
        const head = el("div", "rd-head");
        const x = el("button", "rd-x", "✕");
        x.title = "Close (Esc)";
        const titleEl = el("span", "rd-title", "New Atlas world");
        head.append(titleEl, x);

        // Which generator makes the world.
        const engineSel = el("select", "rd-in atlas-engine");
        engineSel.title = "Which world generator: World Labs Atlas, or SpAItial Echo (the second one)";
        for (const [v, label] of A.ENGINES) engineSel.append(Object.assign(el("option"), { value: v, textContent: label }));
        engineSel.value = engine;
        const engineRow = el("div", "rd-row atlas-engine-row");
        engineRow.append(el("span", "rd-label", "Engine"), engineSel);

        // The composer: the words, the pictures under them, the controls in one row - as the Atlas app has it.
        const composer = el("div", "atlas-composer");
        const prompt = el("textarea", "rd-in atlas-prompt");
        prompt.rows = 4;
        prompt.placeholder = "Describe a place — e.g. a sunlit stone courtyard with climbing ivy and a well";
        prompt.value = String(opts.prompt || "");
        const strip = el("div", "atlas-pics");
        const dropZone = el("div", "atlas-dropzone", "Drop pictures here — from Windows Explorer, the desktop or the History");
        const tools = el("div", "atlas-tools");
        const addBtn = el("button", "rd-btn", "+ Pictures…");
        addBtn.title = "Pick pictures from the folders the viewer can open";
        const histBtn = el("button", "rd-btn", "Use History selection");
        histBtn.title = "The pictures selected in the History strip (Ctrl+click to select several)";
        const aspect = el("select", "rd-in atlas-aspect");
        aspect.title = "Aspect ratio of the first picture Atlas paints (a prompt-only world)";
        for (const a of A.CREATE_ASPECTS) aspect.append(Object.assign(el("option"), { value: a, textContent: a }));
        const detail = el("select", "rd-in");
        detail.title = "How fine the world's mesh is";
        for (const [v, label] of A.CREATE_DETAILS) detail.append(Object.assign(el("option"), { value: String(v), textContent: label }));
        detail.value = "4";
        // Echo's own choices, shown instead of the aspect and the mesh detail.
        const choice = (cls, title, list, value) => {
            const n = el("select", `rd-in ${cls}`);
            n.title = title;
            for (const [v, label] of list) n.append(Object.assign(el("option"), { value: v, textContent: label }));
            n.value = value;
            return n;
        };
        const echoModel = choice("echo-model", "Echo's quality (SpAItial credits, 1 credit = US$ 0.01)", A.ECHO_MODELS, "echo-2");
        const echoPano = choice("echo-pano", "Whether the picture is a 360 equirectangular panorama", A.ECHO_PANO, "auto");
        const echoMesh = choice("echo-mesh", "Also ask SpAItial for a mesh (.ply) of the world", A.ECHO_MESH, "");
        tools.append(addBtn, histBtn, el("span", "atlas-gap"), aspect, detail, echoModel, echoPano, echoMesh);
        composer.append(prompt, strip, dropZone, tools);

        const nameIn = el("input", "rd-in atlas-name");
        nameIn.placeholder = "world name";
        let nameTouched = false;
        nameIn.oninput = () => { nameTouched = true; };
        const nameRow = el("div", "rd-row");
        nameRow.append(el("span", "rd-label", "Name"), nameIn);
        const hint = el("div", "rd-hint", "");
        const message = el("div", "rd-message");
        const progress = el("div", "rd-progress");
        const bar = el("div", "rd-bar");
        progress.append(bar);
        const cancel = el("button", "rd-btn", "Close");
        const go = el("button", "rd-btn rd-go", "Create world");
        const foot = el("div", "rd-row export-foot");
        foot.append(cancel, go);
        box.append(head, engineRow, composer, nameRow, hint, progress, message, foot);
        shade.append(box);
        // Not modal: the History and the rest of the viewer stay usable while it is open.
        floatDialog(shade, box, head);
        host.append(shade);
        this._atlasCreateDlg = shade;

        const refresh = () => {
            const echo = engine === "echo";
            const max = A.maxImagesFor(engine);
            titleEl.textContent = echo ? "New Echo world" : "New Atlas world";
            box.classList.toggle("engine-echo", echo);
            for (const n of [aspect, detail]) n.style.display = echo ? "none" : "";
            for (const n of [echoModel, echoPano, echoMesh]) n.style.display = echo ? "" : "none";
            echoPano.disabled = !images.length;
            prompt.disabled = !!this._atlasCreateBusy || (echo && images.length > 0);
            prompt.placeholder = echo && images.length ? "Echo builds the world from the picture alone (it takes words OR a picture)"
                : "Describe a place — e.g. a sunlit stone courtyard with climbing ivy and a well";
            strip.textContent = "";
            images.forEach((it, i) => {
                const chip = el("div", "atlas-pic");
                const img = el("img");
                img.alt = it.name || "";
                try { img.src = this.thumbUrl(it._obj || { path: it.path, filename: it.filename, type: it.type, subfolder: it.subfolder }); }
                catch (_) { /* a tile without a picture is still a chip */ }
                const rm = el("button", "atlas-pic-x", "✕");
                rm.title = "Leave this picture out";
                rm.onclick = () => { images.splice(i, 1); refresh(); };
                chip.title = it.name || it.path || it.filename || "";
                chip.append(img, rm);
                strip.append(chip);
            });
            strip.style.display = images.length ? "" : "none";
            dropZone.style.display = images.length >= max ? "none" : "";
            dropZone.textContent = images.length ? `Drop more pictures here (up to ${max})`
                : echo ? "Drop ONE picture or a 360 panorama here — from Windows Explorer, the desktop or the History"
                    : "Drop pictures here — from Windows Explorer, the desktop or the History";
            aspect.disabled = images.length > 0;
            addBtn.disabled = histBtn.disabled = images.length >= max || this._atlasCreateBusy;
            if (!nameTouched) nameIn.value = A.worldNameFrom(prompt.value, images);
            const tooMany = images.length > max;
            hint.classList.toggle("warn", tooMany);
            hint.textContent = tooMany
                ? `Echo takes ONE picture: leave ${images.length - max === 1 ? "one" : `${images.length - max}`} out (✕), or switch to Atlas.`
                : echo
                ? (images.length
                    ? "SpAItial Echo builds a whole Gaussian-splat world from the picture (a 360 panorama works too); words "
                      + "are not used beside a picture. One billed SpAItial world; it opens in the 3D space when done."
                    : "SpAItial Echo builds a whole Gaussian-splat world from the words. One billed SpAItial world; it "
                      + "opens in the 3D space when done.")
                : images.length
                ? `Atlas places ${images.length === 1 ? "the picture" : `the ${images.length} pictures`} in 3D (a camera and a `
                  + "depth map each; overlapping photos of one place are reconstructed together). The prompt, if any, "
                  + "is kept for later views. One billed World Labs task."
                : "Atlas paints the place from the words, with its depth, and the world is built on it. One billed World "
                  + "Labs task; add pictures instead to start from your own.";
            go.disabled = !!this._atlasCreateBusy || tooMany || (!images.length && !prompt.value.trim());
        };
        prompt.oninput = refresh;
        engineSel.onchange = () => { engine = engineSel.value === "echo" ? "echo" : "atlas"; saveEngine(engine); refresh(); };
        refresh();

        const addItems = (items) => {
            let skipped = 0;
            const max = A.maxImagesFor(engine);
            for (const it of items) {
                if (!A.isAtlasPicture(it)) { skipped += 1; continue; }
                const key = it.path || `${it.type}/${it.subfolder}/${it.filename}`;
                if (images.some((o) => (o.path || `${o.type}/${o.subfolder}/${o.filename}`) === key)) continue;
                if (images.length >= max) { skipped += 1; continue; }
                images.push(it);
            }
            refresh();
            if (skipped) notice("warn", titleEl.textContent, `${skipped} file(s) left out: `
                + (engine === "echo" ? "Echo takes ONE picture" : `Atlas takes up to ${A.CREATE_MAX_IMAGES} pictures`)
                + " (png, jpg, webp).");
        };
        histBtn.onclick = () => {
            const got = this._atlasCreateFromHistory();
            if (!got.length) { notice("info", "New Atlas world", "Select pictures in the History strip first (Ctrl+click for several)."); return; }
            addItems(got);
        };
        addBtn.onclick = () => openFilePicker(this.container, {
            id: "atlas-pictures", title: "Pictures for the world", kind: "image", exts: [".png", ".jpg", ".jpeg", ".webp"],
            multiple: true, go: "Add", note: "Pictures of the place (up to 8). Overlapping photos of one place are reconstructed together.",
            onPick: async (files) => {
                addItems(files.map((f) => ({ path: f.path, name: f.name })));
                return { ok: true };
            },
        });
        // Files from Windows Explorer / the desktop and History thumbnails, dropped anywhere on the dialog.
        wirePictureDrop(box, {
            shade,
            onItems: (items) => addItems(items),
            onSkipped: (n) => notice("warn", "New Atlas world", `${n} file(s) left out: only pictures (png, jpg, webp).`),
            onStatus: (text, bad) => { message.classList.toggle("error", !!bad); message.textContent = text; },
        });

        const win = this._viewerWindow ? this._viewerWindow() : window;
        const onKey = (e) => {
            if (e.key === "Escape") { e.stopPropagation(); close(); }
            else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); go.click(); }
        };
        const close = () => {
            if (this._atlasCreateBusy) return;
            shade.remove();
            win.removeEventListener("keydown", onKey, true);
        };
        win.addEventListener("keydown", onKey, true);
        x.onclick = close;
        cancel.onclick = close;
        setTimeout(() => { try { prompt.focus(); } catch (_) { /* gone */ } }, 0);

        go.onclick = async () => {
            if (this._atlasCreateBusy) return;
            const echo = engine === "echo";
            const body = A.buildCreateRequest({ name: nameIn.value, prompt: prompt.value, images,
                                                aspect: aspect.value, detail: detail.value, engine,
                                                model: echoModel.value, pano: echoPano.value, mesh: echoMesh.value });
            if (body.error) { message.classList.add("error"); message.textContent = body.error; return; }
            this._atlasCreateBusy = true;
            for (const n of [go, prompt, nameIn, aspect, detail, addBtn, histBtn, engineSel, echoModel, echoPano, echoMesh]) n.disabled = true;
            box.classList.add("rendering");
            message.classList.remove("error");
            message.textContent = "Sending it to agentY…";
            bar.style.width = "15%";
            try {
                const state = await A.runAtlasRender({
                    post: postCreate, get: getCreate, request: body, pollMs: echo ? 5000 : 2500,
                    timeoutMs: (echo && body.model === "echo-hq" ? 150 : 30) * 60 * 1000,
                    onState: (s) => {
                        message.textContent = A.createProgress(s);
                        bar.style.width = s.phase && /Opening/.test(s.phase) ? "90%" : "50%";
                    },
                });
                bar.style.width = "100%";
                this._atlasCreateBusy = false;
                if (state.message) notice("warn", echo ? "Echo world made" : "Atlas world made", state.message);
                else if (echo) notice("success", "Echo world ready", `"${state.name}" is open in the 3D space as a splat: `
                    + "fly it (Alt + mouse, W S E Q)." + (state.mesh ? " The mesh is beside it in the world's folder." : ""));
                else notice("success", "Atlas world ready", `"${state.name}" is open in the 3D space: fly it (Alt + mouse, `
                    + "W S E Q) and press Atlas in the Previz panel for a new view.");
                close();
            } catch (e) {
                message.classList.add("error");
                message.textContent = echo
                    ? (e && e.kind === "timeout" ? "Still being made at SpAItial; ask agentY to collect it later "
                        + `(echo_export "${body.name}").` : A.explainEchoError(e))
                    : A.explainError(e);
                box.classList.remove("rendering");
                for (const n of [prompt, nameIn, detail, engineSel, echoModel, echoPano, echoMesh]) n.disabled = false;
                this._atlasCreateBusy = false;
                refresh();
            }
        };
    },
};
