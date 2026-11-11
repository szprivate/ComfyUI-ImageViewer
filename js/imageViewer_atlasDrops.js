// imageViewer_atlasDrops.js
// Pictures dropped onto the Atlas dialogs (New Atlas world, Chisel this view): files from the desktop -
// Windows Explorer, Finder - and History thumbnails or file-browser rows (the viewer's own drag payload).
// A desktop file has no path the server can read, so its bytes are copied in through
// /imageviewer/timeline_upload (kept in <input>/edits, media only, never written over), and the dialog
// gets back a {path} it can send like any other picture.
import { api } from "../../scripts/api.js";
import * as A from "./imageViewer_atlasRender.js";

export const HISTORY_TYPE = "application/x-imageviewer-history";

/** Copy one File (a desktop drop, a painted mask, a snapshot) into ComfyUI's input; resolves to {path, name}. */
export async function uploadPicture(file, name) {
    const fd = new FormData();
    fd.append("file", file, name || file.name);
    const res = await api.fetchApi("/imageviewer/timeline_upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error(await res.text().catch(() => "") || `the upload answered ${res.status}`);
    const body = await res.json();
    return { path: body.path, name: body.name || name || file.name };
}

/** A canvas (or a data URL) as a PNG File, with a name that is new each time (an upload of the same name and
 *  size is taken for the same file, and two masks can be). */
export async function canvasFile(source, stem) {
    const blob = typeof source === "string"
        ? await (await fetch(source)).blob()
        : await new Promise((ok, no) => source.toBlob((b) => (b ? ok(b) : no(new Error("could not save the picture"))), "image/png"));
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    return new File([blob], `${stem}_${stamp}_${Math.random().toString(36).slice(2, 6)}.png`, { type: "image/png" });
}

/** The History / file-browser items of a drag, as picture items the routes take. */
export function historyPictures(dt) {
    const raw = dt && dt.getData && dt.getData(HISTORY_TYPE);
    if (!raw) return null;
    try {
        const list = JSON.parse(raw);
        const items = (Array.isArray(list) ? list : (list.items || [list])).flatMap((s) => (Array.isArray(s) ? s.slice(0, 1) : [s]));
        return items.map((f) => ({ ...A.pictureRef(f), name: f.filename || String(f.path || "").split(/[\\/]/).pop(), _obj: f }))
            .filter((f) => f.path || f.filename);
    } catch (_) {
        return [];
    }
}

const isFileDrag = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).some((t) => t === "Files" || t === HISTORY_TYPE));

/**
 * Make an Atlas dialog float: the viewer under it stays usable (the History strip above all, so a thumbnail
 * can be dragged into it), and its header moves it out of the way. `shade` is the dialog's full-size layer,
 * which then takes no pointer events itself; only `box` does.
 */
export function floatDialog(shade, box, head) {
    shade.classList.add("rd-float");
    head.classList.add("rd-grab");
    head.title = "Drag to move";
    head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button, input, select, textarea")) return;
        e.preventDefault();
        const sr = shade.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        const dx = e.clientX - br.left, dy = e.clientY - br.top;
        box.classList.add("rd-moved");
        const place = (x, y) => {
            const left = Math.max(0, Math.min(x - sr.left - dx, sr.width - 60));
            const top = Math.max(0, Math.min(y - sr.top - dy, sr.height - 30));
            box.style.left = `${left}px`;
            box.style.top = `${top}px`;
        };
        place(e.clientX, e.clientY);
        try { head.setPointerCapture(e.pointerId); } catch (_) { /* gone */ }
        const move = (ev) => place(ev.clientX, ev.clientY);
        const up = () => {
            head.removeEventListener("pointermove", move);
            head.removeEventListener("pointerup", up);
            head.removeEventListener("pointercancel", up);
        };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up);
        head.addEventListener("pointercancel", up);
    });
}

/**
 * Make `target` take dropped pictures. `onItems(items, event)` gets picture items ({path} after an upload,
 * or History refs); `onStatus(text, isError)` is told while desktop files are copied in. `shade` (the dialog's
 * backdrop), when it takes pointer events, swallows drops that miss the target, so a file let go beside the box
 * is not opened by the browser; a floating dialog's (floatDialog) lets them through to the viewer.
 * Returns the number of pictures it left out (not png / jpg / webp) through `onSkipped(n)`.
 */
export function wirePictureDrop(target, { onItems, onStatus, onSkipped, shade, hot = "drop-on" } = {}) {
    let depth = 0;
    const lit = (on) => target.classList.toggle(hot, on);
    target.addEventListener("dragenter", (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        depth += 1;
        lit(true);
    });
    target.addEventListener("dragover", (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        try { e.dataTransfer.dropEffect = "copy"; } catch (_) { /* read-only */ }
        lit(true);
    });
    target.addEventListener("dragleave", () => {
        depth = Math.max(0, depth - 1);
        if (!depth) lit(false);
    });
    target.addEventListener("drop", async (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth = 0;
        lit(false);
        const dt = e.dataTransfer;
        const hist = historyPictures(dt);
        if (hist) {
            const ok = hist.filter((f) => A.isAtlasPicture(f));
            if (hist.length > ok.length && onSkipped) onSkipped(hist.length - ok.length);
            if (ok.length) onItems(ok, e);
            return;
        }
        const files = Array.from((dt && dt.files) || []);
        if (!files.length) return;
        const pics = files.filter((f) => A.isAtlasPicture({ name: f.name }));
        if (files.length > pics.length && onSkipped) onSkipped(files.length - pics.length);
        if (!pics.length) return;
        if (onStatus) onStatus(pics.length === 1 ? `Copying ${pics[0].name} in…` : `Copying ${pics.length} pictures in…`, false);
        try {
            const kept = [];
            for (const f of pics) kept.push(await uploadPicture(f));
            if (onStatus) onStatus("", false);
            onItems(kept, e);
        } catch (err) {
            if (onStatus) onStatus((err && err.message) || String(err), true);
        }
    });
    if (shade && shade !== target) {
        shade.addEventListener("dragover", (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "none"; } });
        shade.addEventListener("drop", (e) => { if (isFileDrag(e)) { e.preventDefault(); e.stopPropagation(); } });
    }
}
