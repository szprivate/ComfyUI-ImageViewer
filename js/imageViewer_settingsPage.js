// imageViewer_settingsPage.js    Settings → ComfyUI Image Viewer, as one page
//
// ComfyUI's settings dialog lays every setting out as a label and a control in a
// long flat list, one heading per section, with the explanation behind an (i).
// The viewer had some forty of those. This draws them as ONE page instead, the way
// agentY's settings look (Sebastian 2026-11-15): foldable sections with an edge
// colour per subject, the explanation written under each row, and the rarely
// touched rows behind "Show advanced settings".
//
// Nothing about storage changes: every row is still the ComfyUI setting it was
// (same id, same default, same onChange, kept per OS user by imageViewer_settings.js);
// those are registered as hidden and this page reads and writes them through
// ComfyUI's settings store. The page is the `type` function of one more setting,
// which ComfyUI calls to draw it. Pure of ComfyUI apart from the `store` handed in.

/** The page, top to bottom. `ids` are PREF names (resolved by the caller);
 *  `adv` rows show only with "Show advanced settings"; `sub` is a folded group
 *  inside the section. A section whose rows are all advanced is hidden with them. */
export const LAYOUT = [
    { key: "folders", title: "Folders the viewer may open", family: "connections", open: true,
      rows: ["folders"] },
    { key: "view", title: "Viewing and playback", family: "canvas", open: true,
      rows: ["fps", "loop", "compareMode", "showInfo", "historyLimit"] },
    { key: "layout", title: "Where the viewer sits", family: "integrations",
      rows: ["dockSide", "undockAs", { id: "dockWidth", adv: true }, { id: "dockHeight", adv: true }] },
    { key: "browser", title: "File browser", family: "connections",
      rows: ["browserKinds", "browserFold", "browserStart"] },
    { key: "colours", title: "Colours", family: "memory",
      rows: ["colourPreset", "colourScope", "colourReset"],
      sub: { title: "Each colour", adv: true, rows: ["@theme"] } },
    { key: "annotate", title: "Annotate", family: "checks",
      rows: ["annotColor", "annotSize", "annotTextSize"] },
    { key: "3d", title: "3D space and previz", family: "models",
      rows: ["grid3d", "material3d", "sceneFps", "sceneLength", "cameraRes"],
      sub: { title: "Render defaults", rows: ["renderFormat", "renderQuality", "renderScale", "renderAA", "renderBg", "renderColor"],
             note: "For a shot that has never been rendered. A shot keeps what its render dialog last used." } },
    { key: "paint", title: "Paint: Generate workflows", family: "models",
      rows: ["paintWorkflows"] },
    { key: "comp", title: "Comp", family: "canvas",
      rows: ["ocioConfig"] },
    { key: "experimental", title: "Experimental", family: "safety", adv: true,
      rows: ["atlasMove"] },
];

export const ADVANCED_KEY = "imageviewer.settings.advanced";
const OPEN_KEY = "imageviewer.settings.open";

const FAMILY = {
    models: "#b48ce3", connections: "#4fc3c3", canvas: "#7bd88f", checks: "#e5c07b",
    integrations: "#6f97ff", memory: "#d68ab0", safety: "#e5736f", other: "#6b7280",
};

export const PAGE_CSS = `
.ivs-page { display:flex; flex-direction:column; width:100%; box-sizing:border-box; color:#e6e8ec;
    font-family:ui-sans-serif, system-ui, "Segoe UI", sans-serif; font-size:13px; }
.ivs-top { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin:2px 0 6px; }
.ivs-intro { font-size:12px; color:#9aa0aa; line-height:1.45; margin:0 0 8px; }
.ivs-check { display:inline-flex; align-items:center; gap:8px; cursor:pointer; font-size:12.5px; color:#c3c8d0; }
.ivs-page input[type=checkbox] { width:16px; height:16px; accent-color:#6f97ff; margin:0; flex:none; cursor:pointer; }
.ivs-find { margin-left:auto; flex:0 1 220px; min-width:120px; }
.ivs-group { background:#1e2128; border:1px solid #2c313b; border-left:4px solid #6b7280; border-radius:9px;
    margin:6px 0; overflow:hidden; }
.ivs-group.ivs-sub { background:#191c22; margin:10px 0 4px; }
.ivs-head { display:flex; align-items:center; gap:8px; padding:8px 12px; font-size:12.5px; font-weight:600;
    font-family:ui-monospace, Consolas, monospace; cursor:pointer; user-select:none; }
.ivs-head:hover { background:#262b34; }
.ivs-head .ivs-arrow { width:10px; color:#9aa0aa; font-size:10px; }
.ivs-head .ivs-count { margin-left:auto; font-weight:400; font-size:11px; color:#9aa0aa; font-family:inherit; }
.ivs-body { padding:8px 12px 10px; border-top:1px solid #2c313b; }
.ivs-group.ivs-closed > .ivs-body { display:none; }
.ivs-note { font-size:11.5px; color:#9aa0aa; line-height:1.45; margin:0 0 8px; }
.ivs-field { margin:0 0 10px; }
.ivs-field:last-child { margin-bottom:2px; }
.ivs-row { display:flex; align-items:center; gap:10px; min-height:30px; }
.ivs-label { flex:0 0 42%; font-size:12.5px; color:#c3c8d0; word-break:break-word; }
.ivs-ctl { flex:1; min-width:0; display:flex; align-items:center; gap:8px; }
.ivs-field .ivs-help { margin:2px 0 0 calc(42% + 10px); font-size:11.5px; color:#9aa0aa; line-height:1.45; }
.ivs-field.ivs-wide .ivs-help { margin-left:0; margin-bottom:6px; }
.ivs-field.ivs-wide .ivs-label { flex:1 1 auto; margin-bottom:6px; }
.ivs-field.ivs-wide .ivs-row { display:block; }
.ivs-input { flex:1; min-width:0; box-sizing:border-box; background:#161a20; color:#e6e8ec; border:1px solid #2c313b;
    border-radius:7px; padding:6px 9px; font-size:12.5px; outline:none; font-family:inherit; }
.ivs-input:focus { border-color:#6f97ff; }
select.ivs-input { cursor:pointer; }
.ivs-input[type=number] { flex:0 0 110px; }
.ivs-input[type=color] { flex:0 0 46px; height:30px; padding:2px; cursor:pointer; }
.ivs-hex { font-family:ui-monospace, Consolas, monospace; font-size:12px; color:#9aa0aa; }
.ivs-unit { font-size:12px; color:#9aa0aa; }
.ivs-changed { width:6px; height:6px; border-radius:50%; background:#6f97ff; flex:none; margin-left:-4px; }
.ivs-reset { background:none; border:none; color:#6b7280; cursor:pointer; padding:2px 4px; font-size:13px; line-height:1; }
.ivs-reset:hover { color:#e6e8ec; }
.ivs-btn { background:#1e2128; color:#e6e8ec; border:1px solid #2c313b; border-radius:7px; padding:6px 14px;
    cursor:pointer; font-size:12.5px; }
.ivs-btn:hover:not(:disabled) { border-color:#6f97ff; }
.ivs-btn:disabled { opacity:.45; cursor:default; }
.ivs-empty { font-size:12px; color:#9aa0aa; padding:6px 2px; }
.ivs-hidden { display:none !important; }
@media (max-width:620px) {
  .ivs-row { flex-wrap:wrap; } .ivs-label { flex:1 1 100%; } .ivs-field .ivs-help { margin-left:0; }
}
/* ComfyUI puts a custom setting in a row beside its (empty) label: the page takes the whole row. */
div:has(> div > div > .ivs-page) > div:first-child { display:none; }
div:has(> div > .ivs-page) { flex:1 1 auto; justify-content:stretch !important; width:100%; }
div:has(> .ivs-page) { width:100%; }
`;

function storeGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
}
function storeSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private window */ }
}

/** Every row the layout names, in order, as entries `{key, id, adv, section}`;
 *  "@theme" stands for the colour rows. Used by the page and by the test that
 *  checks no setting is left off it. */
export function layoutRows(layout, idOf, themeIds) {
    const out = [];
    const walk = (rows, section, advAll) => {
        for (const r of rows) {
            const spec = typeof r === "string" ? { id: r } : r;
            if (spec.id === "@theme") {
                for (const id of themeIds) out.push({ id, adv: true, section });
                continue;
            }
            out.push({ id: idOf(spec.id), adv: !!(advAll || spec.adv), section });
        }
    };
    for (const s of layout) {
        walk(s.rows, s.key, s.adv);
        if (s.sub) walk(s.sub.rows, s.key, s.adv || s.sub.adv);
    }
    return out;
}

/** Whether a setting's text matches what is typed in the find field. */
export function matches(def, words) {
    if (!words.length) return true;
    const hay = `${def.name || ""} ${def.tooltip || ""} ${def.help || ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
}

/**
 * Draw the page.
 *  defs      the settings table (id -> def with name, tooltip, type, options, attrs, defaultValue)
 *  idOf      LAYOUT name -> setting id
 *  themeIds  the colour settings' ids, in order
 *  store     { get(id), set(id, value) } - ComfyUI's settings store
 *  custom    id -> () => HTMLElement, for the rows that draw themselves (folders, workflows, reset)
 */
export function renderSettingsPage({ defs, idOf, themeIds, store, custom = {}, doc = document }) {
    const byId = new Map(defs.map((d) => [d.id, d]));
    const h = (tag, props = {}, ...kids) => {
        const el = doc.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v == null) continue;
            if (k === "style") el.style.cssText = v;
            else if (k === "dataset") Object.assign(el.dataset, v);
            else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
            else if (k in el) el[k] = v;
            else el.setAttribute(k, v);
        }
        for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
        return el;
    };

    let advanced = !!storeGet(ADVANCED_KEY, false);
    const opened = storeGet(OPEN_KEY, null) || {};
    const fields = [];            // {def, adv, el, sync}
    const groups = [];            // {el, adv, sub}

    const page = h("div", { className: "ivs-page" }, h("style", { textContent: PAGE_CSS }));
    // Keys typed here must not reach ComfyUI's or the viewer's hotkeys.
    page.addEventListener("keydown", (e) => e.stopPropagation());

    const find = h("input", { className: "ivs-input ivs-find", type: "search", placeholder: "Find a setting…",
                              spellcheck: false, oninput: () => apply() });
    const advBox = h("input", { type: "checkbox", checked: advanced,
                                onchange: () => { advanced = advBox.checked; storeSet(ADVANCED_KEY, advanced); apply(); } });
    page.append(
        h("div", { className: "ivs-intro" },
          "The viewer's defaults. A change takes effect at once and is kept for your user on this machine, " +
          "whichever project ComfyUI was started in. Hotkeys are under Keybinding."),
        h("div", { className: "ivs-top" },
          h("label", { className: "ivs-check" }, advBox, "Show advanced settings (each colour, docked sizes, experimental)"),
          find),
    );

    const valueOf = (d) => {
        const v = store.get(d.id);
        return v === undefined || v === null ? d.defaultValue : v;
    };
    const write = async (d, v) => {
        try { await store.set(d.id, v); }
        catch (e) { console.warn(`[ImageViewer] could not save ${d.id}`, e); }
        for (const f of fields) f.sync();          // a preset writes the colours, and so on
    };

    function control(d) {
        const t = d.type;
        if (t === "boolean") {
            const el = h("input", { type: "checkbox", onchange: () => write(d, el.checked) });
            return { el, sync: () => { el.checked = !!valueOf(d); } };
        }
        if (t === "combo") {
            const el = h("select", { className: "ivs-input", onchange: () => write(d, el.value) },
                         (d.options || []).map((o) => h("option", { value: String(o.value), textContent: o.text })));
            return { el, sync: () => { el.value = String(valueOf(d)); } };
        }
        if (t === "number") {
            const a = d.attrs || {};
            const el = h("input", { className: "ivs-input", type: "number", min: a.min, max: a.max, step: a.step || 1,
                                    onchange: () => {
                                        let n = Number(el.value);
                                        if (!Number.isFinite(n)) n = Number(d.defaultValue);
                                        if (a.min != null) n = Math.max(a.min, n);
                                        if (a.max != null) n = Math.min(a.max, n);
                                        el.value = n;
                                        write(d, n);
                                    } });
            return { el: [el, d.unit ? h("span", { className: "ivs-unit" }, d.unit) : null],
                     sync: () => { if (doc.activeElement !== el) el.value = valueOf(d); } };
        }
        if (t === "color") {
            const el = h("input", { className: "ivs-input", type: "color",
                                    oninput: () => { hex.textContent = el.value; },
                                    onchange: () => write(d, el.value.replace(/^#/, "")) });
            const hex = h("span", { className: "ivs-hex" });
            return { el: [el, hex], sync: () => {
                const v = `#${String(valueOf(d) || "").replace(/^#/, "").toLowerCase()}`;
                if (/^#[0-9a-f]{6}$/.test(v)) { el.value = v; hex.textContent = v; }
            } };
        }
        // text
        const el = h("input", { className: "ivs-input", type: "text", spellcheck: false, placeholder: d.placeholder,
                                onchange: () => write(d, el.value.trim()) });
        return { el, sync: () => { if (doc.activeElement !== el) el.value = valueOf(d) || ""; } };
    }

    function field(id, adv) {
        const d = byId.get(id);
        if (!d) return null;
        const help = d.help || d.tooltip;
        if (custom[id] && d.inline) {
            const el = h("div", { className: "ivs-field", dataset: { id } },
                         h("div", { className: "ivs-row" },
                           h("label", { className: "ivs-label" }, d.name),
                           h("div", { className: "ivs-ctl" }, custom[id]())),
                         help ? h("div", { className: "ivs-help" }, help) : null);
            fields.push({ def: d, adv, el, sync: () => {} });
            return el;
        }
        if (custom[id]) {
            // The section's title names it; the editor says the rest itself.
            const el = h("div", { className: "ivs-field ivs-wide", dataset: { id } },
                         d.wideLabel ? h("div", { className: "ivs-row" }, h("div", { className: "ivs-label" }, d.name)) : null,
                         d.wideHelp ? h("div", { className: "ivs-help" }, d.wideHelp) : null,
                         custom[id]());
            fields.push({ def: d, adv, el, sync: () => {} });
            return el;
        }
        const c = control(d);
        const dot = h("span", { className: "ivs-changed", title: "Changed from the default" });
        const reset = h("button", { className: "ivs-reset", title: "Back to the default", textContent: "↺",
                                    onclick: () => write(d, d.defaultValue) });
        const el = h("div", { className: "ivs-field", dataset: { id } },
                     h("div", { className: "ivs-row" },
                       h("label", { className: "ivs-label" }, d.name),
                       h("div", { className: "ivs-ctl" }, c.el, dot, reset)),
                     help ? h("div", { className: "ivs-help" }, help) : null);
        const same = (a, b) => String(a).replace(/^#/, "").toLowerCase() === String(b).replace(/^#/, "").toLowerCase();
        const sync = () => {
            c.sync();
            // The colours follow their preset, so "changed from the default" says nothing there.
            const changed = !d.noReset && !same(valueOf(d), d.defaultValue);
            dot.classList.toggle("ivs-hidden", !changed);
            reset.classList.toggle("ivs-hidden", !changed);
        };
        sync();
        fields.push({ def: d, adv, el, sync });
        return el;
    }

    function group(key, title, family, { sub = false, adv = false, note = "", open = false } = {}) {
        const isOpen = key in opened ? !!opened[key] : open;
        const arrow = h("span", { className: "ivs-arrow" });
        const count = h("span", { className: "ivs-count" });
        const body = h("div", { className: "ivs-body" }, note ? h("div", { className: "ivs-note" }, note) : null);
        const el = h("div", { className: `ivs-group${sub ? " ivs-sub" : ""}`, dataset: { section: key },
                              style: `border-left-color:${FAMILY[family] || FAMILY.other}` });
        const head = h("div", { className: "ivs-head", role: "button", tabIndex: 0 }, arrow, title, count);
        const set = (o) => { el.classList.toggle("ivs-closed", !o); arrow.textContent = o ? "▾" : "▸"; };
        const toggle = () => {
            const o = el.classList.contains("ivs-closed");
            set(o); opened[key] = o; storeSet(OPEN_KEY, opened);
        };
        head.addEventListener("click", toggle);
        head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
        set(isOpen);
        el.append(head, body);
        const g = { el, body, count, adv, sub, rows: [] };
        groups.push(g);
        return g;
    }

    const addRows = (g, rows, advAll) => {
        for (const r of rows) {
            const spec = typeof r === "string" ? { id: r } : r;
            const list = spec.id === "@theme" ? themeIds.map((id) => ({ id, adv: true }))
                                              : [{ id: idOf(spec.id), adv: !!spec.adv }];
            for (const x of list) {
                const f = field(x.id, advAll || x.adv);
                if (f) { g.body.append(f); g.rows.push(fields[fields.length - 1]); }
            }
        }
    };

    for (const s of LAYOUT) {
        const g = group(s.key, s.title, s.family, { adv: !!s.adv, note: s.note, open: !!s.open });
        addRows(g, s.rows, !!s.adv);
        if (s.sub) {
            const sg = group(`${s.key}.sub`, s.sub.title, s.family,
                             { sub: true, adv: !!(s.adv || s.sub.adv), note: s.sub.note });
            addRows(sg, s.sub.rows, !!(s.adv || s.sub.adv));
            g.body.append(sg.el);
            g.subGroup = sg;
        }
        page.append(g.el);
    }
    const empty = h("div", { className: "ivs-empty ivs-hidden" }, "No setting matches.");
    page.append(empty);

    function apply() {
        const words = find.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        let any = false;
        for (const f of fields) {
            const show = (advanced || !f.adv) && matches(f.def, words);
            f.el.classList.toggle("ivs-hidden", !show);
            f.shown = show;
        }
        // Inner groups first: a section with a shown sub-group is shown.
        for (const g of [...groups].reverse()) {
            const n = g.rows.filter((f) => f.shown).length + (g.subGroup && !g.subGroup.el.classList.contains("ivs-hidden") ? 1 : 0);
            const show = (advanced || !g.adv) && n > 0;
            g.el.classList.toggle("ivs-hidden", !show);
            if (show) any = true;
            if (!g.sub) g.count.textContent = words.length ? `${g.rows.filter((f) => f.shown).length} found` : "";
            // Finding something opens where it is, without changing what is kept open.
            if (words.length && show) { g.el.classList.remove("ivs-closed"); g.el.querySelector(".ivs-arrow").textContent = "▾"; }
        }
        if (!words.length) {
            for (const g of groups) {
                const key = g.el.dataset.section;
                const o = key in opened ? !!opened[key] : !!(LAYOUT.find((s) => s.key === key) || {}).open;
                g.el.classList.toggle("ivs-closed", !o);
                g.el.querySelector(".ivs-arrow").textContent = o ? "▾" : "▸";
            }
        }
        empty.classList.toggle("ivs-hidden", any);
    }
    // Opened from a search in ComfyUI's dialog: start narrowed to what was searched for.
    try {
        const q = doc.querySelector(".settings-container input[type=text], .p-dialog input[placeholder*='Search'], [role=dialog] input[placeholder*='Search']");
        if (q && q.value.trim()) find.value = q.value.trim();
    } catch (e) { /* no dialog around it */ }
    apply();

    // Values change from outside too (the viewer's own controls, a preset, ComfyUI's
    // palette while following it): keep the rows true while the page is up.
    let waited = 0;
    const tick = () => {
        if (!page.isConnected) { if (page._ivsSeen || ++waited > 20) return; }
        else page._ivsSeen = true;
        for (const f of fields) f.sync();
        (doc.defaultView || window).setTimeout(tick, 1000);
    };
    (doc.defaultView || window).setTimeout(tick, 1000);
    page._ivsFields = fields;
    return page;
}
