// imageViewer_animLayersInstance.js
// One Anim Layers panel: the scene's animation layers, top of the stack first and the base at the bottom, as
// an animator's layer editor lays them out. The maths is imageViewer_animLayers.js; this is the panel and the
// edits (each one undo step, taken by the viewer's previzLayer* functions).
//
// The panel comes in instances: the first one is the markup in imageViewer.html and keeps its state on the
// viewer (st === viewer, so this._alUI stays where every older caller reads it); every further one is made
// here with a state object of its own. The dock registers the maker (AnimLayersMixin._alRegisterMaker) and
// places the element.
//
// The stack itself is the TAB's scene (scene.animLayers, scene.activeLayer), shared by every instance: they
// all show the same layers and edit the same ones. What is an instance's own is its view of them — the rows
// it has built, the signature they were built from, and where its list is scrolled to.
//
// A row: the layer's name (double-click renames), its mode (A additive / O override, a click switches), its
// weight (slider and number; the diamond keys it at the playhead, so a layer can fade in and out), and Mute,
// Solo, Lock. Clicking a row makes it the ACTIVE layer: every key the gizmo, the Channel Box, the key bar, the
// Rig menu and the Curve Editor set or show is on that layer from then on.
import * as L from "./imageViewer_animLayers.js";

/**
 * Make an Anim Layers panel in `host`. `st` holds what this panel keeps of its own (the viewer itself for the
 * first one, a fresh object for every further one); `saved` is what a layout carried for it, if anything.
 * Returns the instance the dock keeps: { el, build, refresh, refreshValues, wake, save }.
 */
export function createAnimLayersInstance(v, host, st, saved) {
    // Kept in state, not read off the element when saving: the dock takes an element out of the document
    // before it asks what the panel held, and a detached list has no scroll position left to read.
    st._alScroll = (saved && Number.isFinite(saved.scroll)) ? saved.scroll : (st._alScroll || 0);
    let wantScroll = st._alScroll || null;
    build();

    /** The body, as classes only (an instance must not repeat the markup's ids). */
    function build() {
        const doc = host.ownerDocument;
        host.querySelectorAll(":scope > .al-body").forEach((n) => n.remove());
        const root = doc.createElement("div");
        root.className = "al-body";
        const bar = doc.createElement("div");
        bar.className = "al-bar";
        const btn = (text, title, run, cls = "") => {
            const b = doc.createElement("button");
            b.className = `previz-btn al-btn ${cls}`.trim();
            b.textContent = text;
            b.title = title;
            b.onclick = (e) => { e.stopPropagation(); run(e); };
            bar.append(b);
            return b;
        };
        btn("+ Add", "New additive layer: its keys are added on top of what is below (offsets)",
            () => v.previzLayerAdd({ mode: "additive" }), "al-add");
        btn("+ Over", "New override layer: its keys replace what is below, by the layer's weight",
            () => v.previzLayerAdd({ mode: "override", name: "Override" }), "al-addover");
        btn("Extract", "Move the selected items' keys on the active layer to a new layer above it",
            () => v.previzLayerExtract(), "al-extract");
        btn("Merge", "Merge the active layer into the layer under it (bakes what the two show together)",
            () => v.previzLayerMergeDown(), "al-merge");
        const up = btn("▲", "Move the active layer up", () => v._alMoveActive(1), "al-up");
        const down = btn("▼", "Move the active layer down", () => v._alMoveActive(-1), "al-down");
        const del = btn("✕", "Delete the active layer and its keys", () => {
            const id = v.previzScene() && v.previzScene().activeLayer;
            if (id) v.previzLayerRemove(id);
        }, "al-del");
        const list = doc.createElement("div");
        list.className = "al-list";
        list.addEventListener("scroll", () => { st._alScroll = list.scrollTop; }, { passive: true });
        root.append(bar, list);
        host.appendChild(root);
        st._alUI = { root, list, up, down, del, sig: "", rows: new Map() };
        wantScroll = st._alScroll || null;
        return st._alUI;
    }

    // A root that is merely out of the document (a place being made) is still this panel's; one that is not
    // under its host any more is a leftover, and is built again.
    const uiNow = () => (st._alUI && st._alUI.root.parentNode === host) ? st._alUI : build();

    /** Draw the panel (rows rebuilt only when the stack's shape changes). */
    function refresh() {
        if (v.isPrevizTab && !v.isPrevizTab()) return;
        const ui = uiNow();
        if (!ui) return;
        const scene = v.previzScene();
        const layers = (scene && scene.animLayers) || [];
        const sig = layers.map((l) => `${l.id}:${l.name}:${l.mode}:${l.mute}:${l.solo}:${l.lock}`).join("|")
            + `#${(scene && scene.activeLayer) || ""}`;
        if (sig !== ui.sig) {
            const keep = ui.list.scrollTop;   // this panel's own place in the list, not the stack's
            ui.sig = sig;
            buildRows(ui, scene, layers);
            ui.list.scrollTop = keep;
        }
        const active = scene && scene.activeLayer;
        const i = layers.findIndex((l) => l.id === active);
        ui.up.disabled = i < 0 || i === layers.length - 1;
        ui.down.disabled = i <= 0;
        ui.del.disabled = i < 0;
        refreshValues();
        applyScroll(ui);
    }

    /** A kept place in the list is taken once the panel is laid out: a remade one is placed after its maker. */
    function applyScroll(ui) {
        if (wantScroll == null) return;
        if (!ui.list.clientHeight) {
            Promise.resolve().then(() => {
                const u = st._alUI;
                if (wantScroll == null || !u || u.root.parentNode !== host || !u.list.clientHeight) return;
                u.list.scrollTop = wantScroll;
                wantScroll = null;
            });
            return;
        }
        ui.list.scrollTop = wantScroll;
        wantScroll = null;
    }

    function buildRows(ui, scene, layers) {
        const doc = ui.list.ownerDocument;
        ui.list.innerHTML = "";
        ui.rows = new Map();
        const active = (scene && scene.activeLayer) || null;
        const solo = layers.some((l) => l.solo && !l.mute);
        const toggle = (label, title, on, run, cls) => {
            const b = doc.createElement("button");
            b.className = `al-tog ${cls}` + (on ? " on" : "");
            b.textContent = label;
            b.title = title;
            b.onclick = (e) => { e.stopPropagation(); run(); };
            return b;
        };
        // Top of the stack first, as a layer editor reads.
        for (const layer of [...layers].reverse()) {
            const row = doc.createElement("div");
            row.className = "al-row" + (layer.id === active ? " active" : "")
                + (layer.mute || (solo && !layer.solo) ? " silent" : "");
            row.dataset.layer = layer.id;
            row.title = L.describeLayer(scene, layer) + (layer.id === active ? " - keys go here" : " - click to key on this layer");
            row.onclick = () => v.previzLayerSetActive(layer.id);
            row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); menu(layer, e); };

            const mode = toggle(layer.mode === "override" ? "O" : "A",
                layer.mode === "override" ? "Override - click for additive" : "Additive - click for override",
                false, () => v.previzLayerSet(layer.id, { mode: layer.mode === "override" ? "additive" : "override" },
                                              { label: "layer mode" }), "al-mode " + layer.mode);
            const name = doc.createElement("span");
            name.className = "al-name";
            name.textContent = layer.name;
            name.ondblclick = (e) => { e.stopPropagation(); rename(layer, name); };

            const slider = doc.createElement("input");
            slider.type = "range"; slider.min = "0"; slider.max = "1"; slider.step = "0.01";
            slider.className = "al-weight";
            slider.title = "Weight";
            slider.onclick = (e) => e.stopPropagation();
            slider.oninput = () => v.previzLayerWeight(layer.id, Number(slider.value), { live: true });
            // The drag's own undo step was taken at its first move.
            slider.onchange = () => { v.previzLayerWeight(layer.id, Number(slider.value)); v.previzEndDrag?.(); };
            const num = doc.createElement("input");
            num.className = "al-wnum";
            num.title = "Weight (0 - 1)";
            num.onclick = (e) => e.stopPropagation();
            num.onchange = () => {
                const w = Number(num.value);
                if (Number.isFinite(w)) v.previzLayerWeight(layer.id, Math.max(0, Math.min(1, w)));
            };
            const key = doc.createElement("button");
            key.className = "al-key";
            key.textContent = "◆";
            key.onclick = (e) => { e.stopPropagation(); v.previzLayerKeyWeight(layer.id); };

            const m = toggle("M", "Mute: the layer counts for nothing", layer.mute,
                () => v.previzLayerSet(layer.id, { mute: !layer.mute }, { label: "mute layer" }), "al-mute");
            const s = toggle("S", "Solo: only soloed layers (and the base) play", layer.solo,
                () => v.previzLayerSet(layer.id, { solo: !layer.solo }, { label: "solo layer" }), "al-solo");
            const l = toggle("L", "Lock: the layer takes no keys", layer.lock,
                () => v.previzLayerSet(layer.id, { lock: !layer.lock }, { label: "lock layer" }), "al-lock");
            row.append(mode, name, slider, num, key, m, s, l);
            ui.list.append(row);
            ui.rows.set(layer.id, { row, slider, num, key });
        }
        const base = doc.createElement("div");
        base.className = "al-row al-base" + (active ? "" : " active");
        base.dataset.layer = "";
        base.title = active ? "The item's own keys - click to key on them" : "The item's own keys - keys go here";
        base.onclick = () => v.previzLayerSetActive(null);
        const bname = doc.createElement("span");
        bname.className = "al-name";
        bname.textContent = "BaseAnimation";
        base.append(Object.assign(doc.createElement("span"), { className: "al-mode base", textContent: "–" }), bname);
        ui.list.append(base);
        if (!layers.length) {
            ui.list.append(Object.assign(doc.createElement("div"), {
                className: "al-empty",
                textContent: "No layers yet. Add one to key changes on top of the animation without touching its keys.",
            }));
        }
    }

    /** The weights and key diamonds as they stand at the playhead (cheap; every frame). */
    function refreshValues() {
        const ui = st._alUI;
        if (!ui || ui.root.parentNode !== host) return;
        const scene = v.previzScene();
        const f = Math.round(v.currentFrame || 0);
        for (const layer of (scene && scene.animLayers) || []) {
            const r = ui.rows.get(layer.id);
            if (!r) continue;
            const w = L.layerWeightAt(layer, f);
            const focused = r.num.ownerDocument.activeElement;
            if (focused !== r.slider) r.slider.value = String(w);
            if (focused !== r.num) r.num.value = String(Math.round(w * 100) / 100);
            const keys = (layer.tracks && layer.tracks.weight) || [];
            r.key.classList.toggle("keyed", keys.length > 0);
            r.key.classList.toggle("now", keys.some((k) => k.f === f));
            r.key.title = keys.length ? (keys.some((k) => k.f === f) ? "Remove the weight key here" : "Key the weight here")
                : "Key the weight here (the weight then animates)";
        }
        applyScroll(ui);
    }

    function rename(layer, nameEl) {
        const doc = nameEl.ownerDocument;
        const input = doc.createElement("input");
        input.className = "al-rename";
        input.value = layer.name;
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            if (ok && input.value.trim() && input.value.trim() !== layer.name) {
                v.previzLayerSet(layer.id, { name: input.value.trim() }, { label: "rename layer" });
            } else {
                input.replaceWith(nameEl);
            }
        };
        input.onkeydown = (e) => {
            e.stopPropagation();
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") finish(false);
        };
        input.onclick = (e) => e.stopPropagation();
        input.onblur = () => finish(true);
    }

    function menu(layer, e) {
        const scene = v.previzScene();
        const members = L.layerMembers(scene, layer.id);
        v._previzOpenMenu([
            { label: "Make active", run: () => v.previzLayerSetActive(layer.id) },
            { label: `Select its items (${members.length})`, disabled: !members.length,
              title: "Nothing is keyed on this layer yet.",
              run: () => { members.forEach((it, i) => v.previzSelect(it.id, { add: i > 0 })); } },
            "-",
            { label: layer.mode === "override" ? "Make additive" : "Make override",
              run: () => v.previzLayerSet(layer.id, { mode: layer.mode === "override" ? "additive" : "override" }, { label: "layer mode" }) },
            { label: "Merge down", run: () => v.previzLayerMergeDown(layer.id) },
            { label: "Move up", run: () => v.previzLayerMove(layer.id, 1) },
            { label: "Move down", run: () => v.previzLayerMove(layer.id, -1) },
            "-",
            { label: "Delete layer", run: () => v.previzLayerRemove(layer.id) },
        ], e.clientX, e.clientY);
    }

    // Drawn straight away: a remade element (a restored layout, the pop-out) is already "shown" to the dock,
    // so no wake is coming to fill it in.
    refresh();

    // No dispose: nothing here ticks or watches, and the state has to stay readable — the dock asks save()
    // for it after the element has gone.
    return {
        el: host,
        build,
        refresh,
        refreshValues,
        wake: refresh,
        save() {
            const ui = st._alUI;
            const now = ui && ui.list.clientHeight ? ui.list.scrollTop : st._alScroll;
            return { scroll: now || 0 };
        },
    };
}