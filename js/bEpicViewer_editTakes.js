// bEpicViewer_editTakes.js
// Several clips selected, takes, and "Recreate with changes…" - the Edit panel's
// half of asking agentY to make some shots again. A mixin onto the panel
// (bEpicViewer_editTimeline.js); the arithmetic is in bEpicViewer_editTimelineData.js
// (plain functions, run under node).
//
// SEVERAL CLIPS: Ctrl+click on a clip's body puts it in the selection or takes it
// out, on any track - the music bed, a text, a gap too; Shift+click adds the clips
// between the last one clicked and this one (on another track: just this one); a
// marquee adds what it touches. A plain click is a single selection, but a plain
// press on one of several in Selection mode keeps them, to drag together. The single selection
// (`_editTlSel`, what the Inspector, the trims and the keys read) is always the
// last clip clicked; `_editTlMulti` is the list it is one of. The list is held to
// the cut it was made on (D.selSignature): an edit that adds, takes out or
// reorders clips lets it go, and so does any change of `_editTlSel` to something
// that is not in it - it never points at a clip other than the one picked.
// Selected clips are outlined (.msel) and listed in viewerState().edit.selected.
//
// RECREATE: right-click a clip -> "Recreate with changes…" asks what to change in
// the selected shots, saves the cut if it has unsaved changes (so the .otio on
// disk names the clips), and sends it all through the connect bridge
// (window.agentYViewerBridge.recreate({ text, clips, otio })).
//
// TAKES: a clip may carry takes - the same shot made again. agentY's new version
// of a shot comes in as the ComfyUI message `bepic.edit.take` ({ otio, takes:
// [{ from_file, file, version, note, created }], saved, retime }, sent by POST
// /bepic/take): every open cut that is that .otio, or uses `from_file`, takes it
// in as ONE undo step, never reloaded over what the user has changed. With
// `saved` the baseline the panel compares against takes it in too (the file on
// disk has it), so the take is not an unsaved change, and the user's own unsaved
// edits stay exactly as they are. A clip with more than one take shows the active
// one's version (v2); its menu switches (one undo step) and retimes to fit.
import { api } from "../../scripts/api.js";
import * as D from "./bEpicViewer_editTimelineData.js";

const bridge = () => (typeof window !== "undefined" ? window.agentYViewerBridge : null);
const base = (p) => String(p || "").split(/[\\/]/).pop();

export const EditTakesMixin = {

    // ── several clips selected ───────────────────────────────────────────────

    /** Everything selected: clips, texts, the bed, gaps - the list when there are several, else the single selection. */
    _editTlSelAll() {
        const cut = this._editTlCut;
        if (!cut) return [];
        const m = this._editTlMulti;
        if (m) {
            const list = m.sig === D.selSignature(cut) ? D.pruneSel(cut, m.list) : [];
            if (list.length > 1 && this._editTlSel && list.some((s) => D.sameSel(s, this._editTlSel))) return list;
            this._editTlMulti = null;
        }
        const s = this._editTlSel;
        return D.isItemSel(s) && D.itemOf(cut, s) ? [s] : [];
    },

    /** The selected CLIPS (what Recreate, links and agentY work on). */
    _editTlSelList() {
        return this._editTlSelAll().filter(D.isClipSel);
    },

    /** Make `list` the selection; `primary` is the single selection (default: the last of the list). */
    _editTlSetSelList(list, primary) {
        const cut = this._editTlCut;
        const all = D.pruneSel(cut, list);
        const one = primary && all.some((s) => D.sameSel(s, primary)) ? primary : (all[all.length - 1] || null);
        this._editTlSel = one;
        this._editTlMulti = all.length > 1 ? { list: all, sig: D.selSignature(cut) } : null;
    },

    /** The list follows an edit that kept every clip where it was (a take): same clips, new signature. */
    _editTlMultiRebase() {
        if (this._editTlMulti && this._editTlCut) this._editTlMulti.sig = D.selSignature(this._editTlCut);
    },

    /**
     * A press on a clip, before anything else is done with it. Ctrl (Cmd) on the
     * body toggles the clip in the selection, Shift takes the range to it; true
     * when that is what the press was. Any other press is a single selection
     * again, and goes on to select, trim or drag as it did.
     */
    _editTlMultiDown(e, el, sel) {
        if (e.button !== 0) return false;
        const mod = !!(e.ctrlKey || e.metaKey), shift = !!e.shiftKey;
        if (this._editTlZone(e, el) !== "body" || e.altKey || !(mod || shift)) {
            // A plain press on one of several, in Selection mode: they stay selected, to be dragged together (_editTlGroupDown).
            const together = this._editTlZone(e, el) === "body" && !e.altKey && !this._editTlTrimMode
                && this._editTlSelAll().some((s) => D.sameSel(s, sel));
            if (!together) this._editTlMulti = null;
            return false;
        }
        e.preventDefault();
        e.stopPropagation();
        const cut = this._editTlCut;
        this._editTlEditSel = null;
        const now = this._editTlSelAll();
        if (mod) {
            const next = D.toggleSel(now, sel);
            this._editTlSetSelList(next, next.some((s) => D.sameSel(s, sel)) ? sel : null);
        } else {
            const anchor = this._editTlSel && D.clipOf(cut, this._editTlSel) ? this._editTlSel : now[now.length - 1];
            this._editTlSetSelList([...now, ...D.rangeSel(cut, anchor, sel)], sel);
        }
        this.editTlRefresh();
        return true;
    },

    /** Right-click on a clip: it joins a selection of several, or becomes the selection. */
    _editTlMenuSelect(sel) {
        const now = this._editTlSelAll();
        if (now.length > 1) this._editTlSetSelList(now.some((s) => D.sameSel(s, sel)) ? now : [...now, sel], sel);
        else { this._editTlMulti = null; this._editTlSel = sel; }
    },

    /** Is the clip drawn at (kind, i, track) one of several selected? (for the outline) */
    _editTlInMulti(list, kind, i, track) {
        return list.length > 1 && list.some((s) => s.kind === kind && s.i === i && (kind !== "tclip" || s.track === track));
    },

    // ── takes ────────────────────────────────────────────────────────────────

    /** A clip with more than one take shows the active one's version on its block. */
    _editTlTakeBadge(b, clip) {
        const takes = D.takesOf(clip);
        b.classList.toggle("has-takes", takes.length > 1);
        if (takes.length < 2) return;
        const act = D.activeTake(clip);
        const tag = b.ownerDocument.createElement("span");
        tag.className = "edit-badge-take";
        tag.textContent = "v" + (act ? act.version : "?");
        tag.title = "Takes: " + takes.map((t) => `v${t.version}${t.note ? " " + t.note : ""}${t.active ? " (showing)" : ""}`).join(", ")
            + ". Right-click the clip to switch.";
        b.append(tag);
    },

    /** The menu entries of a clip with takes: one to show each, and Retime to fit. */
    _editTlTakeEntries(sel) {
        const clip = D.clipOf(this._editTlCut, sel);
        const takes = D.takesOf(clip);
        if (takes.length < 2) return [];
        const out = ["-", { label: "Takes ▸", disabled: true, run: () => {} }];
        for (const t of takes) {
            out.push({ label: `${t.active ? "✓ " : " "}v${t.version}${t.note ? "  " + String(t.note).slice(0, 40) : ""}`,
                       run: () => this.editTlSwitchTake(sel, t.version) });
        }
        const act = D.activeTake(clip);
        out.push({ label: "Retime to fit", disabled: !(act && Number(act.len) > 0), run: () => this.editTlRetimeToFit(sel) });
        return out;
    },

    /** The clip `sel` shows take `version` - one undo step. */
    async editTlSwitchTake(sel, version) {
        const clip = D.clipOf(this._editTlCut, sel);
        const take = D.takesOf(clip).find((t) => Number(t.version) === Number(version));
        if (!take || take.active) return;
        try { await this._editTlProbe([take.file]); } catch (_) {}
        const cut = this._editTlCut;
        if (!cut || !D.clipOf(cut, sel)) return;
        this._editTlApply(D.switchTake(cut, sel, version, { durations: this._editTlDur() }));
        this._editTlMultiRebase();
        this._editTlSay(`${clip.name || base(clip.file)}: take v${version} shown - Ctrl+Z undoes it`);
    },

    /** The active take slowed down to fill the length the clip had before it made it shorter. */
    editTlRetimeToFit(sel) {
        const cut = this._editTlCut;
        const next = D.retimeToFit(cut, sel, this._editTlDur());
        if (D.sameCut(next, cut)) return;
        this._editTlApply(next);
    },

    // ── a take comes in ──────────────────────────────────────────────────────

    _editTlListenTakes() {
        if (this._editTlTakesBound) return;
        this._editTlTakesBound = true;
        api.addEventListener("bepic.edit.take", (e) => {
            this.editTlTakeIn(e && e.detail).catch((err) => console.warn("bEpicViewer: take not taken in", err));
        });
        api.addEventListener("bepic.edit.changed", (e) => {
            try { this.editTlChangedIn(e && e.detail); } catch (err) { console.warn("bEpicViewer: changed cut not taken in", err); }
        });
    },

    // ── a cut changed on disk by agentY ──────────────────────────────────────

    /**
     * Take in what `bepic.edit.changed` says ({ otio, edit, said }, sent by POST
     * /bepic/cut: agentY's edit_cut saved the cut with clips added, moved, trimmed
     * or taken out). Every open cut that is that .otio becomes the saved cut, as ONE
     * undo step: the file was written anew, so the `ref`s of what the panel held
     * name other items now - the cut it had, and its undo stack, hold their clips by
     * file from here on (D.detach), as after a save. Unsaved changes of the user's
     * are not merged: they are the step before, one Ctrl+Z back, and the panel says
     * so. Returns how many cuts took it in.
     */
    editTlChangedIn(detail) {
        const d = detail && typeof detail === "object" ? detail : {};
        const edit = d.edit;
        const otio = D.normFile(d.otio);
        if (!otio || !edit || typeof edit !== "object" || !Array.isArray(edit.clips)) return 0;
        if (!Array.isArray(edit.texts)) edit.texts = [];
        if (!Array.isArray(edit.tracks)) edit.tracks = [];
        if (!Array.isArray(edit.sound)) edit.sound = [];
        this._editTlStash();
        const all = this._editTlAll();
        const said = (Array.isArray(d.said) ? d.said : []).map(String).filter(Boolean);
        let took = 0;
        for (const key of Object.keys(all)) {
            const rec = all[key];
            if (!this.allTabs || !this.allTabs[key] || !rec || !rec.cut) continue;
            if (D.normFile(rec.otio) !== otio) continue;
            const dirty = this._editTlDirtyOf(rec);
            this._editTlHistories = this._editTlHistories || {};
            const h = this._editTlHistory(key);
            const past = h.past.map(D.detach);
            this._editTlHistories[key] = D.historyPush({ past, future: [] }, D.detach(rec.cut));
            const next = JSON.parse(JSON.stringify(edit));
            rec.cut = next;
            rec.saved = JSON.parse(JSON.stringify(edit));
            if (d.file) rec.file = String(d.file);
            const line = "agentY changed the cut" + (said.length ? ": " + said.slice(0, 3).join("; ") + (said.length > 3 ? ` (+${said.length - 3})` : "") : "")
                + (dirty ? " - your unsaved changes are one Ctrl+Z back" : " - Ctrl+Z undoes it");
            if (key === this._editTlTab) {
                this._editTlCut = rec.cut;
                this._editTlSaved = rec.saved;
                if (d.file) this._editTlFile = rec.file;
                this._editTlSel = null;
                this._editTlMulti = null;
                this._editTlEditSel = null;
                this._editTlNote = line;
            }
            took += 1;
        }
        if (took) {
            // How long the new files are, for the trims and the waveforms.
            const files = [...edit.clips, ...edit.tracks.flatMap((k) => k.clips || [])].map((c) => c && c.file).filter(Boolean);
            if (files.length && this._editTlProbe) this._editTlProbe(files).catch(() => {}).then(() => this.editTlRefresh());
            this._editTlKeep();
            this.editTlRefresh();
        }
        return took;
    },

    /**
     * Take in what `bepic.edit.take` says ({ otio, takes, saved, retime }): every
     * open cut that is that .otio, or uses a take's `from_file`, gets the takes as
     * one undo step. Returns how many cuts took them.
     */
    async editTlTakeIn(detail) {
        const d = detail && typeof detail === "object" ? detail : {};
        const takes = (Array.isArray(d.takes) ? d.takes : [])
            .filter((t) => t && typeof t.file === "string" && t.file && typeof t.from_file === "string" && t.from_file)
            .slice(0, D.MAX_TAKES)
            .map((t) => ({ from_file: String(t.from_file), file: String(t.file), version: Math.round(Number(t.version)) || 0,
                           note: String(t.note || "").slice(0, 200), created: String(t.created || "") }));
        if (!takes.length) return 0;
        this._editTlTakeBusy = true;
        try { return await this._editTlTakeInRun(d, takes); } finally { this._editTlTakeBusy = false; }
    },

    async _editTlTakeInRun(d, takes) {
        // How long the new files are, so a source shorter than the clip can be fitted.
        try { await this._editTlProbe(takes.map((t) => t.file)); } catch (_) {}
        this._editTlStash();
        const all = this._editTlAll();
        const otio = D.normFile(d.otio);
        const opts = { durations: this._editTlDur(), retime: d.retime === true };
        const apply = (cut) => takes.reduce((c, t) => D.addTake(c, t.from_file, t, opts), cut);
        let took = 0;
        for (const key of Object.keys(all)) {
            const rec = all[key];
            if (!this.allTabs || !this.allTabs[key] || !rec || !rec.cut) continue;
            const mine = !!otio && D.normFile(rec.otio) === otio;
            const uses = takes.some((t) => D.usesFile(rec.cut, t.from_file));
            if (!mine && !uses) continue;
            const here = key === this._editTlTab;
            // The baseline first: with `saved` the file on disk has the take, so it is not a change.
            let base0 = rec.saved;
            if (d.saved === true && mine && rec.saved) {
                const b = apply(rec.saved);
                if (!D.sameCut(b, rec.saved)) base0 = b;
            }
            const next = uses ? apply(rec.cut) : rec.cut;
            const changed = uses && !D.sameCut(next, rec.cut);
            if (base0 !== rec.saved) { rec.saved = base0; if (here) this._editTlSaved = base0; }
            if (changed) {
                if (here) {
                    this._editTlApply(next);
                    this._editTlMultiRebase();
                    const t = takes[0];
                    const clip = [...next.clips, ...next.tracks.flatMap((k) => k.clips)].find((c) => D.normFile(c.file) === D.normFile(t.file));
                    const act = clip && D.activeTake(clip);
                    this._editTlSay(`${(clip && (clip.name || base(clip.file))) || base(t.file)}: take v${act ? act.version : t.version} in`);
                } else {
                    this._editTlHistories = this._editTlHistories || {};
                    this._editTlHistories[key] = D.historyPush(this._editTlHistory(key), rec.cut);
                    rec.cut = next;
                }
                took += 1;
            } else if (base0 !== undefined && here) {
                this.editTlRefresh();
            }
        }
        if (took) { this._editTlKeep(); this.editTlRefresh(); }
        return took;
    },

    // ── Recreate with changes… ───────────────────────────────────────────────

    /** The dialog: what to change in the selected shots, then Send. `sel`: the clip right-clicked. */
    editTlRecreateDialog(sel) {
        const ui = this._editTlUi;
        const cut = this._editTlCut;
        if (!ui || !cut) return;
        if (ui.dialog && ui.dialog.isConnected) { ui.dialog.remove(); ui.dialog = null; }
        let list = this._editTlSelList();
        if (sel && !list.some((s) => D.sameSel(s, sel))) list = [sel];
        const clips = D.selectedClips(cut, list);
        if (!clips.length) return;
        const doc = ui.body.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const box = el("div", "edit-dialog edit-recreate");
        box.addEventListener("pointerdown", (e) => e.stopPropagation());
        const head = el("div", "edit-dialog-head");
        head.append(el("span", "edit-dialog-title", "Recreate with changes"));
        const close = el("button", "edit-btn", "✕");
        close.title = "Close";
        close.addEventListener("click", () => { box.remove(); ui.dialog = null; });
        head.append(close);
        const names = clips.slice(0, 6).map((c) => c.name || base(c.file)).join(", ") + (clips.length > 6 ? `, +${clips.length - 6} more` : "");
        const sub = el("div", "edit-dialog-sub", `${clips.length} shot${clips.length === 1 ? "" : "s"}: ${names}`);
        const text = el("textarea", "edit-brief");
        text.placeholder = "What should be different - e.g. \"warmer light, the camera slower\". The rest of each shot stays as it was.";
        const send = el("button", "edit-btn primary", "Send");
        const note = el("div", "edit-none");
        const b = bridge();
        if (!b || typeof b.recreate !== "function") {
            send.disabled = true;
            note.textContent = b ? "This agentY cannot recreate shots yet (update agentY-comfyuiConnect)."
                : "agentY is not on this page (its ComfyUI extension, agentY-comfyuiConnect, is not loaded).";
        } else {
            note.textContent = "agentY runs the stored graph of each shot again with just this change, and the new versions "
                + "come into the cut as takes (v2 ...); the old ones stay. A cut with unsaved changes is saved first.";
        }
        const ask = async () => {
            const words = text.value.trim();
            if (!words) { note.textContent = "Say what should change."; return; }
            send.disabled = true;
            note.textContent = "Sending…";
            let said;
            try { said = await this._editTlRecreateSend(words, clips); }
            catch (err) { said = { ok: false, text: "Not sent: " + ((err && err.message) || err) }; }
            note.textContent = said.text;
            send.disabled = false;
            if (said.ok) { this._editTlNote = said.text; box.remove(); ui.dialog = null; this.editTlRefresh(); }
        };
        send.addEventListener("click", ask);
        box.append(head, sub, text, send, note);
        ui.body.append(box);
        this._editTlCentre(box);
        ui.dialog = box;
        text.focus();
    },

    /** Save the cut if it has changes, then hand the bridge the shots and the words. Returns { ok, text }. */
    async _editTlRecreateSend(words, clips) {
        const b = bridge();
        if (!b || typeof b.recreate !== "function") return { ok: false, text: "agentY is not on this page." };
        if (this._editTlDirty()) {
            await this._editTlSave();
            if (this._editTlDirty()) return { ok: false, text: "The cut could not be saved, so nothing was sent: " + (this._editTlNote || "") };
        }
        const otio = (await this._editTlOtioPath()) || "";
        if (!otio) return { ok: false, text: "The cut's timeline file could not be found." };
        const said = await b.recreate({ text: words, clips, otio });
        if (!said || !said.ok) return { ok: false, text: (said && said.message) || "agentY did not take it." };
        return { ok: true, text: said.message || "Sent to agentY." };
    },
};
