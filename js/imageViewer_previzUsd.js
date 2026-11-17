// imageViewer_previzUsd.js
// The Outliner as the scene's USD graph (PrevizUsdMixin, assigned onto
// PrevizMixin at the end of imageViewer_mixinPreviz.js).
//
// Every row is a prim of the saved scene (its path in the row's tooltip), and
// a model's row unfolds into "Contents": the prims INSIDE its asset - a USD
// asset's own (asked of the server, composed, with the edits applied:
// GET /imageviewer/usd_tree), any other file's node tree as the page loaded
// it. A Contents row can be hidden (its eye), and a prim with variant sets
// shows a picker; both are kept on the item (`item.usd`, imageViewer_usdData.js)
// and saved as overrides in the scene, never in the asset. A model's payload
// can be unloaded (right-click, or the row's menu): it stays in the scene and
// in the file, and draws nothing until loaded again.
import { api } from "../../scripts/api.js";
import * as S from "./imageViewer_scene3d.js";
import * as U from "./imageViewer_usdData.js";
import { matchRange } from "./imageViewer_outlinerData.js";
import { outlinerIcon } from "./imageViewer_outlinerIcons.js";

const TREE_TTL_MS = 30000;

export const PrevizUsdMixin = {
    // ── what is inside a model ───────────────────────────────────────────────

    /** The prims inside a model's asset: [{rel, name, parent, type, variants, visible}] or null (not known yet). */
    previzUsdContents(item) {
        if (!item || item.kind !== "model" || !item.src) return null;
        if (U.isUsdSrc(item.src) && item.src.path) return this._previzUsdTree(item);
        const view = this._model3d;
        return view && view.usdContentsOf ? view.usdContentsOf(item.id) : null;
    },

    /** The variant sets on the asset's root prim, {set: {choices, selection}} (USD assets only). */
    previzUsdRootVariants(item) {
        if (!item || !U.isUsdSrc(item.src) || !item.src.path) return {};
        const key = this._previzUsdTreeKey(item);
        const got = this._usdTrees && this._usdTrees.get(key);
        return (got && got.tree && got.tree.variants) || {};
    },

    _previzUsdTreeKey(item) {
        return `${item.src.path}|${item.src.prim || ""}|${U.editsKey(U.usdEdits(item))}`;
    },

    /** A USD asset's prim tree from the server, cached; the panel redraws when it arrives. */
    _previzUsdTree(item) {
        const trees = this._usdTrees || (this._usdTrees = new Map());
        const key = this._previzUsdTreeKey(item);
        const got = trees.get(key);
        const now = Date.now();
        if (got && (got.pending || now - got.at < TREE_TTL_MS)) return got.tree ? got.tree.prims : null;
        const entry = { pending: true, at: now, tree: got ? got.tree : null };
        trees.set(key, entry);
        if (trees.size > 64) trees.delete(trees.keys().next().value);
        let url = `/imageviewer/usd_tree?path=${encodeURIComponent(item.src.path)}`;
        if (item.src.prim) url += `&prim=${encodeURIComponent(item.src.prim)}`;
        const edits = U.usdEdits(item);
        if (edits) url += `&usd=${encodeURIComponent(U.editsKey(edits))}`;
        fetch(api.apiURL(url)).then((r) => r.json().then((d) => ({ ok: r.ok, d })))
            .then(({ ok, d }) => {
                entry.tree = ok ? d : { prims: [], variants: {}, error: d.error || "could not read the stage" };
            })
            .catch((e) => { entry.tree = { prims: [], variants: {}, error: String(e) }; })
            .finally(() => {
                entry.pending = false;
                entry.at = Date.now();
                if (this._previzRenderPanel) this._previzRenderPanel();
            });
        return entry.tree ? entry.tree.prims : null;
    },

    /** Names inside a model, for the Outliner's search and its fold arrow. */
    previzUsdContentNames(item) {
        const list = this.previzUsdContents(item);
        return list ? list.map((p) => p.name) : [];
    },

    // ── edits ───────────────────────────────────────────────────────────────

    /** Hide / show (or switch off / on) a prim inside a model's asset; one undo step. */
    previzUsdSetOver(itemId, rel, patch) {
        const item = S.itemById(this.previzScene(), itemId);
        if (!item) return;
        this.previzSnapshot(patch && patch.visible === false ? "hide inside asset" : "edit inside asset");
        U.setOver(item, rel, patch);
        this.previzChanged({ reload: true });
    },

    /** Pick a variant of a variant set inside a model's asset ("" = the asset's own pick). */
    previzUsdSetVariant(itemId, rel, set, choice) {
        const item = S.itemById(this.previzScene(), itemId);
        if (!item) return;
        this.previzSnapshot("pick variant");
        U.setVariant(item, rel, set, choice || null);
        this.previzChanged({ reload: true });
    },

    /** Unload (or load again) the payloads of the selected models; one undo step. */
    previzUsdSetUnloaded(ids, unloaded) {
        const scene = this.previzScene();
        const items = (ids || []).map((id) => S.itemById(scene, id)).filter((it) => it && it.kind === "model");
        if (!items.length) return 0;
        this.previzSnapshot(unloaded ? "unload" : "load");
        for (const it of items) U.setUnloaded(it, unloaded);
        this.previzChanged({ reload: true });
        return items.length;
    },

    /** The row menu's entries for models: Unload / Load. */
    _previzUsdMenuEntries(ids) {
        const scene = this.previzScene();
        const models = ids.map((id) => S.itemById(scene, id)).filter((it) => it && it.kind === "model");
        if (!models.length) return [];
        const anyLoaded = models.some((it) => !U.isUnloaded(it));
        const n = models.length > 1 ? ` ${models.length} models` : "";
        return ["-", anyLoaded
            ? { label: `Unload${n}`, title: "Keep it in the scene and the file, but do not read or draw its mesh",
                run: () => this.previzUsdSetUnloaded(models.map((m) => m.id), true) }
            : { label: `Load${n}`, run: () => this.previzUsdSetUnloaded(models.map((m) => m.id), false) }];
    },

    // ── the rows ────────────────────────────────────────────────────────────

    /** The prim paths every row has in a saved scene (cached per draw). */
    previzUsdPrimPaths(scene) {
        return U.primPaths(scene || this.previzScene());
    },

    /**
     * Under a model in the Outliner: one "Contents" row (folded at first) and the
     * prims inside its asset as a tree, each with its eye and, with variant sets, a picker.
     */
    _previzContentsRows(model, depth, doc, scene, list, needle = "") {
        const prims = this.previzUsdContents(model);
        const usd = U.isUsdSrc(model.src) && !!model.src.path;
        const rootVariants = this.previzUsdRootVariants(model);
        if (U.isUnloaded(model)) return;
        if (!prims || (!prims.length && !Object.keys(rootVariants).length)) return;
        const open = this._previzContentsOpen || (this._previzContentsOpen = new Set());
        const closed = this._previzContentsClosed || (this._previzContentsClosed = new Set());
        const key = `${model.id}:contents`;
        const searching = !!needle && prims.some((p) => matchRange(p.name, needle));
        const isOpen = searching || open.has(key);
        const head = this._previzUsdRow(doc, depth, `Contents (${prims.length} prim${prims.length === 1 ? "" : "s"})`,
            { icon: "contents",
              title: usd ? `The prims of ${model.src.path.split(/[\\/]/).pop()}; changes here are saved as overrides in the scene`
                         : "The model's node tree; hidden nodes are saved as overrides in the scene",
              fold: { open: isOpen, toggle: () => (open.has(key) ? open.delete(key) : open.add(key)) },
              context: searching, onclick: () => this.previzSelect(model.id) });
        // The asset root's variant sets sit on the Contents row itself.
        this._previzUsdVariantPickers(doc, head, model, "", rootVariants);
        list.append(head);
        if (!isOpen) return;
        const rows = U.contentRows(prims, { needle: searching ? needle : "",
                                            isClosed: (rel) => closed.has(`${model.id}:prim:${rel}`) });
        for (const r of rows) {
            const p = r.prim;
            const ck = `${model.id}:prim:${p.rel}`;
            const hidden = U.hiddenByOvers(model, p.rel) || p.visible === false;
            const own = (model.usd && model.usd.overs && model.usd.overs[p.rel]) || {};
            const row = this._previzUsdRow(doc, depth + 1 + r.depth, p.name, {
                icon: /Mesh$/.test(p.type || "") || ["Cube", "Sphere", "Cylinder", "Cone", "Capsule", "Plane"].includes(p.type) ? "mesh" : "group",
                title: `${p.rel}${p.type ? `  (${p.type})` : ""}${(p.arcs || []).length ? `\n${p.arcs.map((a) => `${a.kind}: ${a.asset || "this stage"}`).join("\n")}` : ""}`,
                fold: r.hasKids && { open: r.open, toggle: () => (closed.has(ck) ? closed.delete(ck) : closed.add(ck)) },
                context: r.context, needle: searching ? needle : "", hidden,
                onclick: () => this.previzSelect(model.id),
            });
            row.dataset.rel = p.rel;
            row.dataset.model = model.id;
            this._previzUsdVariantPickers(doc, row, model, p.rel, p.variants || {});
            if ((p.arcs || []).length) {
                const arc = doc.createElement("span");
                arc.className = "ol-arc";
                arc.textContent = p.arcs.some((a) => a.kind === "payload") ? "P" : "R";
                arc.title = p.arcs.map((a) => `${a.kind}: ${a.asset || "this stage"}`).join("\n");
                row.querySelector(".ol-end").prepend(arc);
            }
            const off = own.visible === false;
            const eye = this._olRowBtn(doc, "previz-eye" + (hidden ? " off" : ""), hidden ? "eyeOff" : "eye",
                off ? "Show it again (takes the override off)" : "Hide it (an override in the scene, the asset is not changed)",
                () => this.previzUsdSetOver(model.id, p.rel, { visible: off }));
            row.querySelector(".ol-end").append(eye);
            list.append(row);
        }
    },

    /** One Contents row: indent, arrow, icon, name, and an `.ol-end` for its marks. */
    _previzUsdRow(doc, depth, label, opts = {}) {
        const row = doc.createElement("div");
        row.className = "previz-item previz-prim ol-row" + (opts.context ? " context" : "")
            + (opts.hidden ? " hidden-item" : "");
        row.dataset.kind = "contents";
        const kind = doc.createElement("span");
        kind.className = "ol-kind";
        kind.dataset.kind = "contents";
        kind.append(outlinerIcon(doc, opts.icon || "group"));
        const name = doc.createElement("span");
        name.className = "previz-name";
        this._olName(doc, name, label, opts.needle || "");
        name.title = opts.title || label;
        const end = doc.createElement("span");
        end.className = "ol-end";
        row.append(this._olIndent(doc, depth), this._olTwisty(doc, opts.fold || null), kind, name, end);
        if (opts.onclick) row.onclick = opts.onclick;
        return row;
    },

    /** A select per variant set of the prim at `rel`, into the row's `.ol-end`. */
    _previzUsdVariantPickers(doc, row, model, rel, variants) {
        const end = row.querySelector(".ol-end");
        const mine = (model.usd && model.usd.variants && model.usd.variants[rel]) || {};
        for (const [set, info] of Object.entries(variants || {})) {
            const sel = doc.createElement("select");
            sel.className = "ol-variant";
            sel.title = `Variant set "${set}"`;
            sel.dataset.set = set;
            const choices = (info && info.choices) || [];
            for (const c of choices) {
                const o = doc.createElement("option");
                o.value = c;
                o.textContent = c;
                sel.append(o);
            }
            sel.value = mine[set] || (info && info.selection) || choices[0] || "";
            sel.onclick = (e) => e.stopPropagation();
            sel.onpointerdown = (e) => e.stopPropagation();
            sel.onchange = () => this.previzUsdSetVariant(model.id, rel, set, sel.value);
            end.append(sel);
        }
    },
};
