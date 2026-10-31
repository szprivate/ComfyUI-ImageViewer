// bEpicViewer_editAuto.js
// Auto edit, scene cut detection and asking agentY - the Edit panel's helpers
// that change many shots at once. Each change is ONE step of the undo stack
// (it goes in through _editTlApply), and the panel says what it changed.
//
// Auto edit… (a dialog over the panel) has deterministic modes - local,
// instant, free; their arithmetic is in bEpicViewer_editTimelineData.js:
//   On the beat        the beats of a sound of the cut (GET /bepic/timeline_beats,
//                      agentY's read_beats ported): one shot every N beats, or
//                      the cuts there are moved to the nearest beat
//   Even rhythm        N seconds a shot, or the cut fitted to a length
//   Reference rhythm   the shot lengths of another film (GET /bepic/timeline_shots,
//                      agentY's read_rhythm ported)
//   Best part          the head and tail of each shot taken off
//   Detect cuts        scene cut detection, below
// on the shots of V1, or the selected one; and "Ask agentY…": the cut, saved,
// goes to agentY as a message with a brief (the viewer bridge's feedback, the
// annotation tool's "Send to agentY"); agentY's edit stage loads the .otio,
// edits it and renders it, and the film with its cut comes back in a tab of
// its own - where "Take into <cut>" brings it into the cut that asked.
//
// Detect cuts: a film that is already an edit (several shots baked in) is cut
// where its shots change (GET /bepic/timeline_cuts: hard cuts with an adaptive
// threshold, and dissolves). The cuts found are shown first, as marks on the
// clip with a sensitivity slider; a mark clicked is left out; "Split at all"
// cuts the clip at the marks that are left. Only the clip's in..out is looked at.
import { api } from "../../scripts/api.js";
import * as D from "./bEpicViewer_editTimelineData.js";
import { EDIT_KEYS } from "./bEpicViewer_editKeys.js";
import { openFilePicker } from "./bEpicViewer_exportUI.js";

const FILM_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const MODES = [
    ["beat", "On the beat", "Cut on the beats of the music"],
    ["even", "Even rhythm", "The same length for every shot, or the cut fitted to a length"],
    ["rhythm", "Reference rhythm", "The shot lengths of another film, in order"],
    ["best", "Best part", "Each shot without its first and last moments"],
    ["detect", "Detect cuts", "A film that is already an edit, split where its shots change"],
];

async function getJson(path) {
    const res = await api.fetchApi(path);
    if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
    return res.json();
}

export const EditAutoMixin = {

    // ── the dialog ───────────────────────────────────────────────────────────

    editTlAutoDialog() {
        const ui = this._editTlUi;
        if (!ui || !this._editTlCut || !this._editTlCut.clips.length) return;
        if (ui.dialog && ui.dialog.isConnected) { ui.dialog.remove(); ui.dialog = null; return; }
        const doc = ui.body.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const cut = this._editTlCut;
        const st = this._editTlAutoState || (this._editTlAutoState = {
            mode: "beat", every: 2, beatStyle: "cut", within: 0.3, even: 2, evenStyle: "each", fit: 30,
            sens: 0.3, head: 10, tail: 10, scope: "all", source: "", reference: "", brief: "",
        });
        const box = el("div", "edit-dialog");
        box.addEventListener("pointerdown", (e) => e.stopPropagation());
        const head = el("div", "edit-dialog-head");
        head.append(el("span", "edit-dialog-title", "Auto edit"));
        const close = el("button", "edit-btn", "✕");
        close.title = "Close";
        close.addEventListener("click", () => { box.remove(); ui.dialog = null; });
        head.append(close);
        box.append(head);

        const modes = el("div", "edit-modes");
        const panes = el("div", "edit-mode-pane");
        const field = (label, input) => { const f = el("label", "edit-field"); f.append(el("span", "", label), input); return f; };
        const number = (key, step, min, max) => {
            const i = el("input");
            i.type = "number"; i.step = String(step); i.min = String(min); i.max = String(max);
            i.value = String(st[key]);
            i.addEventListener("change", () => { const v = Number(i.value); if (Number.isFinite(v)) st[key] = v; });
            return i;
        };
        const select = (key, options) => {
            const s = el("select");
            for (const [value, label] of options) {
                const o = el("option", "", label);
                o.value = String(value);
                s.append(o);
            }
            s.value = String(st[key]);
            s.addEventListener("change", () => { st[key] = s.value; });
            return s;
        };
        // The sounds of the cut: the bed, and every clip of a sound track.
        const sounds = [];
        (cut.sound || []).forEach((s) => { if (s.file) sounds.push({ id: "bed:" + s.file, label: "A1: " + (s.name || base(s.file)), file: s.file, at: 0, in: 0 }); });
        for (const k of cut.tracks || []) {
            if (k.kind !== "audio") continue;
            k.clips.forEach((c, i) => sounds.push({ id: `${k.id}:${i}`, label: `${k.name || k.id}: ${c.name || base(c.file)}`,
                                                    file: c.file, at: c.at, in: c.in, length: c.length }));
        }
        if (!sounds.some((s) => s.id === st.source)) st.source = sounds.length ? sounds[0].id : "";
        const films = [...new Set(cut.clips.map((c) => c.file).filter((f) => FILM_RE.test(f || "")))];
        if (!st.reference) st.reference = films[0] || "";

        const panesOf = {
            beat: () => {
                const p = el("div");
                if (!sounds.length) { p.append(el("div", "edit-none", "The cut has no sound to find beats in: put music on A1 or on a sound track.")); return p; }
                p.append(field("Music", select("source", sounds.map((s) => [s.id, s.label]))));
                p.append(field("How", select("beatStyle", [["cut", "a shot every N beats"], ["snap", "move the cuts there to the nearest beat"]])));
                p.append(field("Every", select("every", [[1, "beat"], [2, "2 beats"], [4, "4 beats"], [8, "8 beats"]])));
                p.append(field("Snap within (s)", number("within", 0.05, 0.05, 2)));
                return p;
            },
            even: () => {
                const p = el("div");
                p.append(field("How", select("evenStyle", [["each", "every shot this long"], ["fit", "the cut fitted to a length"]])));
                p.append(field("Seconds a shot", number("even", 0.1, 0.1, 60)));
                p.append(field("The cut's length (s)", number("fit", 0.5, 0.5, 3600)));
                return p;
            },
            rhythm: () => {
                const p = el("div");
                const opts = films.map((f) => [f, base(f)]);
                if (st.reference && !films.includes(st.reference)) opts.push([st.reference, base(st.reference)]);
                const sel = select("reference", opts.length ? opts : [["", "(no film yet)"]]);
                const other = el("button", "edit-btn", "Other film…");
                other.addEventListener("click", () => openFilePicker(this.container, {
                    id: "rhythm", title: "A film to take the rhythm of", kind: "video",
                    exts: [".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"], multiple: false, go: "Use",
                    onPick: async (files) => { if (files[0]) { st.reference = files[0].path; this._editTlAutoRedraw(); } return { ok: true }; },
                }));
                p.append(field("Reference", sel), other);
                p.append(field("Sensitivity (0-1)", number("sens", 0.05, 0.05, 1)));
                return p;
            },
            best: () => {
                const p = el("div");
                p.append(field("Off the start (%)", number("head", 1, 0, 45)), field("Off the end (%)", number("tail", 1, 0, 45)));
                return p;
            },
            detect: () => {
                const p = el("div");
                p.append(el("div", "edit-none", "The films are looked at for the moments their shots change; the cuts found are "
                    + "shown on the clips first, to keep or to leave out, then split at."));
                return p;
            },
        };
        for (const [id, label, title] of MODES) {
            const b = el("button", "edit-mode" + (st.mode === id ? " on" : ""), label);
            b.title = title;
            b.dataset.mode = id;
            b.addEventListener("click", () => { st.mode = id; this._editTlAutoRedraw(); });
            modes.append(b);
        }
        panes.append(panesOf[st.mode]());
        box.append(modes, panes);

        const scopeRow = el("div", "edit-dialog-row");
        const v1 = this._editTlSel && this._editTlSel.kind === "clip" ? this._editTlSel.i : -1;
        if (v1 < 0 && st.scope === "sel") st.scope = "all";
        const scope = select("scope", [["all", `All ${cut.clips.length} shots on V1`], ...(v1 >= 0 ? [["sel", `The selected shot (${v1 + 1})`]] : [])]);
        scopeRow.append(field("Apply to", scope));
        const go = el("button", "edit-btn primary", st.mode === "detect" ? "Detect" : "Apply");
        go.dataset.go = "1";
        const said = el("div", "edit-dialog-said");
        go.addEventListener("click", async () => {
            go.disabled = true;
            said.textContent = "…";
            try { said.textContent = await this._editTlAutoRun(st, st.scope === "sel" && v1 >= 0 ? [v1] : null, sounds); }
            catch (err) { said.textContent = "Not done: " + (err && err.message || err); }
            go.disabled = false;
            if (said.dataset.undo) {
                const u = el("button", "edit-btn", "Undo");
                u.addEventListener("click", () => { this.editTlUndo(); said.textContent = "undone"; delete said.dataset.undo; });
                said.append(" ", u);
            }
        });
        scopeRow.append(go);
        box.append(scopeRow, said);

        // ── ask agentY ──
        const ask = el("div", "edit-ask");
        ask.append(el("div", "edit-dialog-sub", "Ask agentY…"));
        const brief = el("textarea", "edit-brief");
        brief.placeholder = "What to do with this cut - e.g. \"tighter, 20 seconds, end on the logo shot\"";
        brief.value = st.brief || "";
        brief.addEventListener("input", () => { st.brief = brief.value; });
        const loses = D.agentLoses(cut);
        const bridge = typeof window !== "undefined" ? window.agentYViewerBridge : null;
        const send = el("button", "edit-btn primary", "Ask agentY");
        const note = el("div", "edit-none");
        if (!bridge || typeof bridge.feedback !== "function") {
            send.disabled = true;
            note.textContent = "agentY is not on this page (its ComfyUI extension, agentY-comfyuiConnect, is not loaded).";
        } else {
            note.textContent = "The cut is saved first; agentY's edit stage (an \"agentY edit\" node on the canvas) loads "
                + "it, edits it and renders it, and the new cut opens in a tab of its own.";
        }
        if (loses.length) {
            const warn = el("div", "edit-warn", "agentY does not read back: " + loses.join("; ") + ". Its answer comes without them.");
            ask.append(warn);
        }
        send.addEventListener("click", async () => {
            send.disabled = true;
            note.textContent = await this.editTlAskAgent(brief.value);
            send.disabled = false;
        });
        ask.append(brief, send, note);
        box.append(ask);
        ui.body.append(box);
        ui.dialog = box;
    },

    _editTlAutoRedraw() {
        const ui = this._editTlUi;
        if (ui && ui.dialog) { ui.dialog.remove(); ui.dialog = null; }
        this.editTlAutoDialog();
    },

    // Run a mode: what it says back is the dialog's answer line.
    async _editTlAutoRun(st, indices, sounds) {
        const before = this._editTlCut;
        const opts = { indices, durations: await this._editTlDurations(before) };
        let after = null;
        if (st.mode === "beat") {
            const src = sounds.find((s) => s.id === st.source);
            if (!src) return "the cut has no sound to find beats in";
            const got = await getJson("/bepic/timeline_beats?path=" + encodeURIComponent(src.file));
            if (!got.bpm || !(got.beats || []).length) return got.note || "no steady beat was found in that sound";
            const beats = D.beatsInFilm(got.beats, src);
            after = st.beatStyle === "snap"
                ? D.snapCutsToBeats(before, D.everyNth(beats, st.every), { ...opts, within: st.within })
                : D.cutOnBeats(before, beats, { ...opts, every: st.every });
            this._editTlAutoNote = `${got.bpm} bpm`;
        } else if (st.mode === "even") {
            after = st.evenStyle === "fit" ? D.fitLength(before, st.fit, opts) : D.evenRhythm(before, st.even, opts);
        } else if (st.mode === "rhythm") {
            if (!st.reference) return "pick a film to take the rhythm of";
            const got = await getJson(`/bepic/timeline_shots?path=${encodeURIComponent(st.reference)}&sensitivity=${st.sens}`);
            if (!(got.shots || []).length) return "no shots found in that film";
            after = D.rhythmFrom(before, got.shots, opts);
            this._editTlAutoNote = `${got.shots.length} shots in the reference`;
        } else if (st.mode === "best") {
            after = D.bestPart(before, { ...opts, head: st.head / 100, tail: st.tail / 100 });
        } else if (st.mode === "detect") {
            const sels = (indices || before.clips.map((_, i) => i)).map((i) => ({ kind: "clip", i }));
            return this.editTlDetectCuts(sels);
        }
        if (!after) return "";
        const said = D.describeChanges(before, after);
        if (!said.changed && D.sameCut(before, after)) return "nothing to change";
        this._editTlApply(after);
        const note = this._editTlAutoNote ? ` (${this._editTlAutoNote})` : "";
        this._editTlAutoNote = "";
        const ui = this._editTlUi;
        const line = said.lines.join(", ") + note + ". Ctrl+Z undoes it.";
        if (ui && ui.dialog) { const s = ui.dialog.querySelector(".edit-dialog-said"); if (s) s.dataset.undo = "1"; }
        return line;
    },

    // ── the shortcuts ────────────────────────────────────────────────────────

    editTlKeysHelp(anchor) {
        const ui = this._editTlUi;
        if (!ui) return;
        if (ui.keys && ui.keys.isConnected) { ui.keys.remove(); ui.keys = null; return; }
        const doc = ui.body.ownerDocument;
        const box = doc.createElement("div");
        box.className = "edit-dialog edit-keys";
        const t = doc.createElement("div");
        t.className = "edit-dialog-title";
        t.textContent = "Keys (while the timeline has the focus)";
        box.append(t);
        for (const [k, what] of EDIT_KEYS) {
            const row = doc.createElement("div");
            row.className = "edit-keyrow";
            const kb = doc.createElement("kbd");
            kb.textContent = k;
            const s = doc.createElement("span");
            s.textContent = what;
            row.append(kb, s);
            box.append(row);
        }
        box.addEventListener("click", () => { box.remove(); ui.keys = null; });
        ui.body.append(box);
        ui.keys = box;
        void anchor;
    },

    // ── scene cut detection ──────────────────────────────────────────────────

    /** Look for the cuts in the films of these clips; they are shown as marks to split at. */
    async editTlDetectCuts(sels) {
        const cut = this._editTlCut;
        const films = (sels || []).filter((s) => { const c = D.clipOf(cut, s); return c && FILM_RE.test(c.file || ""); });
        if (!films.length) { this._editTlSay("no film to look for cuts in"); return "no film to look for cuts in"; }
        this._editTlSay(`looking for cuts in ${films.length} film${films.length === 1 ? "" : "s"}…`);
        const items = [];
        let failed = 0;
        for (const sel of films) {
            const clip = D.clipOf(cut, sel);
            try {
                const got = await getJson("/bepic/timeline_cuts?path=" + encodeURIComponent(clip.file));
                items.push({ sel, file: clip.file, cuts: got.cuts || [], off: new Set() });
            } catch (_) { failed += 1; }
        }
        if (this._editTlCut !== cut) return "the cut was changed meanwhile - nothing shown";
        const sens = this._editTlMarks ? this._editTlMarks.sens : 0.5;
        this._editTlMarks = { tab: this._editTlTab, cut, sens, items };
        this._editTlNote = failed ? `${failed} film(s) could not be read` : "";
        const ui = this._editTlUi;
        if (ui && ui.dialog) { ui.dialog.remove(); ui.dialog = null; }
        this.editTlRefresh();
        const n = this._editTlMarkList().length;
        return `${n} cut${n === 1 ? "" : "s"} found`;
    },

    /** The marks as they stand: [{ item, sel, t (film), src, kind, off }]. */
    _editTlMarkList() {
        const m = this._editTlMarks;
        if (!m) return [];
        const cut = m.cut, fps = cut.fps || 24;
        const out = [];
        for (const item of m.items) {
            const clip = D.clipOf(cut, item.sel);
            if (!clip) continue;
            const start = item.sel.kind === "clip" ? D.clipStarts(cut)[item.sel.i] : Number(clip.at) || 0;
            for (const mk of D.cutMarks(item.cuts, clip, start, m.sens, fps)) {
                out.push({ item, sel: item.sel, ...mk, off: item.off.has(mk.src) });
            }
        }
        return out;
    },

    editTlMarksCancel() {
        this._editTlMarks = null;
        this.editTlRefresh();
    },

    editTlMarksSplit() {
        const m = this._editTlMarks;
        if (!m) return;
        const list = this._editTlMarkList().filter((k) => !k.off);
        let cut = m.cut, count = 0;
        // Clip by clip, the later ones first, so the earlier ones keep their place.
        const items = [...m.items].sort((a, b) => (a.sel.kind === b.sel.kind ? b.sel.i - a.sel.i : (a.sel.kind === "clip" ? 1 : -1)));
        for (const item of items) {
            const got = D.splitAtMany(cut, item.sel, list.filter((k) => k.item === item).map((k) => k.t));
            cut = got.cut;
            count += got.count;
        }
        this._editTlMarks = null;
        this._editTlSel = null;
        if (!count) { this.editTlRefresh(); return; }
        this._editTlApply(cut);
        this._editTlSay(`cut at ${count} place${count === 1 ? "" : "s"} - Ctrl+Z undoes it`);
    },

    // Drawn by editTlRefresh: the marks on their clips, and the bar above the tracks.
    editTlMarksDraw(ui, cut, lay) {
        const doc = ui.body.ownerDocument;
        if (this._editTlMarks && (this._editTlMarks.cut !== cut || this._editTlMarks.tab !== this._editTlTab)) this._editTlMarks = null;
        const m = this._editTlMarks;
        if (!m) { if (ui.cutbar) ui.cutbar.style.display = "none"; return; }
        if (!ui.cutbar || !ui.cutbar.isConnected) {
            ui.cutbar = doc.createElement("div");
            ui.cutbar.className = "edit-cutbar";
            ui.body.insertBefore(ui.cutbar, ui.main);
        }
        const list = this._editTlMarkList();
        const keep = list.filter((k) => !k.off).length;
        const bar = ui.cutbar;
        bar.style.display = "";
        bar.replaceChildren();
        const text = doc.createElement("span");
        text.textContent = `${list.length} cut${list.length === 1 ? "" : "s"} found${list.length !== keep ? `, ${keep} kept` : ""} · click a mark to leave it out · Sensitivity`;
        const slider = doc.createElement("input");
        slider.type = "range";
        slider.min = "0"; slider.max = "1"; slider.step = "0.05";
        slider.value = String(m.sens);
        slider.className = "edit-sens";
        slider.title = "Higher finds softer cuts (and more false ones)";
        slider.addEventListener("input", () => { m.sens = Number(slider.value); this.editTlRefresh(); });
        const split = doc.createElement("button");
        split.className = "edit-btn primary";
        split.textContent = `Split at all (${keep})`;
        split.disabled = !keep;
        split.addEventListener("click", () => this.editTlMarksSplit());
        const cancel = doc.createElement("button");
        cancel.className = "edit-btn";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => this.editTlMarksCancel());
        bar.append(text, slider, split, cancel);
        // A mark on its clip's track: a line, its kind in its title.
        for (const k of list) {
            const id = k.sel.kind === "clip" ? "V1" : k.sel.track;
            const row = [...ui.rows.querySelectorAll(".edit-track")].find((r) => r.dataset.track === id);
            if (!row) continue;
            const mark = doc.createElement("div");
            mark.className = "edit-cutmark" + (k.off ? " off" : "") + (k.kind === "dissolve" ? " soft" : "");
            mark.style.left = (k.t / lay.total) * 100 + "%";
            mark.title = `${k.kind === "dissolve" ? "A dissolve" : "A cut"} at ${D.lengthLabel(k.t)} of the film (${k.src.toFixed(2)}s of the file)`
                + ` - click to ${k.off ? "keep it" : "leave it out"}`;
            mark.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (k.item.off.has(k.src)) k.item.off.delete(k.src); else k.item.off.add(k.src);
                this.editTlRefresh();
            });
            row.append(mark);
        }
    },

    // ── asking agentY ────────────────────────────────────────────────────────

    /** Send the cut, saved, with a brief to agentY. What it says back is the answer line. */
    async editTlAskAgent(brief) {
        const bridge = typeof window !== "undefined" ? window.agentYViewerBridge : null;
        if (!bridge || typeof bridge.feedback !== "function") return "agentY is not on this page.";
        if (this._editTlDirty()) {
            await this._editTlSave();
            if (this._editTlDirty()) return "The cut could not be saved, so it was not sent: " + (this._editTlNote || "");
        }
        const path = await this._editTlOtioPath();
        if (!path) return "The cut's timeline file could not be found.";
        const cut = this._editTlCut;
        const loses = D.agentLoses(cut);
        const text = [
            String(brief || "").trim() || "Improve this cut.",
            "",
            `(From the bEpic viewer's Edit panel.) The cut is the timeline file ${path}. Load it into the agentY edit `
            + `stage with edit_timeline - the first op {"op": "load", "file": "${path.replace(/\\/g, "\\\\")}"} - make the `
            + "changes, and render the edit so it opens in the viewer.",
            loses.length ? `The viewer's cut also has ${loses.join("; ")}, which the edit stage does not read back.` : "",
        ].filter((s, i) => s || i === 1).join("\n");
        let said = null;
        try { said = await bridge.feedback({ text, files: [] }); } catch (e) { return "Not sent: " + (e && e.message || e); }
        if (!said || !said.ok) return (said && said.message) || "agentY did not take it.";
        this._editTlAsk = { key: this._editTlTab, before: cut, at: Date.now(),
                            name: cut.name || String(this._editTlFile || "cut").replace(/\.otio$/i, "") };
        return (said.message || "Sent to agentY.") + " Its cut will open in a tab of its own.";
    },

    async _editTlOtioPath() {
        if (this._editTlOtio) return this._editTlOtio;
        if (!this._editTlTarget) return "";
        const data = await this._editTlRead(this._editTlTarget.path ? { ...this._editTlTarget } : this._editTlTarget);
        if (data && data.otio) this._editTlOtio = data.otio;
        return this._editTlOtio || "";
    },

    // A cut's tab was opened (_editTlOpenTab): if it is agentY's answer to a
    // cut that asked, it offers to be taken into that one.
    editTlAnswerArrived(key, record) {
        const ask = this._editTlAsk;
        if (!ask || key === ask.key || Date.now() - ask.at > 3 * 3600 * 1000 || !this.allTabs[ask.key]) return;
        const said = D.describeChanges(ask.before, record.cut || D.emptyCut());
        this._editTlAnswer = { from: key, to: ask.key, name: ask.name, lines: said.lines };
        this._editTlAsk = null;
        this._editTlNote = "agentY's answer to " + ask.name + ": " + said.lines.join(", ");
    },

    /** The bar's "Take into <cut>" button: shown on the tab of agentY's answer. */
    editTlAnswerButton(btn) {
        const a = this._editTlAnswer;
        const on = !!a && this._editTlTab === a.from && !!this.allTabs[a.to];
        btn.style.display = on ? "" : "none";
        if (!on) return;
        btn.textContent = "Take into " + a.name;
        btn.title = "Make this the cut of " + a.name + " (" + a.lines.join(", ") + ") - one step, Ctrl+Z undoes it";
    },

    editTlTakeAnswer() {
        const a = this._editTlAnswer;
        if (!a || this._editTlTab !== a.from || !this.allTabs[a.to]) return;
        const taken = D.detach(this._editTlCut);
        this._editTlAnswer = null;
        this.switchTab(a.to);
        if (this._editTlTab !== a.to) this.editTlUse(a.to);
        this._editTlSel = null;
        this._editTlApply({ ...taken, name: this._editTlCut.name, fps: this._editTlCut.fps });
        this._editTlSay("agentY's cut taken in (" + a.lines.join(", ") + ") - Ctrl+Z undoes it");
    },
};

function base(p) { return String(p || "").split(/[\\/]/).pop(); }
