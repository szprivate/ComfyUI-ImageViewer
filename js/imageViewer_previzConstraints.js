// imageViewer_previzConstraints.js
// Constraints in the 3D space, the panel's half: the Constrain menu (beside
// Rig), the CONSTRAINTS section of the Channel Box, baking, and the methods
// agentY's ops call. The data is imageViewer_constraintData.js, the maths
// imageViewer_constraints.js, and the view applies them in applyFrame.
//
// Maya's habit for making one: select the targets, then the item that should
// follow them LAST (it is the primary selection), and pick the kind. Every
// edit is one undo step and goes through previzChanged like any other.
import * as S from "./imageViewer_scene3d.js";
import * as D from "./imageViewer_constraintData.js";
import * as C from "./imageViewer_constraints.js";
import { notice } from "./imageViewer_exportUI.js";

const OFFSET_KEY = "imageviewer.previz.constraintOffset";

const fmt = (v) => {
    if (!Number.isFinite(v)) return "0";
    const r = Math.round(v * 1000) / 1000;
    return String(Object.is(r, -0) ? 0 : r);
};

export const PrevizConstraintsMixin = {

    /** Whether new constraints keep the driven item where it is (localStorage, per viewer). */
    previzConstraintKeepOffset() {
        try {
            const v = localStorage.getItem(OFFSET_KEY);
            return v === null ? true : v === "1";
        } catch (_) { return true; }
    },

    previzSetConstraintKeepOffset(on) {
        try { localStorage.setItem(OFFSET_KEY, on ? "1" : "0"); } catch (_) { /* private window */ }
    },

    /**
     * Make a constraint. `driven` and `targets` default to the selection: the
     * last selected item follows the others. Returns the constraint's id, or
     * null (and says why) when it cannot be made.
     */
    previzConstrain(type, {
        driven = null, targets = null, maintainOffset = this.previzConstraintKeepOffset(),
        weights = null, skip = null, aim = null,
    } = {}) {
        const scene = this.previzScene();
        if (!scene) return null;
        const label = D.CONSTRAINT_LABELS[type];
        if (!label) { notice("warn", `Unknown constraint "${type}".`); return null; }
        const sel = this.previzSelectedIds();
        const drivenId = driven || this._previzSelection;
        const item = S.itemById(scene, drivenId);
        const wanted = (targets || sel.filter((id) => id !== drivenId)).filter((id) => S.itemById(scene, id));
        if (!item || !wanted.length) {
            notice("info", `${label} constraint: select the target(s) first, then the item that follows them.`);
            return null;
        }
        const refused = [];
        const ok = [];
        for (const id of wanted) {
            const why = C.cannotConstrain(scene, drivenId, id);
            if (why) refused.push(`${S.itemById(scene, id).name}: ${why}`);
            else ok.push(id);
        }
        if (aim && aim.upObject && C.cannotConstrain(scene, drivenId, aim.upObject)) {
            refused.push(`up object ${S.itemById(scene, aim.upObject)?.name || aim.upObject}: it follows the item`);
            aim = { ...aim, upObject: null };
        }
        if (!ok.length) {
            notice("warn", `${label} constraint not made: ${refused.join("; ")}.`);
            return null;
        }
        const c = D.makeConstraint(type, ok, {
            kind: item.kind, maintainOffset, weights, skip, aim, name: D.nextConstraintName(item, type),
        });
        if (!c) return null;
        this.previzSnapshot(`${type} constraint`);
        (item.constraints || (item.constraints = [])).push(c);
        C.captureOffsets(scene, item, c, Math.round(this.currentFrame || 0));
        this.previzChanged();
        const names = ok.map((id) => S.itemById(scene, id).name).join(", ");
        notice("info", `${item.name} follows ${names} (${c.name}${maintainOffset ? ", offset kept" : ""}).`
            + (refused.length ? ` Left out: ${refused.join("; ")}.` : ""));
        return c.id;
    },

    /** Take a constraint off (all of the item's with `constraintId` null). Returns how many went. */
    previzRemoveConstraint(drivenId = this._previzSelection, constraintId = null, { quiet = false } = {}) {
        const scene = this.previzScene();
        const ids = drivenId ? [drivenId] : this.previzSelectedIds();
        let n = 0;
        const hit = ids.map((id) => S.itemById(scene, id)).filter((it) => it && it.constraints
            && it.constraints.some((c) => !constraintId || c.id === constraintId));
        if (!hit.length) return 0;
        this.previzSnapshot(constraintId ? "remove constraint" : "remove constraints");
        for (const item of hit) {
            const before = item.constraints.length;
            item.constraints = item.constraints.filter((c) => constraintId && c.id !== constraintId);
            n += before - item.constraints.length;
            this._previzDropWeightTracks(item);
            if (!item.constraints.length) delete item.constraints;
        }
        this.previzChanged();
        if (!quiet) notice("info", `Removed ${n} constraint${n === 1 ? "" : "s"}.`);
        return n;
    },

    _previzDropWeightTracks(item) {
        if (!item.tracks) return;
        for (const prop of Object.keys(item.tracks)) {
            const p = D.parseWeightProp(prop);
            if (p && !D.constraintOf(item, p.cid)) delete item.tracks[prop];
        }
    },

    /** The scene's constraints (or one item's), as plain rows for the agent and the tests. */
    previzListConstraints(id = null) {
        const scene = this.previzScene();
        if (!scene) return [];
        const frame = Math.round(this.currentFrame || 0);
        const out = [];
        for (const item of scene.items || []) {
            if (id && item.id !== id) continue;
            for (const c of item.constraints || []) {
                out.push({
                    id: c.id, name: c.name, type: c.type, driven: item.id, driven_name: item.name,
                    on: c.on, weight: S.valueAt(item, D.envelopeProp(c.id), frame),
                    maintainOffset: c.maintainOffset, skip: c.skip,
                    aim: c.aim ? { ...c.aim } : undefined,
                    targets: c.targets.map((t) => ({
                        id: t.id, name: (S.itemById(scene, t.id) || {}).name || t.id,
                        weight: S.valueAt(item, D.weightProp(c.id, t.id), frame),
                    })),
                });
            }
        }
        return out;
    },

    /**
     * Set a weight: a target's (`targetId`), or the constraint's own (null).
     * A keyed weight, or `key`, or Autokey, writes a key at the playhead.
     */
    previzSetConstraintWeight(drivenId, constraintId, targetId, value, { key = false } = {}) {
        const item = S.itemById(this.previzScene(), drivenId);
        const c = D.constraintOf(item, constraintId);
        if (!c) return false;
        const prop = targetId ? D.weightProp(c.id, targetId) : D.envelopeProp(c.id);
        if (targetId && !c.targets.some((t) => t.id === targetId)) return false;
        const [lo, hi] = D.weightRange(prop);
        const v = Math.min(hi, Math.max(lo, Number(value) || 0));
        this.previzSnapshot("constraint weight");
        const frame = Math.round(this.currentFrame || 0);
        if (key || this._previzAutokey || S.isAnimated(item, prop)) S.setKeyframe(item, prop, frame, v, this._previzEase || "smooth");
        else S.setStaticValue(item, prop, v);
        this.previzChanged();
        return true;
    },

    /** Switch a constraint on or off. */
    previzSetConstraintOn(drivenId, constraintId, on) {
        const item = S.itemById(this.previzScene(), drivenId);
        const c = D.constraintOf(item, constraintId);
        if (!c) return false;
        this.previzSnapshot(on ? "constraint on" : "constraint off");
        c.on = !!on;
        this.previzChanged();
        return true;
    },

    /** Change a constraint's settings: skip axes, aim axes / up, maintain offset (re-taken). */
    previzEditConstraint(drivenId, constraintId, patch = {}) {
        const scene = this.previzScene();
        const item = S.itemById(scene, drivenId);
        const c = D.constraintOf(item, constraintId);
        if (!c) return false;
        this.previzSnapshot("edit constraint");
        if (patch.skip) c.skip = D.cleanSkip({ ...c.skip, ...patch.skip });
        if (patch.name) c.name = String(patch.name).slice(0, 120);
        if (c.type === "aim" && patch.aim) {
            const aim = { ...c.aim, ...patch.aim };
            if (aim.upObject && C.cannotConstrain(scene, drivenId, aim.upObject)) aim.upObject = null;
            c.aim = D.cleanAim(aim, item.kind);
        }
        if (patch.maintainOffset !== undefined) c.maintainOffset = !!patch.maintainOffset;
        // An aim's offset is measured against its axes, so a change of them takes it again.
        if (patch.maintainOffset !== undefined || (c.type === "aim" && patch.aim && c.maintainOffset)) {
            C.captureOffsets(scene, item, c, Math.round(this.currentFrame || 0));
        }
        this.previzChanged();
        return true;
    },

    /**
     * Take the offsets again where the item stands now (Maya's "update
     * offset"): move the item, then this, and it follows from its new place.
     * Its own channels are where it is put back to, so this is for the item
     * moved with the constraint off.
     */
    previzConstraintUpdateOffsets(drivenId, constraintId) {
        const scene = this.previzScene();
        const item = S.itemById(scene, drivenId);
        const c = D.constraintOf(item, constraintId);
        if (!c) return false;
        this.previzSnapshot("update constraint offset");
        c.maintainOffset = true;
        C.captureOffsets(scene, item, c, Math.round(this.currentFrame || 0));
        this.previzChanged();
        return true;
    },

    /** Select the targets of the selected item's constraints (or of one). */
    previzSelectConstraintTargets(drivenId = this._previzSelection, constraintId = null) {
        const item = S.itemById(this.previzScene(), drivenId);
        const ids = [];
        for (const c of (item && item.constraints) || []) {
            if (constraintId && c.id !== constraintId) continue;
            for (const t of c.targets) if (!ids.includes(t.id)) ids.push(t.id);
        }
        if (!ids.length) return 0;
        this.previzSelect(ids[0]);
        for (const id of ids.slice(1)) this.previzSelect(id, { add: true });
        return ids.length;
    },

    /**
     * Bake: key the constrained channels on every frame of `first..last` (the
     * shot when not given) and, with `remove`, take the constraints off - the
     * item then moves the same way with nothing following anything. What an
     * export or a hand-off to another program wants. Returns the keys written.
     */
    previzBakeConstraints(ids = null, { first = null, last = null, remove = true } = {}) {
        const scene = this.previzScene();
        if (!scene) return 0;
        const want = (ids || this.previzSelectedIds()).map((id) => S.itemById(scene, id))
            .filter((it) => it && D.isConstrained(it));
        if (!want.length) { notice("info", "Bake constraints: select an item that has a constraint."); return 0; }
        this.previzSnapshot("bake constraints");
        const res = C.bakeScene(scene, want.map((it) => it.id), first ?? 0, last, { remove });
        const n = res.keys, f0 = res.first, f1 = res.last;
        this.previzChanged();
        notice("info", `Baked ${want.length} item${want.length === 1 ? "" : "s"} over frames ${f0}-${f1} (${n} keys)`
            + (remove ? "; their constraints are off now." : "."));
        return n;
    },

    // ── The Constrain menu ─────────────────────────────────────────────────

    _previzToggleConstrainMenu(anchor) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const scene = this.previzScene();
        const ids = this.previzSelectedIds();
        const item = S.itemById(scene, this._previzSelection);
        const targets = ids.filter((id) => id !== this._previzSelection);
        const can = !!(item && targets.length);
        const keep = this.previzConstraintKeepOffset();
        const constrained = ids.map((id) => S.itemById(scene, id)).filter((it) => it && it.constraints && it.constraints.length);
        const why = !item ? "Select the target(s), then the item that should follow them (last)."
            : !targets.length ? `Also select what ${item.name} should follow: the targets first, ${item.name} last.` : "";
        const make = (type, hint) => ({
            label: `${D.CONSTRAINT_LABELS[type]}`, disabled: !can, title: can ? hint : why,
            run: () => this.previzConstrain(type),
        });
        const entries = [
            make("parent", "Moves and turns with the targets as if it hung under them"),
            make("point", "Its position follows the targets"),
            make("orient", "Its rotation follows the targets"),
            make("aim", "Stays where it is and turns to look at the targets (a camera along its -Z, others +Z; up +Y)"),
            make("scale", "Its scale follows the targets"),
            { label: (keep ? "✓ " : "") + "Maintain offset",
              title: "On: the item stays where it is when constrained and follows from there. Off: it snaps onto the targets.",
              run: () => this.previzSetConstraintKeepOffset(!keep) },
            "-",
            { label: "Select targets", disabled: !(item && item.constraints && item.constraints.length),
              run: () => this.previzSelectConstraintTargets() },
            { label: "Bake constraints", disabled: !constrained.length,
              title: constrained.length ? "Key the constrained channels on every frame of the shot and take the constraints off"
                  : "Select an item that has a constraint.",
              run: () => this.previzBakeConstraints() },
            { label: "Remove constraints", disabled: !constrained.length,
              title: constrained.length ? "" : "Select an item that has a constraint.",
              run: () => this.previzRemoveConstraint(null) },
        ];
        const a = anchor.getBoundingClientRect();
        this._previzOpenMenu(entries, a.left, a.bottom + 2, anchor);
    },

    // ── The Channel Box's CONSTRAINTS section ─────────────────────────────

    /**
     * One block per constraint under the item's channels: its name and kind,
     * an on switch, its own weight and each target's (keyable rows like the
     * transform's), and its settings. `numberRow` is the box's own row maker.
     */
    _cbConstraintRows(ui, item, doc, numberRow) {
        const list = item && item.constraints;
        if (!list || !list.length) return;
        const scene = this.previzScene();
        const root = ui.root;
        root.append(Object.assign(doc.createElement("div"), { className: "cb-section", textContent: "CONSTRAINTS" }));
        for (const c of list) {
            const head = doc.createElement("div");
            head.className = "cb-shape cb-constraint";
            head.dataset.constraint = c.id;
            const name = Object.assign(doc.createElement("span"), {
                className: "cb-cname", textContent: `${c.name} (${D.CONSTRAINT_LABELS[c.type]})`,
            });
            const on = doc.createElement("input");
            on.type = "checkbox";
            on.className = "cb-con-on";
            on.checked = c.on;
            on.title = "On: the constraint moves the item. Off: the item's own channels do.";
            on.onchange = () => this.previzSetConstraintOn(item.id, c.id, on.checked);
            const btn = (text, title, run) => {
                const b = Object.assign(doc.createElement("button"), { className: "cb-con-btn", textContent: text, title });
                b.onclick = run;
                return b;
            };
            head.append(on, name,
                btn("⌖", "Select its targets", () => this.previzSelectConstraintTargets(item.id, c.id)),
                btn("↺", "Update offset: follow from where the item is now", () => this.previzConstraintUpdateOffsets(item.id, c.id)),
                btn("✕", "Remove this constraint", () => this.previzRemoveConstraint(item.id, c.id)));
            root.append(head);
            const t = doc.createElement("div");
            t.className = "cb-table";
            root.append(t);
            numberRow(D.envelopeProp(c.id), D.envelopeProp(c.id), null, "Weight", 0.05, t);
            for (const tg of c.targets) {
                const tname = (S.itemById(scene, tg.id) || {}).name || tg.id;
                numberRow(D.weightProp(c.id, tg.id), D.weightProp(c.id, tg.id), null, `${tname} W`, 0.05, t);
            }
            // Skip axes: one row per channel kind it writes.
            for (const k of D.CONSTRAINT_CHANNELS[c.type]) {
                const row = doc.createElement("div");
                row.className = "cb-row cb-skip";
                row.append(Object.assign(doc.createElement("span"), {
                    className: "cb-label", textContent: `Skip ${{ t: "translate", r: "rotate", s: "scale" }[k]}`,
                }));
                const box = doc.createElement("span");
                box.className = "cb-val cb-axes";
                ["X", "Y", "Z"].forEach((ax, a) => {
                    const l = doc.createElement("label");
                    const cb = doc.createElement("input");
                    cb.type = "checkbox";
                    cb.checked = c.skip[k].includes(a);
                    cb.dataset.skip = `${k}${a}`;
                    cb.onchange = () => {
                        const now = new Set(c.skip[k]);
                        if (cb.checked) now.add(a); else now.delete(a);
                        this.previzEditConstraint(item.id, c.id, { skip: { [k]: [...now] } });
                    };
                    l.append(cb, doc.createTextNode(ax));
                    box.append(l);
                });
                row.append(box);
                t.append(row);
            }
            if (c.type === "aim") this._cbAimRows(t, item, c, doc, scene);
        }
    },

    _cbAimRows(t, item, c, doc, scene) {
        const select = (label, field, options, value, onChange) => {
            const row = doc.createElement("div");
            row.className = "cb-row";
            row.append(Object.assign(doc.createElement("span"), { className: "cb-label", textContent: label }));
            const sel = doc.createElement("select");
            sel.className = "cb-val cb-sel";
            sel.dataset.aim = field;
            for (const [v, text] of options) sel.append(Object.assign(doc.createElement("option"), { value: v, textContent: text }));
            sel.value = value;
            sel.onchange = () => onChange(sel.value);
            row.append(sel);
            t.append(row);
            return sel;
        };
        const axes = Object.keys(D.AXES).map((k) => [k, k]);
        select("Aim axis", "aimAxis", axes, D.axisName(c.aim.aimAxis) || "+Z",
            (v) => this.previzEditConstraint(item.id, c.id, { aim: { aimAxis: D.AXES[v] } }));
        select("Up axis", "upAxis", axes, D.axisName(c.aim.upAxis) || "+Y",
            (v) => this.previzEditConstraint(item.id, c.id, { aim: { upAxis: D.AXES[v] } }));
        select("World up", "upType", D.AIM_UP_TYPES.map((u) => [u, D.AIM_UP_LABELS[u]]), c.aim.upType,
            (v) => this.previzEditConstraint(item.id, c.id, { aim: { upType: v } }));
        if (c.aim.upType === "vector" || c.aim.upType === "objectrotation") {
            select("Up vector", "upVector", axes, D.axisName(c.aim.upVector) || "+Y",
                (v) => this.previzEditConstraint(item.id, c.id, { aim: { upVector: D.AXES[v] } }));
        }
        if (c.aim.upType === "object" || c.aim.upType === "objectrotation") {
            const opts = [["", "—"]];
            for (const it of scene.items || []) {
                if (it.id === item.id || C.cannotConstrain(scene, item.id, it.id)) continue;
                opts.push([it.id, it.name]);
            }
            select("Up object", "upObject", opts, c.aim.upObject || "",
                (v) => this.previzEditConstraint(item.id, c.id, { aim: { upObject: v || null } }));
        }
    },

    /** What decides the Channel Box's constraint rows (not their values). */
    _cbConstraintSig(item) {
        const list = item && item.constraints;
        if (!list || !list.length) return "";
        return JSON.stringify(list.map((c) => [c.id, c.name, c.on, c.skip, c.aim && [c.aim.aimAxis, c.aim.upAxis, c.aim.upType,
            c.aim.upVector, c.aim.upObject], c.targets.map((t) => t.id)]));
    },

    /** Channel rows a constraint drives are tinted, as Maya colours them. */
    _cbConstraintTint(ui, item) {
        const ch = D.constrainedChannels(item);
        const map = { position: "t", rotation: "r", scale: "s" };
        for (const [, r] of ui.rows) {
            if (r.kind !== "number") continue;
            const k = map[r.prop];
            r.row.classList.toggle("constrained", !!(k && r.comp !== null && ch.has(`${k}${r.comp}`)));
        }
    },

    /** The weight channels for the curve editor's list. */
    _previzConstraintCurveChannels(item) {
        const scene = this.previzScene();
        const nameOf = (id) => (S.itemById(scene, id) || {}).name || id;
        return D.weightChannels(item, nameOf).map((w, i) => ({
            key: w.prop, prop: w.prop, axis: 0, label: w.label,
            color: ["#e0a0ff", "#ffb070", "#70e0ff", "#b0ff70", "#ff7090"][i % 5],
        }));
    },

    _cbConstraintFmt: fmt,
};
