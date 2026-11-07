// imageViewer_editResolve.js
// Export to Resolve…, in the Edit panel's Save menu: a folder with whole copies of
// the original clips and a timeline DaVinci Resolve opens (resolve_export.py does
// the work, in a thread of its own on the server; this asks, shows and polls).
// A mixin onto the panel. The dialog lies in the panel's body, so it pops out with it.
import { api } from "../../scripts/api.js";
import { canvasContext, openFilePicker, notice } from "./imageViewer_exportUI.js";
import * as D from "./imageViewer_editTimelineData.js";

const POLL_MS = 250;

export function sizeText(bytes) {
    if (bytes == null) return "unknown";
    let v = Number(bytes);
    for (const unit of ["B", "KB", "MB", "GB"]) {
        if (v < 1024) return (unit === "B" || unit === "KB" ? v.toFixed(0) : v.toFixed(1)) + " " + unit;
        v /= 1024;
    }
    return v.toFixed(1) + " TB";
}

export const EditResolveMixin = {
    async _editResolvePost(route, body) {
        let res = null, said = "";
        try {
            res = await api.fetchApi("/imageviewer/" + route, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            if (res.ok) return { data: await res.json(), status: res.status };
            said = (res.status === 404 || res.status === 405) && route.endsWith("plan")
                ? "this ComfyUI does not know Export to Resolve yet: restart it" : await res.text();
        } catch (e) { said = String((e && e.message) || e); }
        return { data: null, said: said || "no answer from the server", status: res ? res.status : 0 };
    },

    /** Export to Resolve…: what is exported is the SAVED cut, so unsaved changes are saved first. */
    async editTlResolveDialog() {
        const ui = this._editTlUi;
        if (!ui || !this._editTlCut || !this._editTlCut.clips.length) return;
        if (this._editTlDirty()) {
            await this._editTlSave();
            if (this._editTlDirty()) return;             // the save said why
        }
        if (!this._editTlTarget) return;
        if (ui.dialog && ui.dialog.isConnected) ui.dialog.remove();
        const doc = ui.body.ownerDocument, win = doc.defaultView || window;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const source = this._editTlTarget;
        const box = el("div", "edit-dialog edit-saveas edit-resolve");
        const head = el("div", "edit-dialog-head");
        const close = el("button", "edit-btn edit-resolve-close", "✕");
        close.title = "Close (Esc)";
        head.append(el("span", "edit-dialog-title", "Export to Resolve…"), close);
        const name = el("input", "edit-saveas-name edit-resolve-name");
        name.spellcheck = false;
        const folder = el("input", "edit-saveas-folder edit-resolve-folder");
        folder.spellcheck = false;
        const browse = el("button", "edit-btn edit-resolve-browse", "Browse…");
        const row = (label, ...parts) => { const r = el("label", "edit-saveas-row"); r.append(el("span", "", label), ...parts); return r; };
        const range = this._editTlRange ? this._editTlRange() : null;
        const only = el("input", "edit-resolve-range");
        only.type = "checkbox";
        const onlyRow = el("label", "edit-resolve-check");
        onlyRow.append(only, el("span", "", "Include in–out only"));
        if (!range) onlyRow.style.display = "none";
        // Sound effects cannot go into FCPXML: baked into WAVs that take the clips' place, the dry originals on muted tracks.
        const bake = el("input", "edit-resolve-bake");
        bake.type = "checkbox";
        bake.checked = true;
        const bakeRow = el("label", "edit-resolve-check");
        bakeRow.title = "Each track (and V1) with sound effects plays from a WAV rendered with them; its original clips lie on a muted track named '<track> (dry)' to redo the effects in Fairlight";
        bakeRow.append(bake, el("span", "", "Bake audio effects"));
        bakeRow.style.display = this._editTlCut && D.cutHasAfx(this._editTlCut) ? "" : "none";
        const room = el("div", "edit-resolve-room", "Reading the clips…");
        const list = el("div", "edit-resolve-list");
        const lose = el("input", "edit-resolve-lose");
        lose.type = "checkbox";
        const loseRow = el("label", "edit-resolve-check");
        loseRow.append(lose, el("span", "edit-resolve-lose-text", "Export without the missing files"));
        loseRow.style.display = "none";
        const go = el("button", "edit-btn primary edit-resolve-go", "Export");
        go.disabled = true;
        const bar = el("div", "edit-resolve-bar");
        const fill = el("div", "edit-resolve-fill");
        bar.append(fill);
        bar.style.display = "none";
        const stop = el("button", "edit-btn edit-resolve-cancel", "Cancel");
        stop.style.display = "none";
        const note = el("div", "edit-none edit-saveas-note edit-resolve-note",
            "Whole copies of the original clips, and a timeline for File > Import > Timeline. The originals are only read.");
        const result = el("div", "edit-resolve-result");
        result.style.display = "none";

        let job = null, plan = null, asked = 0, shut = false;
        const shutDown = () => { shut = true; box.remove(); if (ui.dialog === box) ui.dialog = null; };
        const body = () => ({ source, name: name.value, folder: folder.value, bake_fx: bakeRow.style.display !== "none" && bake.checked,
                              ...(range && only.checked ? { frames: [range.start, range.end] } : {}) });
        const fail = (text) => { note.textContent = text; note.classList.add("error"); };

        const showPlan = (p) => {
            plan = p;
            const short = p.free != null && p.free < p.size;
            room.textContent = `${p.files.length} file${p.files.length === 1 ? "" : "s"} to copy: ${sizeText(p.size)}. Free there: ${sizeText(p.free)}.`;
            room.classList.toggle("error", short);
            list.replaceChildren();
            const add = (text, cls) => list.append(el("div", cls || "", text));
            for (const f of p.flagged) add(`${f.name}: ${f.note}`, "edit-resolve-flag");
            for (const f of p.missing) add(`Missing: ${f}`, "edit-resolve-missing");
            for (const f of p.refused) add(`The viewer may not copy: ${f}`, "edit-resolve-missing");
            loseRow.style.display = p.missing.length ? "" : "none";
            note.classList.remove("error");
            if (p.exists) fail(`${p.path} is there already: choose another name.`);
            else if (short) fail("There is not enough free space there.");
            else if (p.refused.length) fail("Some files are outside the folders the viewer may use.");
            else note.textContent = `Goes to ${p.path}`;
            const blocked = p.exists || short || p.refused.length > 0 || !p.files.length;
            go.disabled = blocked || (p.missing.length > 0 && !lose.checked);
        };
        const ask = async () => {
            const mine = ++asked;
            go.disabled = true;
            const got = await this._editResolvePost("timeline_export_resolve_plan", body());
            if (mine !== asked || shut) return;
            if (!got.data) { room.textContent = ""; fail(got.said); return; }
            if (!name.value) name.value = got.data.name;
            if (!folder.value) folder.value = got.data.folder;
            showPlan(got.data);
        };
        const showResult = (r) => {
            for (const n of [name.closest("label"), folder.closest("label"), onlyRow, bakeRow, loseRow, room, list, go, stop, bar, note]) n.style.display = "none";
            const line = el("div", "edit-resolve-path", r.path);
            line.title = r.path;
            const copy = el("button", "edit-btn edit-resolve-copy", "Copy path");
            copy.addEventListener("click", async () => { copy.textContent = (await this._editTlCopy(r.path)) ? "Copied" : "Could not copy"; });
            const show = el("button", "edit-btn edit-resolve-show", "Show in file browser");
            show.addEventListener("click", () => {
                if (this.setPanelDocked && !this.isPanelDocked("browser")) this.setPanelDocked("browser", true);
                if (this.browseTo) this.browseTo(r.path, { force: true });
            });
            const buttons = el("div", "edit-dialog-row");
            buttons.append(copy, show);
            result.replaceChildren(el("div", "edit-dialog-sub", `${r.files} file${r.files === 1 ? "" : "s"}, ${sizeText(r.size)}`), line, buttons);
            if (r.left_out.length) {
                result.append(el("div", "edit-dialog-sub", "Left out:"));
                for (const t of r.left_out) result.append(el("div", "edit-resolve-left", t));
            }
            if (r.flagged.length) {
                result.append(el("div", "edit-dialog-sub", "The free version may not read:"));
                for (const f of r.flagged) result.append(el("div", "edit-resolve-flag", `${f.name}: ${f.note}`));
            }
            result.append(el("div", "edit-none", "Not tried inside Resolve from here: README.txt says how to import it."));
            result.style.display = "";
            this._editTlSavedShow({ path: r.path });
            ui.savedBar.querySelector(".edit-saved-text").textContent = "Exported to " + r.path;
        };
        const poll = async () => {
            if (!job) return;
            const got = await this._editResolvePost("timeline_export_resolve_status", { id: job });
            if (!got.data) { finish(); fail(got.said); return; }
            const s = got.data;
            fill.style.width = (s.total ? Math.min(100, 100 * s.done / s.total) : 100) + "%";
            if (s.status === "running") {
                note.textContent = `${sizeText(s.done)} of ${sizeText(s.total)}${s.current ? ": " + s.current : ""}`;
                win.setTimeout(poll, POLL_MS);
                return;
            }
            finish();
            if (s.status === "done") { showResult(s.result); return; }
            if (s.status === "cancelled") { note.textContent = "Cancelled: nothing was left behind."; note.classList.remove("error"); ask(); return; }
            fail("Not exported: " + s.error + " Nothing was left behind.");
        };
        const finish = () => {
            job = null;
            this._editTlBusy = false;
            bar.style.display = "none";
            stop.style.display = "none";
            go.style.display = "";
            close.disabled = false;
            for (const n of [name, folder, browse, only, lose]) n.disabled = false;
        };
        const send = async () => {
            if (go.disabled || job) return;
            for (const n of [name, folder, browse, only, lose]) n.disabled = true;
            go.style.display = "none";
            close.disabled = true;
            note.classList.remove("error");
            note.textContent = "Starting…";
            this._editTlBusy = true;
            const got = await this._editResolvePost("timeline_export_resolve", { ...body(), context: canvasContext(), continue_missing: lose.checked });
            if (!got.data) { finish(); fail("Not exported: " + got.said); return; }
            job = got.data.id;
            fill.style.width = "0%";
            bar.style.display = "";
            stop.style.display = "";
            poll();
        };
        close.addEventListener("click", () => { if (!job) shutDown(); });
        go.addEventListener("click", send);
        stop.addEventListener("click", (e) => {
            e.preventDefault();
            if (!job) return;
            stop.disabled = true;
            this._editResolvePost("timeline_export_resolve_cancel", { id: job }).finally(() => { stop.disabled = false; });
        });
        name.addEventListener("change", ask);
        folder.addEventListener("change", ask);
        only.addEventListener("change", ask);
        bake.addEventListener("change", ask);
        lose.addEventListener("change", () => { if (plan) showPlan(plan); });
        browse.addEventListener("click", (e) => {
            e.preventDefault();
            this._editTlPicker({ id: "resolve_folder", title: "Export to Resolve into", kind: "edit", start: folder.value, folder: true, exts: [".otio"], go: "This folder",
                onPick: async ([f]) => { folder.value = f.path; ask(); return { ok: true }; } });
        });
        box.addEventListener("pointerdown", (e) => e.stopPropagation());
        box.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); if (!job) shutDown(); }
            else if (e.key === "Enter" && !["BUTTON"].includes(e.target.tagName) && e.target.type !== "checkbox") { e.preventDefault(); e.target.blur(); }
        });
        box.append(head, row("Name", name), row("Folder", folder, browse), onlyRow, bakeRow, room, list, loseRow, go, stop, bar, note, result);
        // Over the whole viewer, not inside the Edit panel: docked low the panel is
        // too short to hold it, and its strip would lie over the title.
        ui.savedBar.style.display = "none";
        this.container.append(box);
        this._editTlCentre(box);
        ui.dialog = box;
        name.focus();
        await ask();
        if (!shut && name.isConnected) { name.focus(); name.select(); }
    },
};

export { notice };
