// imageViewer_previzLayersInstance.js
// One Layers panel and one Character Picker, each as a closure with its own tab, layer/character choice, view
// mode, rename-in-progress and signature cache. The panels come in instances (Sebastian 2026-11-23): the first
// of each keeps the plain id and its state on the viewer (st === viewer, so every older caller of this._plTab /
// this._pkChar / this._plUI still reads and writes it); every further one is made here with a state object of
// its own. The dock registers the makers (PrevizLayersMixin._ensureLayerMakers) and places the element.
//
// The scene and the viewer's selection are SHARED: every mutation goes through the viewer's previz* methods.
// What is independent is only what the panel itself keeps — which tab/layer it shows, which character the
// picker is on, front/side, the rename field, the scroll. An instance must not repeat the markup's ids, so the
// body is built from classes alone (the CSS for .pl-* / .pk-* is already class-based).
import * as S from "./imageViewer_scene3d.js";
import * as L from "./imageViewer_sceneLayers.js";
import { controlsOf } from "./imageViewer_rigData.js";

const TABS = [["display", "Display"], ["sets", "Sets"], ["refs", "References"]];
const MODE_TITLE = {
    normal: "Normal: drawn and picked as usual (click: template)",
    template: "Template: a wire, not pickable, left out of a render (click: reference)",
    reference: "Reference: drawn as it is, not pickable in the view (click: normal)",
};
const NEXT_MODE = { normal: "template", template: "reference", reference: "normal" };

function btn(doc, label, title, run, cls = "") {
    const b = doc.createElement("button");
    b.className = `previz-btn pl-btn ${cls}`.trim();
    b.textContent = label;
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); run(e); };
    return b;
}

/**
 * Make a Layers panel in `host`. `st` holds what this panel keeps of its own (the viewer itself for the first
 * one, a fresh object for every further one); `saved` is what a layout carried for it, if anything.
 * Returns the instance the dock keeps: { el, render, wake, save, dispose }.
 */
export function createLayersInstance(v, host, st, saved) {
    let ui = null;
    if (saved) {
        if (saved.tab) st._plTab = saved.tab;
        if (saved.layerSel) st._plLayerSel = saved.layerSel;
    }
    let pendingScroll = saved && typeof saved.scroll === "number" ? saved.scroll : null;

    function build() {
        const doc = host.ownerDocument;
        host.querySelectorAll(":scope > .pl-body").forEach((n) => n.remove());
        const root = doc.createElement("div");
        root.className = "pl-body";
        const tabs = doc.createElement("div");
        tabs.className = "pl-tabs";
        const tabBtns = new Map();
        for (const [id, label] of TABS) {
            const b = doc.createElement("button");
            b.className = "pl-tab";
            b.dataset.tab = id;
            b.textContent = label;
            b.onclick = () => { st._plTab = id; render(true); };
            tabs.append(b);
            tabBtns.set(id, b);
        }
        const bar = doc.createElement("div");
        bar.className = "pl-bar";
        const list = doc.createElement("div");
        list.className = "pl-list";
        root.append(tabs, bar, list);
        host.appendChild(root);
        ui = { root, bar, list, tabBtns, sig: "" };
        st._plUI = ui;
        return ui;
    }

    function signature(scene) {
        const sel = v.previzSelectedIds().join(",");
        const tab = st._plTab || "display";
        const part = tab === "display" ? JSON.stringify(scene.displayLayers || [])
            : tab === "sets" ? JSON.stringify(scene.selectionSets || [])
            : JSON.stringify((scene.references || []).map((r) => [r.id, r.namespace, r.path, r.follow, r.version, r._error || ""]));
        return `${tab}|${sel}|${st._plLayerSel || ""}|${st._plRenaming ? st._plRenaming.id : ""}|${part}`;
    }

    /** Draw the panel; cheap when nothing it shows has changed (playback comes through here). */
    function render(force = false) {
        if (!ui || !ui.root.isConnected) build();
        const scene = v.previzScene();
        const sig = signature(scene);
        if (!force && sig === ui.sig) return;
        ui.sig = sig;
        const tab = st._plTab || "display";
        for (const [id, b] of ui.tabBtns) b.classList.toggle("active", id === tab);
        ui.bar.innerHTML = "";
        ui.list.innerHTML = "";
        if (tab === "display") drawDisplay(ui, scene);
        else if (tab === "sets") drawSets(ui, scene);
        else drawRefs(ui, scene);
        if (pendingScroll != null) { ui.list.scrollTop = pendingScroll; pendingScroll = null; }
    }

    function empty(ui, text) {
        const d = ui.list.ownerDocument.createElement("div");
        d.className = "previz-empty";
        d.textContent = text;
        ui.list.append(d);
    }

    /** A name that turns into a field on a double-click. */
    function name(doc, kind, id, text, commit) {
        const span = doc.createElement("span");
        span.className = "pl-name";
        if (st._plRenaming && st._plRenaming.kind === kind && st._plRenaming.id === id) {
            const input = doc.createElement("input");
            input.className = "pl-rename";
            input.value = text;
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                st._plRenaming = null;
                if (ok && input.value.trim() && input.value.trim() !== text) commit(input.value.trim());
                else render(true);
            };
            input.onkeydown = (e) => {
                e.stopPropagation();
                if (e.key === "Enter") finish(true);
                else if (e.key === "Escape") finish(false);
            };
            input.onblur = () => finish(true);
            input.onclick = (e) => e.stopPropagation();
            span.append(input);
            (doc.defaultView || window).requestAnimationFrame(() => { input.focus(); input.select(); });
            return span;
        }
        span.textContent = text;
        span.ondblclick = (e) => { e.stopPropagation(); st._plRenaming = { kind, id }; render(true); };
        return span;
    }

    function drawDisplay(ui, scene) {
        const doc = ui.root.ownerDocument;
        const layers = L.displayLayers(scene);
        const sel = v.previzSelectedIds();
        const target = st._plLayerSel && L.layerById(scene, st._plLayerSel);
        ui.bar.append(
            btn(doc, "New layer", "A new display layer holding what is selected", () => {
                const layer = v.previzNewDisplayLayer();
                if (layer) { st._plLayerSel = layer.id; render(true); }
            }),
            btn(doc, "Add", target ? `Put the selection on ${target.name}` : "Pick a layer first, then add the selection to it",
                () => target && v.previzAddToLayer(target.id), target && sel.length ? "" : "off"),
            btn(doc, "Remove", "Take the selection off its layer", () => v.previzRemoveFromLayers(),
                sel.some((id) => L.layerOf(scene, id)) ? "" : "off"),
        );
        if (!layers.length) {
            empty(ui, "No display layers. Select objects and press New layer.");
            return;
        }
        for (const layer of layers) {
            const row = doc.createElement("div");
            row.className = "pl-row" + (layer.id === st._plLayerSel ? " selected" : "") + (layer.ref ? " ref" : "");
            row.dataset.layerId = layer.id;
            const eye = btn(doc, layer.visible ? "V" : "", layer.visible ? "Shown (click to hide)" : "Hidden (click to show)",
                () => v.previzSetLayer(layer.id, { visible: !layer.visible }), "pl-vis" + (layer.visible ? " on" : ""));
            const mode = btn(doc, L.MODE_LABEL[layer.mode], MODE_TITLE[layer.mode],
                () => v.previzSetLayer(layer.id, { mode: NEXT_MODE[layer.mode] }), `pl-mode ${layer.mode}`);
            const swatch = btn(doc, "", "Colour (a template's wire is drawn in it)", (e) => colourMenu(layer, e), "pl-swatch");
            swatch.style.background = layer.color || "transparent";
            const nm = name(doc, "layer", layer.id, layer.name, (val) => v.previzSetLayer(layer.id, { name: val }));
            const count = doc.createElement("span");
            count.className = "pl-count";
            count.textContent = String(layer.members.length);
            row.append(eye, mode, swatch, nm, count);
            row.onclick = (e) => {
                st._plLayerSel = layer.id;
                if (e.shiftKey || e.ctrlKey || e.metaKey) v.previzSelectLayer(layer.id, { add: true });
                else render(true);
            };
            row.oncontextmenu = (e) => layerMenu(layer, e);
            ui.list.append(row);
        }
    }

    function colourMenu(layer, e) {
        const r = e.currentTarget.getBoundingClientRect();
        const entries = L.LAYER_COLORS.map((c) => ({
            label: `${layer.color === c ? "✓ " : ""}■ ${c}`, run: () => v.previzSetLayer(layer.id, { color: c }),
        }));
        entries.push("-", { label: `${layer.color ? "" : "✓ "}No colour`, run: () => v.previzSetLayer(layer.id, { color: null }) });
        const menu = v._previzOpenMenu(entries, r.left, r.bottom + 2, e.currentTarget);
        if (menu) [...menu.querySelectorAll(".previz-menu-item")].slice(0, L.LAYER_COLORS.length)
            .forEach((b, i) => { b.style.color = L.LAYER_COLORS[i]; });
    }

    function layerMenu(layer, e) {
        e.preventDefault();
        e.stopPropagation();
        st._plLayerSel = layer.id;
        const sel = v.previzSelectedIds();
        v._previzOpenMenu([
            { label: "Add selected objects", disabled: !sel.length, run: () => v.previzAddToLayer(layer.id) },
            { label: "Remove selected objects", disabled: !sel.some((id) => layer.members.includes(id)),
              run: () => v.previzRemoveFromLayers(sel.filter((id) => layer.members.includes(id))) },
            { label: "Select objects", disabled: !layer.members.length, run: () => v.previzSelectLayer(layer.id) },
            "-",
            { label: "Rename", run: () => { st._plRenaming = { kind: "layer", id: layer.id }; render(true); } },
            { label: "Move up", run: () => v.previzMoveLayer(layer.id, -1) },
            { label: "Move down", run: () => v.previzMoveLayer(layer.id, 1) },
            "-",
            { label: "Delete layer", title: "The objects stay; only the layer goes", run: () => v.previzDeleteLayer(layer.id) },
        ], e.clientX, e.clientY);
    }

    function drawSets(ui, scene) {
        const doc = ui.root.ownerDocument;
        const sets = L.selectionSets(scene);
        const sel = v.previzSelectedIds();
        ui.bar.append(btn(doc, "New set", "A selection set of what is selected",
            () => v.previzNewSelectionSet(), sel.length ? "" : "off"));
        if (!sets.length) {
            empty(ui, "No selection sets. Select controls or objects and press New set.");
            return;
        }
        const now = new Set(sel);
        for (const set of sets) {
            const row = doc.createElement("div");
            const all = set.members.length && set.members.every((id) => now.has(id));
            row.className = "pl-row" + (all ? " selected" : "") + (set.ref ? " ref" : "");
            row.dataset.setId = set.id;
            const nm = name(doc, "set", set.id, set.name, (val) => v.previzRenameSet(set.id, val));
            const count = doc.createElement("span");
            count.className = "pl-count";
            count.textContent = String(set.members.length);
            row.append(nm, count);
            row.title = "Click: select the set. Shift / Ctrl: add it to the selection. Double-click the name to rename.";
            row.onclick = (e) => v.previzSelectSet(set.id, { add: e.shiftKey || e.ctrlKey || e.metaKey });
            row.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const s = v.previzSelectedIds();
                v._previzOpenMenu([
                    { label: "Select", run: () => v.previzSelectSet(set.id) },
                    { label: "Add selected", disabled: !s.length, run: () => v.previzAddToSet(set.id) },
                    { label: "Remove selected", disabled: !s.some((id) => set.members.includes(id)), run: () => v.previzRemoveFromSet(set.id) },
                    "-",
                    { label: "Rename", run: () => { st._plRenaming = { kind: "set", id: set.id }; render(true); } },
                    { label: "Delete set", title: "The objects stay; only the set goes", run: () => v.previzDeleteSet(set.id) },
                ], e.clientX, e.clientY);
            };
            ui.list.append(row);
        }
    }

    function drawRefs(ui, scene) {
        const doc = ui.root.ownerDocument;
        const refs = L.references(scene);
        ui.bar.append(
            btn(doc, "Reference…", "Bring a saved scene (a character, a set) in, linked to its file",
                () => v.previzReferenceDialog()),
            btn(doc, "Check for updates", "Read every reference's file again and pick up newer versions",
                () => v.previzCheckReferences(), refs.length ? "" : "off"),
        );
        if (!refs.length) {
            empty(ui, "No references. Save a character as a scene, then Reference… it into each shot.");
            return;
        }
        for (const ref of refs) {
            const row = doc.createElement("div");
            row.className = "pl-row pl-refrow" + (ref._error ? " failed" : "");
            row.dataset.refId = ref.id;
            const nm = name(doc, "ref", ref.id, ref.namespace, (val) => v.previzRenameNamespace(ref.id, val));
            const file = doc.createElement("span");
            file.className = "pl-file";
            file.textContent = String(ref.path).split(/[\\/]/).pop();
            file.title = ref._error ? `Could not be read: ${ref._error}\n${ref.path}` : ref.path;
            const follow = btn(doc, ref.follow === "pinned" ? "pinned" : "latest",
                ref.follow === "pinned" ? "Stays on this version (click: follow the newest version)"
                                        : "Follows the newest version of the file (click: stay on this one)",
                () => v.previzSetReferenceFollow(ref.id, ref.follow === "pinned" ? "latest" : "pinned"),
                `pl-follow ${ref.follow}`);
            const reload = btn(doc, "↻", "Reload from the file now", () => v.previzReloadReference(ref.id, { force: true }));
            row.append(nm, file, follow, reload);
            row.onclick = () => v.previzSelectReference(ref.id);
            row.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                v._previzOpenMenu([
                    { label: "Select its objects", run: () => v.previzSelectReference(ref.id) },
                    { label: "Reload", run: () => v.previzReloadReference(ref.id, { force: true }) },
                    { label: "Rename namespace", run: () => { st._plRenaming = { kind: "ref", id: ref.id }; render(true); } },
                    { label: ref.follow === "pinned" ? "Follow the latest version" : "Pin this version",
                      run: () => v.previzSetReferenceFollow(ref.id, ref.follow === "pinned" ? "latest" : "pinned") },
                    { label: "Reference it again", title: "A second copy under a namespace of its own",
                      run: () => v.previzReferenceScene(ref.path, { follow: ref.follow }) },
                    "-",
                    { label: "Remove reference", title: "Takes out everything it brought in, with the shot's keys on it",
                      run: () => v.previzRemoveReference(ref.id) },
                ], e.clientX, e.clientY);
            };
            ui.list.append(row);
        }
    }

    build();
    return {
        el: host,
        get ui() { return ui; },
        render,
        wake() { if (v.isPrevizTab && v.isPrevizTab()) render(true); },
        save() {
            return { tab: st._plTab || null, layerSel: st._plLayerSel || null,
                     scroll: ui ? ui.list.scrollTop : 0 };
        },
        dispose() { st._plRenaming = null; },
    };
}

/**
 * Make a Character Picker in `host`. Same split as the Layers panel: the scene and selection are the viewer's,
 * the character shown, front/side and the signature cache are this instance's (`st`).
 */
export function createPickerInstance(v, host, st, saved) {
    let ui = null;
    let offMarquee = null;
    if (saved) {
        if (saved.char) st._pkChar = saved.char;
        if (saved.view) st._pkView = saved.view;
        if (saved.follow !== undefined) st._pkFollow = saved.follow;
    }

    /** The character the picker shows: the chosen one, else the selection's, else the first. */
    function character() {
        const scene = v.previzScene();
        const chars = v.previzCharacters();
        if (!chars.length) return null;
        const sel = v.previzSelectedItem();
        const ofSel = sel ? (sel.kind === "model" ? sel.id : sel.control ? sel.control.model : null) : null;
        if (ofSel && chars.some((c) => c.id === ofSel) && st._pkFollow !== false) st._pkChar = ofSel;
        if (!st._pkChar || !S.itemById(scene, st._pkChar)) st._pkChar = chars[0].id;
        return S.itemById(scene, st._pkChar);
    }

    function build() {
        const doc = host.ownerDocument;
        host.querySelectorAll(":scope > .pk-body").forEach((n) => n.remove());
        const root = doc.createElement("div");
        root.className = "pk-body";
        const head = doc.createElement("div");
        head.className = "pk-head";
        const charSel = doc.createElement("select");
        charSel.className = "previz-sel pk-char";
        charSel.title = "Which character";
        charSel.onchange = () => { st._pkChar = charSel.value; render(true); };
        const front = btn(doc, "Front", "Seen from the front", () => { st._pkView = "front"; render(true); }, "pk-front");
        const side = btn(doc, "Side", "Seen from its left", () => { st._pkView = "side"; render(true); }, "pk-side");
        const all = btn(doc, "All", "Select every control of the character (Shift adds)", (e) => {
            const ch = character();
            if (ch) v.previzSelectIds(controlsOf(v.previzScene(), ch.id).map((c) => c.id), { add: e.shiftKey });
        }, "pk-all");
        head.append(charSel, front, side, all);
        const wrap = doc.createElement("div");
        wrap.className = "pk-wrap";
        const stage = doc.createElement("div");
        stage.className = "pk-stage";
        wrap.append(stage);
        const sets = doc.createElement("div");
        sets.className = "pk-sets";
        root.append(head, wrap, sets);
        host.appendChild(root);
        ui = { root, charSel, front, side, wrap, stage, sets, sig: "", buttons: new Map() };
        st._pkUI = ui;
        wireMarquee(ui);
        return ui;
    }

    function render(force = false) {
        if (!ui || !ui.root.isConnected) build();
        const scene = v.previzScene();
        const ch = character();
        const chars = v.previzCharacters();
        const view = st._pkView || "front";
        const ctrls = ch ? controlsOf(scene, ch.id) : [];
        const shape = `${chars.map((c) => `${c.id}:${c.name}`).join(",")}|${ch ? ch.id : ""}|${view}|`
                    + `${ctrls.map((c) => c.id).join(",")}|${JSON.stringify(scene.selectionSets || [])}`;
        if (force || shape !== ui.sig) {
            ui.sig = shape;
            draw(ui, scene, ch, chars, view, ctrls);
        }
        // The selection only lights buttons; it never rebuilds them.
        const sel = new Set(v.previzSelectedIds());
        for (const [id, b] of ui.buttons) b.classList.toggle("on", sel.has(id));
        // A limb's unused side (its FK controls while on IK, its IK and pole
        // while on FK) is dimmed, as the view hides it; the switch says which.
        const view3 = v._modelView && v._modelView();
        const idle = ch && view3 && view3.rigIdleControls ? view3.rigIdleControls(ch.id) : new Set();
        for (const [id, b] of ui.buttons) b.classList.toggle("idle", idle.has(id));
        const frame = Math.round(v.currentFrame || 0);
        for (const [ikId, el] of ui.limbs || []) {
            const ik = S.itemById(scene, ikId);
            if (!ik) continue;
            const blend = view3 && view3._rigIkBlend ? view3._rigIkBlend(ik, frame)
                : Number(S.currentValue(scene, ik, "ikfk", frame) ?? 1);
            const mode = blend >= 0.5 ? "IK" : "FK";
            if (el.textContent !== mode) el.textContent = mode;
            el.classList.toggle("fk", mode === "FK");
            el.title = `${(ik.control && ik.control.role) || ik.name} is on ${mode}`
                     + (blend > 0 && blend < 1 ? ` (${Math.round(blend * 100)} % IK)` : "")
                     + `: click to switch it to ${mode === "IK" ? "FK" : "IK"} without a jump`;
        }
        for (const b of ui.sets.querySelectorAll(".pk-set")) {
            const set = L.setById(scene, b.dataset.setId);
            b.classList.toggle("on", !!(set && set.members.length && set.members.every((id) => sel.has(id))));
        }
    }

    function draw(ui, scene, ch, chars, view, ctrls) {
        const doc = ui.root.ownerDocument;
        ui.charSel.innerHTML = "";
        for (const c of chars) {
            const o = doc.createElement("option");
            o.value = c.id;
            o.textContent = c.name;
            ui.charSel.append(o);
        }
        ui.charSel.style.display = chars.length > 1 ? "" : "none";
        if (ch) ui.charSel.value = ch.id;
        ui.front.classList.toggle("active", view === "front");
        ui.side.classList.toggle("active", view === "side");
        ui.stage.innerHTML = "";
        ui.sets.innerHTML = "";
        ui.buttons.clear();
        if (!ch) {
            ui.stage.style.aspectRatio = "";
            const d = doc.createElement("div");
            d.className = "previz-empty";
            d.textContent = "No rigged character. Rig › Add controls on a character, and its picker is here.";
            ui.stage.append(d);
            return;
        }
        const lay = L.pickerLayout(scene, ch.id, view);
        ui.stage.style.aspectRatio = String(Math.max(0.2, Math.min(5, lay.aspect)));
        const COLOR = { L: "#4aa3ff", R: "#ff5a5a", C: "#ffd24d" };
        // Big ones first, so the small ones lie on top and can be hit.
        for (const b of [...lay.buttons].sort((x, y) => y.r - x.r)) {
            const el = doc.createElement("button");
            el.className = `pk-btn ${b.type}`;
            el.dataset.id = b.id;
            el.title = b.name + (b.role ? ` (${b.role})` : "");
            el.style.left = `${b.x * 100}%`;
            el.style.top = `${b.y * 100}%`;
            el.style.width = el.style.height = `${b.r * 200}%`;
            if (b.type === "root") { el.style.width = `${b.r * 400}%`; el.style.height = `${b.r * 60}%`; }
            if (b.type === "cog") { el.style.width = `${b.r * 300}%`; el.style.height = `${b.r * 90}%`; }
            el.style.setProperty("--pk", COLOR[b.side] || b.color);
            el.onpointerdown = (e) => e.stopPropagation();
            el.onclick = (e) => {
                e.stopPropagation();
                const add = e.shiftKey || e.ctrlKey || e.metaKey;
                if (add) v.previzSelect(b.id, { add: true });
                else v.previzSelect(b.id);
            };
            ui.stage.append(el);
            ui.buttons.set(b.id, el);
        }
        // Each limb's IK / FK switch: what it shows is set by render, every frame.
        ui.limbs = new Map();
        for (const l of lay.limbs || []) {
            const el = doc.createElement("button");
            el.className = "pk-ikfk";
            el.dataset.ik = l.ik;
            el.style.left = `${l.x * 100}%`;
            el.style.top = `${l.y * 100}%`;
            el.style.setProperty("--pk", COLOR[l.side] || "#ffd24d");
            el.onpointerdown = (e) => e.stopPropagation();
            el.onclick = (e) => { e.stopPropagation(); v.previzRigSwitchIkFk && v.previzRigSwitchIkFk(l.ik); };
            ui.stage.append(el);
            ui.limbs.set(l.ik, el);
        }
        const mine = new Set([ch.id, ...ctrls.map((c) => c.id)]);
        for (const set of L.setsWithin(scene, [...mine])) {
            const el = doc.createElement("button");
            el.className = "previz-btn pk-set";
            el.dataset.setId = set.id;
            el.textContent = set.name.replace(/^[^:]*:/, "");
            el.title = `${set.name}: ${set.members.length} - Shift adds`;
            el.onclick = (e) => v.previzSelectSet(set.id, { add: e.shiftKey || e.ctrlKey || e.metaKey });
            ui.sets.append(el);
        }
        const add = btn(doc, "+ Set", "A selection set of what is selected, shown here as a button",
            () => v.previzNewSelectionSet(), "pk-newset");
        ui.sets.append(add);
    }

    /** A drag on the picker's background selects the buttons inside the box. */
    function wireMarquee(ui) {
        const stage = ui.stage;
        stage.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || e.target.closest(".pk-btn")) return;
            const doc = stage.ownerDocument;
            const r0 = stage.getBoundingClientRect();
            const box = doc.createElement("div");
            box.className = "pk-marquee";
            stage.append(box);
            const x0 = e.clientX, y0 = e.clientY;
            const add = e.shiftKey || e.ctrlKey || e.metaKey;
            const place = (x1, y1) => {
                box.style.left = `${Math.min(x0, x1) - r0.left}px`;
                box.style.top = `${Math.min(y0, y1) - r0.top}px`;
                box.style.width = `${Math.abs(x1 - x0)}px`;
                box.style.height = `${Math.abs(y1 - y0)}px`;
            };
            place(x0, y0);
            const move = (ev) => place(ev.clientX, ev.clientY);
            const up = (ev) => {
                offMarquee = null;
                doc.removeEventListener("pointermove", move, true);
                doc.removeEventListener("pointerup", up, true);
                const a = { l: Math.min(x0, ev.clientX), r: Math.max(x0, ev.clientX), t: Math.min(y0, ev.clientY), b: Math.max(y0, ev.clientY) };
                box.remove();
                if (a.r - a.l < 3 && a.b - a.t < 3) { if (!add) v.previzSelect(null); return; }
                const hit = [];
                for (const [id, el] of ui.buttons) {
                    const br = el.getBoundingClientRect();
                    const cx = (br.left + br.right) / 2, cy = (br.top + br.bottom) / 2;
                    if (cx >= a.l && cx <= a.r && cy >= a.t && cy <= a.b) hit.push(id);
                }
                v.previzSelectIds(hit, { add });
            };
            doc.addEventListener("pointermove", move, true);
            doc.addEventListener("pointerup", up, true);
            offMarquee = () => {
                doc.removeEventListener("pointermove", move, true);
                doc.removeEventListener("pointerup", up, true);
                box.remove();
            };
            e.preventDefault();
        });
    }

    build();
    return {
        el: host,
        get ui() { return ui; },
        render,
        wake() { if (v.isPrevizTab && v.isPrevizTab()) render(true); },
        save() {
            return { char: st._pkChar || null, view: st._pkView || null,
                     follow: st._pkFollow === false ? false : true };
        },
        dispose() { if (offMarquee) { offMarquee(); offMarquee = null; } },
    };
}