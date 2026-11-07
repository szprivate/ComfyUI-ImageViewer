// imageViewer_editDialogs.js
// Where the Edit panel's dialogs stand: centred over the timeline (the Edit
// panel's body, `_editTlUi.body`), held inside the window so none goes off
// screen, and centred again when the window or the timeline changes size. The
// panel's own dialogs (.edit-dialog: Save cut as, Export to Resolve, Auto edit,
// Recreate, Paste Attributes) and the viewer's shared ones opened from the panel
// (the file picker - Open cut, Add files, Browse - and the Export film dialog,
// both a .rd-box in a .rd-shade) all go through _editTlCentre. Context menus stay
// at the pointer. In the pop-out it is the pop-out's timeline and window.
import { openFilePicker, openExportDialog } from "./imageViewer_exportUI.js";

const MARGIN = 8;

export const EditDialogsMixin = {

    /** Put `box` (absolutely placed) over the middle of the timeline, inside the window; and keep it there. */
    _editTlCentre(box) {
        if (!box) return;
        const win = box.ownerDocument.defaultView || window;
        if (box._imageViewerCentre) box._imageViewerCentre.stop();
        const place = () => {
            if (!box.isConnected) { stop(); return; }
            const ui = this._editTlUi;
            const body = ui && ui.body && ui.body.isConnected && ui.body.ownerDocument === box.ownerDocument ? ui.body : null;
            const tl = body ? body.getBoundingClientRect() : null;
            if (!tl || !(tl.width > 0) || !(tl.height > 0)) return;
            const cs = win.getComputedStyle(box);
            if (cs.position !== "absolute" && cs.position !== "fixed") box.style.position = "absolute";
            box.style.right = "auto";
            box.style.bottom = "auto";
            box.style.transform = "none";
            box.style.margin = "0";
            // Where 0, 0 of its containing block lies on screen (whatever that block is, in a shadow root or not).
            box.style.left = "0px";
            box.style.top = "0px";
            const zero = box.getBoundingClientRect();
            const w = zero.width, h = zero.height;
            const vw = win.innerWidth, vh = win.innerHeight;
            const hold = (v, size, room) => (size + 2 * MARGIN >= room ? MARGIN : Math.max(MARGIN, Math.min(room - size - MARGIN, v)));
            const x = hold(tl.left + tl.width / 2 - w / 2, w, vw);
            const y = hold(tl.top + tl.height / 2 - h / 2, h, vh);
            box.style.left = Math.round(x - zero.left) + "px";
            box.style.top = Math.round(y - zero.top) + "px";
        };
        let ro = null;
        const onResize = () => place();
        const stop = () => {
            win.removeEventListener("resize", onResize);
            if (ro) { try { ro.disconnect(); } catch (_) {} ro = null; }
            if (box._imageViewerCentre && box._imageViewerCentre.place === place) box._imageViewerCentre = null;
        };
        win.addEventListener("resize", onResize);
        const RO = win.ResizeObserver || (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
        if (RO) {
            ro = new RO(() => place());
            ro.observe(box);
            const ui = this._editTlUi;
            if (ui && ui.body) ro.observe(ui.body);
        }
        box._imageViewerCentre = { place, stop };
        place();
    },

    /** The shared dialog of kind `cls` ("pick-dlg", "export-dlg") just opened over the viewer: its box centred over the timeline. */
    _editTlCentreShade(cls) {
        const shade = this.container && [...this.container.querySelectorAll(":scope > .rd-shade." + cls)].pop();
        const box = shade && shade.querySelector(".rd-box");
        if (box) this._editTlCentre(box);
    },

    /** The file picker, opened from the Edit panel: over the timeline. */
    _editTlPicker(spec) {
        const open = openFilePicker(this.container, spec);           // its box is in the page before its first await
        this._editTlCentreShade("pick-dlg");
        return open;
    },

    /** The export dialog, opened from the Edit panel: over the timeline. */
    async _editTlExportDialog(spec) {
        const got = await openExportDialog(this.container, spec);
        this._editTlCentreShade("export-dlg");
        return got;
    },
};
