// imageViewer_barGroups.js
// The lower bar's panel buttons, in groups.
//
// The bar used to carry one button per panel, and every new panel made it
// longer. The panels now sit in three groups, each one button that opens a
// short menu upwards:
//
//   ComfyUI    History · Parameters
//   3D         Open 3D… · Outliner · Channel Box · Curve Editor   (on a 3D tab)
//   Motion     Open Motion… · Properties · Timeline
//   Paint      Open Paint… · Layers · Properties · History
//   Timeline   Open Edit… · Edit · Effects · Inspector · Source · Mixer (all but Edit on a cut's tab)
//
// Each space's group starts with its "Open …" item (spaceOpen): the tab of that
// kind that is open, else the last file of that kind opened or saved, else an
// empty one - a white canvas, an empty cut, an empty scene. A second document is
// still a second tab (the file browser, Open cut…, Edit in Paint, ...).
//
// A group's button is lit while one of its panels is up. Everything else that
// is not playback - layout, the shape overlay, docking, files, run, clear -
// stands at the right end of the bar (CSS `order`, so nothing is re-parented and
// every other piece of code still finds its button where it put it).
import { api } from "../../scripts/api.js";
import { recentDocs } from "./imageViewer_recentDocs.js";
import { makeScene } from "./imageViewer_scene3d.js";

const SVG = (inner) => '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>";
const ICONS = {
    // Lucide "box".
    box: SVG('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>'
           + '<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
    // Lucide "clapperboard".
    motion: SVG('<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/>'
              + '<path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
    // Lucide "paintbrush".
    paint: SVG('<path d="m14.622 17.897-10.68-2.913"/><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z"/>'
             + '<path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15"/>'),
    timeline: SVG('<rect x="2" y="5" width="9" height="5" rx="1"/><rect x="13" y="5" width="9" height="5" rx="1"/>'
                + '<rect x="2" y="14" width="5" height="5" rx="1"/><rect x="9" y="14" width="13" height="5" rx="1"/>'),
};
// ComfyUI's own mark, as its frontend ships it (white on black, as it is drawn).
const COMFY_LOGO = "/assets/images/comfy-logo-mono.svg";

const GROUPS = [
    { id: "comfy", title: "ComfyUI", icon: "comfy", items: [
        { label: "History", panel: "history" },
        { label: "Parameters", panel: "params" },
        // Agent code and Dataset open as tabs of the main canvas (imageViewer_viewTabs.js).
        { label: "Agent code", run: (p) => p.codeBarOpen(), checked: (p) => !!(p.isViewTab && p.vtKindOf() === "code") },
        { label: "Dataset", run: (p) => p.loraBarOpen(), checked: (p) => !!(p.isViewTab && p.vtKindOf() === "dataset") },
        { label: "agentY", panel: "agentChat" },
    ] },
    { id: "3d", title: "3D", icon: "box", items: [
        { label: "Open 3D\u2026", run: (p) => p.spaceOpen("3d"), checked: (p) => !!(p.isPrevizTab && p.isPrevizTab()) },
        { label: "Outliner", panel: "previz", needs: "3d" },
        { label: "Channel Box", panel: "channels", needs: "3d" },
        { label: "Curve Editor", panel: "curves", needs: "3d" },
    ] },
    // A motion-graphics scene is a tab; "Open scene" asks for one, the three panels are its parts.
    { id: "motion", title: "Motion", icon: "motion", items: [
        { label: "Open Motion\u2026", run: (p) => p.spaceOpen("motion"), checked: (p) => !!(p.isMotionTab && p.isMotionTab()) },
        { label: "Properties", panel: "motionProps", needs: "motion" },
        { label: "Timeline", panel: "motionTimeline", needs: "motion" },
    ] },
    // A picture in layers is a tab (imageViewer_paintPanel.js); Layers and Properties are its parts.
    { id: "paint", title: "Paint", icon: "paint", items: [
        { label: "Open Paint\u2026", run: (p) => p.spaceOpen("paint"), checked: (p) => !!(p.isPaintTab && p.isPaintTab()) },
        { label: "Layers", panel: "paintLayers", needs: "paint" },
        { label: "Properties", panel: "paintProps", needs: "paint" },
        { label: "Tool options", panel: "paintTool", needs: "paint" },
        { label: "Effects", panel: "paintEffects", needs: "paint" },
        { label: "Generate", panel: "paintGenerate", needs: "paint" },
        { label: "History", panel: "paintHistory", needs: "paint" },
    ] },
    { id: "timeline", title: "Timeline", icon: "timeline", items: [
        { label: "Open Edit\u2026", run: (p) => p.spaceOpen("edit"), checked: (p) => !!(p.isEditTab && p.isEditTab()) },
        { label: "Edit", panel: "editTimeline", run: (p) => p.editTlToggle() },
        { label: "Effects", panel: "editEffects", needs: "cut", run: (p) => p.editTlPanelToggle("editEffects") },
        { label: "Inspector", panel: "editInspector", needs: "cut", run: (p) => p.editTlPanelToggle("editInspector") },
        { label: "Source", panel: "editSource", needs: "cut", run: (p) => p.editTlPanelToggle("editSource") },
        { label: "Mixer", panel: "editMixer", needs: "cut", run: (p) => p.editTlPanelToggle("editMixer") },
    ] },
];

export const BarGroupsMixin = {

    /**
     * "Open Paint…" / "Open Edit…" / "Open Motion…" / "Open 3D…": the open tab
     * of that kind (the one up, else the first in the bar), else the newest
     * recent file that is still there, else a new empty one.
     */
    async spaceOpen(kind) {
        if (this.requestPanelOpen) this.requestPanelOpen();
        const is = { paint: "isPaintTab", edit: "isEditTab", motion: "isMotionTab", "3d": "isPrevizTab" }[kind];
        if (!is || !this[is]) return false;
        const PAINT_ASK = "paint:", MOTION_ASK = "motion:";
        const real = (k) => this[is](k) && !!this.allTabs[k] && k !== PAINT_ASK && k !== MOTION_ASK;
        if (kind === "edit" && this._editTlWant) this._editTlWant("editTimeline", true);
        if (real(this.activeTab)) return true;
        const open = (this.tabOrder || []).find(real);
        if (open) { this.switchTab(open); return true; }
        const last = await this._spaceLastFile(kind);
        if (last) {
            const ok = kind === "paint" ? await this.paintOpen(last, { quiet: true })
                : kind === "edit" ? await this.editTlOpenPath(last)
                : kind === "motion" ? await this.mgOpenFile(last) : false;
            if (ok) return true;
        }
        if (kind === "paint") return this.paintNewBlank();
        if (kind === "edit") return !!this.editTlNew();
        if (kind === "motion") { this.mgBarOpen(); return true; }
        return this.previzNewTab();
    },

    /** The newest recent file of `kind` that still exists, or "". */
    async _spaceLastFile(kind) {
        const list = kind === "edit" ? (this.editTlRecent ? this.editTlRecent() : [])
            : (kind === "paint" || kind === "motion") ? recentDocs(kind) : [];
        if (!list.length) return "";
        const gone = this._editTlRecentGone ? await this._editTlRecentGone(list.slice(0, 3)) : new Set();
        const n = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
        return list.slice(0, 3).find((p) => !gone.has(n(p))) || "";
    },

    /** A new, empty 3D scene in a tab of its own. */
    previzNewTab() {
        let n = 1;
        while (this.allTabs[`previz:new-${n}`]) n++;
        const key = `previz:new-${n}`;
        this.allTabs[key] = [];
        this.tabLabels[key] = "\u{1F9CA} 3D" + (n > 1 ? " " + n : "");
        if (!this.tabOrder.includes(key)) this.tabOrder.push(key);
        if (this._setScene) this._setScene(key, makeScene());
        this._previzSelection = null;
        this._rebuildTabBar(null);
        this.switchTab(key);
        return true;
    },

    /** Make the group buttons (once), in front of what stands at the right. */
    _barGroupsBuild() {
        const bar = this.container && this.container.querySelector(".transport");
        if (!bar) return;
        if (this._barGroups && this._barGroups.every((g) => g.button.isConnected)) return;
        const doc = bar.ownerDocument;
        bar.querySelectorAll(":scope > .bar-group, :scope > .bar-spacer").forEach((n) => n.remove());
        this._barGroups = GROUPS.map((group) => {
            const b = doc.createElement("button");
            b.className = "sprite-icon bar-group";
            b.id = "bar-group-" + group.id;
            b.title = group.title + ": " + group.items.map((i) => i.label).join(", ");
            if (group.icon === "comfy") {
                const logo = doc.createElement("img");
                logo.className = "bar-comfy";
                logo.alt = "ComfyUI";
                logo.draggable = false;
                // A frontend that does not ship the mark: the name's first letter.
                logo.addEventListener("error", () => { logo.remove(); b.textContent = "C"; b.classList.add("bar-letter"); });
                logo.src = api.fileURL ? api.fileURL(COMFY_LOGO) : COMFY_LOGO;
                b.append(logo);
            } else {
                b.innerHTML = ICONS[group.icon];
            }
            b.addEventListener("click", () => this._barGroupMenu(group, b));
            bar.append(b);
            return { group, button: b };
        });
        const spacer = doc.createElement("div");
        spacer.className = "bar-spacer";
        bar.append(spacer);
        // The buttons these groups stand in for stay where they are, out of
        // sight: their handlers and their lit state are still what toggles.
        for (const old of [this.historyToggleBtn, this.paramsBtn]) if (old) old.style.display = "none";
        this.barGroupsSync();
    },

    _barGroupCan(item) {
        if (item.needs === "3d") return !!(this.isPrevizTab && this.isPrevizTab());
        if (item.needs === "cut") return !!(this.isEditTab && this.isEditTab());
        if (item.needs === "motion") return !!(this.isMotionTab && this.isMotionTab());
        if (item.needs === "paint") return !!(this.isPaintTab && this.isPaintTab());
        return true;
    },

    _barGroupMenu(group, button) {
        if (this._previzAddMenu) { this._previzCloseAddMenu(); return; }
        const entries = group.items.map((item) => ({
            label: ((item.panel ? this.isPanelDocked(item.panel) : (item.checked && item.checked(this))) ? "✓  " : "   ") + item.label,
            disabled: !this._barGroupCan(item),
            run: () => {
                // Open, but behind another panel's tab: it comes to the front
                // rather than being closed by the press that asked to see it.
                if (item.panel && this.isPanelDocked(item.panel) && this.isPanelFront && !this.isPanelFront(item.panel)) {
                    this.dockTabFront(item.panel);
                } else if (item.run) item.run(this); else this.togglePanelDocked(item.panel);
                this.barGroupsSync();
            },
        }));
        const box = button.getBoundingClientRect();
        const menu = this._previzOpenMenu(entries, box.left, box.top, button);
        if (!menu) return;
        menu.classList.add("bar-menu");
        // Upwards: the bar is the foot of the viewer, and a menu that dropped
        // down would lie over it.
        const host = menu.offsetParent ? menu.offsetParent.getBoundingClientRect() : { top: 0 };
        menu.style.top = Math.max(0, box.top - host.top - menu.getBoundingClientRect().height - 4) + "px";
    },

    /** Light each group whose panel is up. Called whenever the dock layout is applied. */
    barGroupsSync() {
        if (!this._barGroups || !this.isPanelDocked) return;
        for (const { group, button } of this._barGroups) {
            button.classList.toggle("active", group.items.some((item) => item.panel ? this.isPanelDocked(item.panel)
                : !!(item.checked && item.checked(this))));
            if (group.id === "timeline") {
                // A film with a cut beside it: this is where it opens.
                const film = !!(this._editTlFilm && !(this.isEditTab && this.isEditTab()));
                button.classList.toggle("has-cut", film);
                button.title = film ? "Timeline: this film has a cut beside it - Edit opens it"
                                    : "Timeline: Edit, Effects, Inspector, Source, Mixer";
            }
        }
    },
};
