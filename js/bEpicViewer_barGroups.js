// bEpicViewer_barGroups.js
// The lower bar's panel buttons, in groups.
//
// The bar used to carry one button per panel, and every new panel made it
// longer. The panels now sit in three groups, each one button that opens a
// short menu upwards:
//
//   ComfyUI    History · Parameters
//   3D         Outliner · Channel Box · Curve Editor   (on a 3D tab)
//   Timeline   Edit · Effects · Inspector          (Effects and Inspector on a cut's tab)
//
// A group's button is lit while one of its panels is up. Everything else that
// is not playback - layout, the shape overlay, docking, files, run, clear -
// stands at the right end of the bar (CSS `order`, so nothing is re-parented and
// every other piece of code still finds its button where it put it).
import { api } from "../../scripts/api.js";

const SVG = (inner) => '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>";
const ICONS = {
    // Lucide "box".
    box: SVG('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>'
           + '<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
    // Lucide "clapperboard".
    motion: SVG('<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/>'
              + '<path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
    timeline: SVG('<rect x="2" y="5" width="9" height="5" rx="1"/><rect x="13" y="5" width="9" height="5" rx="1"/>'
                + '<rect x="2" y="14" width="5" height="5" rx="1"/><rect x="9" y="14" width="13" height="5" rx="1"/>'),
};
// ComfyUI's own mark, as its frontend ships it (white on black, as it is drawn).
const COMFY_LOGO = "/assets/images/comfy-logo-mono.svg";

const GROUPS = [
    { id: "comfy", title: "ComfyUI", icon: "comfy", items: [
        { label: "History", panel: "history" },
        { label: "Parameters", panel: "params" },
        { label: "Agent code", panel: "agentCode" },
        { label: "Dataset", panel: "loraDataset" },
        { label: "agentY", panel: "agentChat" },
    ] },
    { id: "3d", title: "3D", icon: "box", items: [
        { label: "Outliner", panel: "previz", needs: "3d" },
        { label: "Channel Box", panel: "channels", needs: "3d" },
        { label: "Curve Editor", panel: "curves", needs: "3d" },
    ] },
    // A motion-graphics scene is a tab; "Open scene" asks for one, the three panels are its parts.
    { id: "motion", title: "Motion", icon: "motion", items: [
        { label: "Open scene\u2026", run: (p) => p.mgBarOpen(), checked: (p) => !!(p.isMotionTab && p.isMotionTab()) },
        { label: "Layers", panel: "motionLayers", needs: "motion" },
        { label: "Properties", panel: "motionProps", needs: "motion" },
        { label: "Timeline", panel: "motionTimeline", needs: "motion" },
    ] },
    { id: "timeline", title: "Timeline", icon: "timeline", items: [
        { label: "Edit", panel: "editTimeline", run: (p) => p.editTlToggle() },
        { label: "Effects", panel: "editEffects", needs: "cut", run: (p) => p.editTlPanelToggle("editEffects") },
        { label: "Inspector", panel: "editInspector", needs: "cut", run: (p) => p.editTlPanelToggle("editInspector") },
    ] },
];

export const BarGroupsMixin = {

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
            button.classList.toggle("active", group.items.some((item) => item.panel && this.isPanelDocked(item.panel)));
            if (group.id === "timeline") {
                // A film with a cut beside it: this is where it opens.
                const film = !!(this._editTlFilm && !(this.isEditTab && this.isEditTab()));
                button.classList.toggle("has-cut", film);
                button.title = film ? "Timeline: this film has a cut beside it - Edit opens it"
                                    : "Timeline: Edit, Effects, Inspector";
            }
        }
    },
};
