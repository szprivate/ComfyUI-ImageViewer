// imageViewer_editProxy.js
// Proxy playback in the Edit panel, as Resolve's "Use proxy media": a film too
// heavy to scrub well - bigger than 720p, or with its key frames seconds apart,
// as ffmpeg writes them by default - is played, scrubbed and shown in the
// two-up through a lighter copy the server makes once, in the background
// (media_resolve.edit_proxy_state): 540p, a key frame every half second, no
// B-frames, the same length, frames and sound. Until the copy is there the film
// itself plays. Exports and cuts always read the film itself.
//
// GET /imageviewer/edit_proxy?path      { state: "ready" | "making" | "none" | "failed" };
//                                       one needed and not there is begun
// GET /imageviewer/view_file?path&edit=1  the copy (asked for only once it is ready)
//
// The bar's switch turns it off (kept per browser). An older server answers no
// edit_proxy: every film plays as it is, as before.
import { api } from "../../scripts/api.js";
import * as D from "./imageViewer_editTimelineData.js";

const STORE = "imageviewer.viewer.editProxy";
const POLL_MS = 1500;
const POLL_MAX = 800;              // 20 minutes of asking: a long film takes a while
const FILM_RE = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|mpg|mpeg|wmv|flv)$/i;

export const EditProxyMixin = {

    /** True while proxy playback is on (the default). */
    editProxyOn() {
        if (this._epxOn == null) {
            let kept = null;
            try { kept = localStorage.getItem(STORE); } catch (_) { kept = null; }
            this._epxOn = kept !== "off";
        }
        return this._epxOn;
    },

    /** The bar's switch. `on` forces. What rests on screen is shown from the film or its copy at once. */
    editProxyToggle(on) {
        this._epxOn = on === undefined ? !this.editProxyOn() : !!on;
        try { localStorage.setItem(STORE, this._epxOn ? "on" : "off"); } catch (_) {}
        this._editTlSay?.(this._epxOn ? "proxy playback on: big films play from a lighter copy"
                                      : "proxy playback off: every film plays at full size");
        this._editProxyReshow();
        this.editTlRefresh?.();
    },

    /**
     * The URL the Edit player loads `file` from: its proxy once it is ready (and
     * the switch is on), else the file. Asks after the proxy the first time.
     */
    _editPlayUrl(file) {
        const url = this.buildImgUrl({ path: file, external: true }, { noColor: true });
        if (!file || !FILM_RE.test(file) || D.isStill(file) || !this.editProxyOn()) return url;
        return this._editProxyState(file) === "ready" ? url + "&edit=1" : url;
    },

    /** "asking", "making", "ready", "none" or "failed" - asked for once per file and session. */
    _editProxyState(file) {
        const map = (this._epxMap ||= new Map());
        let e = map.get(file);
        if (!e) {
            e = { state: "asking", polls: 0 };
            map.set(file, e);
            this._editProxyAsk(file, e);
        }
        return e.state;
    },

    async _editProxyAsk(file, e) {
        let j = null;
        try {
            const res = await api.fetchApi("/imageviewer/edit_proxy?path=" + encodeURIComponent(file));
            if (res && res.ok) j = await res.json();
        } catch (_) { j = null; }
        const state = (j && j.state) || "none";
        if (state === "making" && e.polls < POLL_MAX) {
            e.polls += 1;
            e.state = "making";
            const win = (this._viewerWindow && this._viewerWindow()) || window;
            win.setTimeout(() => this._editProxyAsk(file, e), POLL_MS);
        } else {
            const was = e.state;
            e.state = state === "making" ? "none" : state;
            if (e.state === "ready" && was !== "ready") this._editProxyReshow();
        }
        this._editProxyButton();
    },

    // A proxy became ready, or the switch was turned: the frame resting on
    // screen is shown again from the right source. While the cut plays, the
    // player takes it up at the next clip that loads the film.
    _editProxyReshow() {
        if (!this._editPlayOn || this.isPlaying) return;
        this._epCutShown = null;
        if (this.editPlayCutChanged) this.editPlayCutChanged();
    },

    /** The bar's switch drawn as it stands, with how many copies are being made. */
    _editProxyButton(ui = this._editTlUi) {
        const b = ui && ui.proxy;
        if (!b) return;
        const on = this.editProxyOn();
        const making = [...(this._epxMap || new Map()).values()].filter((e) => e.state === "making").length;
        b.classList.toggle("on", on);
        b.classList.toggle("busy", on && making > 0);
        b.setAttribute("aria-pressed", on ? "true" : "false");
        b.title = (on ? "Proxy playback is on: films bigger than 720p, or hard to scrub, play from a lighter copy (540p) "
                        + "the server makes once. Exports always use the films themselves. Click to play every film at full size"
                      : "Proxy playback is OFF: every film plays at full size. Click to play big films from a lighter copy")
            + (on && making ? ` — making ${making} cop${making === 1 ? "y" : "ies"}…` : "");
    },
};
