// bEpicViewer_editPaste.js
// Copy a clip, paste its attributes - Resolve's Paste Attributes. Ctrl+C (or
// the clip's right-click "Copy") puts the selected clip or text on the panel's
// clipboard (`_editTlClipboard`, D.pasteSource: a copy of it, so it survives the
// clip's own changes and the cut's tab changing). Alt+V (or "Paste
// Attributes…") opens a small dialog for the selected clips: checkboxes grouped
// as the Inspector's (Video: zoom, position, anchor, rotation, flip, cropping,
// opacity; Audio: volume; one "include keyframes" switch; Timing: speed; Clip:
// name, colour; Text: its look), All / None, and Apply. A box is off where the
// source has no such thing or none of the targets can take it. Apply is ONE
// step of the undo stack (D.pasteAttributes); the selection stays. The boxes
// checked are remembered (localStorage PASTE_STORE). Keys go in clip time:
// where they were from the source's start, from the target's start, cut off
// at its end.
import * as D from "./bEpicViewer_editTimelineData.js";

export const PASTE_STORE = "bepic.viewer.pasteAttrs";
const PASTE_DEFAULT = ["zoom", "position", "anchor", "rotation", "flip", "crop", "opacity", "volume", "keys"];

export const EditPasteMixin = {

    /** Ctrl+C: the selected clip (the last clicked of several) or text onto the clipboard. */
    editTlCopy(sel) {
        const cut = this._editTlCut;
        const s = sel || this._editTlSel;
        const got = cut && s ? D.pasteSource(cut, s) : null;
        if (!got) { this._editTlSay("select a clip or a text to copy it (Ctrl+C)"); return false; }
        this._editTlClipboard = got;
        this._editTlSay(`copied ${got.name} · Alt+V pastes its attributes onto the selected clips`);
        return true;
    },

    /** The boxes last checked (the defaults the first time). */
    _editTlPastePicks() {
        let kept = null;
        try { kept = JSON.parse(window.localStorage.getItem(PASTE_STORE) || "null"); } catch (_) { kept = null; }
        const list = Array.isArray(kept) ? kept : PASTE_DEFAULT;
        return Object.fromEntries(D.PASTE_ATTRS.map((a) => [a.id, list.includes(a.id)]));
    },

    _editTlPasteKeep(picks) {
        try { window.localStorage.setItem(PASTE_STORE, JSON.stringify(Object.keys(picks).filter((k) => picks[k]))); } catch (_) {}
    },

    /** The selected items a paste goes to: clips and texts. */
    _editTlPasteTargets() {
        return this._editTlSelAll().filter((s) => D.isClipSel(s) || s.kind === "text");
    },

    /** Alt+V: the Paste Attributes dialog, for the selected clips. */
    editTlPasteDialog() {
        const ui = this._editTlUi, cut = this._editTlCut;
        if (!ui || !cut) return;
        const source = this._editTlClipboard;
        if (!source) { this._editTlSay("nothing copied: select a clip and press Ctrl+C first"); return; }
        const targets = this._editTlPasteTargets();
        if (!targets.length) { this._editTlSay("select the clips to paste onto"); return; }
        if (ui.dialog && ui.dialog.isConnected) ui.dialog.remove();
        const doc = ui.body.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const offer = D.pasteOffer(cut, source, targets);
        const picks = this._editTlPastePicks();
        const box = el("div", "edit-dialog edit-paste");
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "Paste Attributes");
        const head = el("div", "edit-dialog-head");
        const close = el("button", "edit-btn", "✕");
        close.title = "Close (Esc)";
        head.append(el("span", "edit-dialog-title", "Paste Attributes"), close);
        const sub = el("div", "edit-none", `From ${source.name} onto ${targets.length} selected ${targets.length === 1 ? "item" : "items"}`);
        const groups = el("div", "edit-paste-groups");
        const boxes = {};
        for (const [g, title] of D.PASTE_GROUPS) {
            const attrs = D.PASTE_ATTRS.filter((a) => a.group === g);
            const col = el("div", "edit-paste-group");
            col.dataset.group = g;
            col.append(el("div", "edit-dialog-sub", title));
            for (const a of attrs) {
                const o = offer[a.id];
                const ok = o.source && o.targets;
                const lab = el("label", "edit-paste-item" + (ok ? "" : " off"));
                const cb = el("input");
                cb.type = "checkbox";
                cb.dataset.attr = a.id;
                cb.disabled = !ok;
                cb.checked = ok && !!picks[a.id];
                lab.title = ok ? "" : !o.source ? (a.id === "keys" ? "The copied clip has no keyframes" : "The copied clip has none") : "None of the selected clips can take it";
                cb.addEventListener("change", () => { picks[a.id] = cb.checked; this._editTlPasteKeep(picks); });
                lab.append(cb, el("span", "", a.label));
                col.append(lab);
                boxes[a.id] = cb;
            }
            groups.append(col);
        }
        const all = el("button", "edit-btn edit-paste-all", "All");
        const none = el("button", "edit-btn edit-paste-none", "None");
        const set = (on) => {
            for (const [id, cb] of Object.entries(boxes)) if (!cb.disabled) { cb.checked = on; picks[id] = on; }
            this._editTlPasteKeep(picks);
        };
        all.addEventListener("click", () => set(true));
        none.addEventListener("click", () => set(false));
        const go = el("button", "edit-btn primary edit-paste-go", "Apply");
        const cancel = el("button", "edit-btn edit-paste-cancel", "Cancel");
        const row = el("div", "edit-dialog-row");
        const left = el("div", "edit-paste-btns"), right = el("div", "edit-paste-btns");
        left.append(all, none);
        right.append(cancel, go);
        row.append(left, right);
        const shut = () => { if (box._bepicCentre) box._bepicCentre.stop(); box.remove(); if (ui.dialog === box) ui.dialog = null; };
        const apply = () => {
            const chosen = Object.fromEntries(Object.entries(boxes).map(([id, cb]) => [id, !cb.disabled && cb.checked]));
            shut();
            this.editTlPasteApply(chosen, targets);
        };
        close.addEventListener("click", shut);
        cancel.addEventListener("click", shut);
        go.addEventListener("click", apply);
        box.addEventListener("pointerdown", (e) => e.stopPropagation());
        box.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); shut(); this._editTlFocusBody(); }
            else if (e.key === "Enter") { e.preventDefault(); apply(); }
        });
        box.append(head, sub, groups, row);
        ui.body.append(box);
        this._editTlCentre(box);
        ui.dialog = box;
        try { go.focus({ preventScroll: true }); } catch (_) {}
    },

    /** The checked attributes of the clipboard's clip on `targets` (default: the selection) - one undo step, the selection kept. */
    editTlPasteApply(picks, targets) {
        const cut = this._editTlCut, source = this._editTlClipboard;
        if (!cut || !source) return false;
        const list = (targets || this._editTlPasteTargets()).filter((s) => D.pasteCaps(cut, s));
        if (!list.length) return false;
        const next = D.pasteAttributes(cut, source, list, picks || {});
        if (D.sameCut(next, cut)) { this._editTlSay("nothing to paste: those attributes are the same already"); this._editTlFocusBody(); return false; }
        const was = this._editTlSelAll(), primary = this._editTlSel;
        this._editTlApply(next);
        // A speed pasted changes lengths, which a multi selection is keyed by: it is set again.
        if (was.length > 1) { this._editTlSetSelList(was, primary); this.editTlRefresh(); }
        const n = D.PASTE_ATTRS.filter((a) => picks[a.id]).length;
        this._editTlSay(`pasted ${n} attribute${n === 1 ? "" : "s"} of ${source.name} onto ${list.length} item${list.length === 1 ? "" : "s"}`);
        this._editTlFocusBody();
        return true;
    },

    _editTlFocusBody() {
        const ui = this._editTlUi;
        if (ui && ui.body && ui.body.focus) { try { ui.body.focus({ preventScroll: true }); } catch (_) {} }
    },
};
