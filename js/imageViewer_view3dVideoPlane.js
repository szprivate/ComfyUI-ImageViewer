// imageViewer_view3dVideoPlane.js
// An image plane whose picture is a film (Sebastian 2026-11-12: a History
// item dropped into the 3D space becomes an image plane with it as the
// texture - a video too).
//
// The film is a muted <video> on a THREE.VideoTexture. It is never played:
// the scene's timeline owns the clock, as it does for a model's clips, so
// applyFrame seeks it to the scene frame (`videoTime`) and a frame looks the
// same whether it was reached by playing, scrubbing or rendering. Before a
// render frame is drawn, `prepareVideoPlanes(frame)` waits for every seek to
// land, so the rendered picture is the frame asked for.
//
// The pure part (isVideoSrc, videoTime) is tested under node in
// tests/test_view3d_video_plane.mjs; the mixin goes onto Model3DView.

const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv)$/i;

/** Whether an image plane's source is a film rather than a still. */
export function isVideoSrc(src) {
    if (!src) return false;
    if (src.kind === "video") return true;
    return VIDEO_RE.test(String(src.path || src.filename || src.name || ""));
}

/**
 * The film's own time at a scene frame: frame 0 of the scene is the film's
 * first frame (the plane's `offset` moves that), the middle of the frame is
 * read so rounding never shows the one before, and past its end the last
 * frame is held - a plate does not loop.
 */
export function videoTime(frame, fps, duration, offset = 0) {
    const f = Number(frame) - (Number(offset) || 0);
    const rate = Number(fps) > 0 ? Number(fps) : 24;
    if (!Number.isFinite(f) || f < 0) return 0;
    const t = (Math.floor(f) + 0.5) / rate;
    const d = Number(duration);
    if (!Number.isFinite(d) || d <= 0) return t;
    return Math.min(t, Math.max(0, d - 0.5 / rate));
}

/**
 * A plate: an image plane whose picture is a numbered sequence or a film read
 * frame by frame on the server (GET /imageviewer/mm_frame - EXR, DPX, PNG ...
 * sequences and films alike, undistorted when the src carries a lens).
 * Sebastian 2026-11-19: the Matchmove plate stood still in the 3D view on his
 * Mac while the timeline played; a <video> that is never played and not in
 * the page is not something every browser updates after a seek, so a plate is
 * pictures, one per frame, which every browser draws the same.
 */
export function isPlateSrc(src) {
    return !!(src && src.kind === "plate" && src.path);
}

/** The plate's frame (0 = its first) at a scene frame: `offset` moves it, held at both ends. */
export function plateFrame(frame, frames, offset = 0) {
    const f = Math.floor(Number(frame) - (Number(offset) || 0));
    if (!Number.isFinite(f) || f < 0) return 0;
    const n = Math.round(Number(frames));
    return n > 0 ? Math.min(f, n - 1) : f;
}

const PLATE_CACHE = 96;   // pictures of a plate kept per plane
const PLATE_AHEAD = 8;    // frames asked for ahead of the one shown
const PLATE_FLIGHT = 4;   // pictures on their way at once (ahead of time)

/**
 * Whether a scene frame is cached on every plane that shows pictures over time
 * (the timeline's green marks, Sebastian 2026-11-20). planes: [{kind: "plate",
 * has(n), frames, offset} | {kind: "film", ranges: [[start, end], ...] seconds,
 * fps, duration, offset}]. No planes: null (nothing to say).
 */
export function planeFrameCached(planes, frame) {
    if (!planes || !planes.length) return null;
    for (const p of planes) {
        if (p.kind === "plate") {
            if (!p.has(plateFrame(frame, p.frames, p.offset))) return false;
        } else {
            const t = videoTime(frame, p.fps, p.duration, p.offset);
            if (!(p.ranges || []).some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6)) return false;
        }
    }
    return true;
}

export const View3DVideoPlaneMixin = {
    /** Tell the panel the planes' caches changed (at most once a frame, the panel's queueCacheMarks). */
    _planeCacheChanged() {
        if (this.hooks && this.hooks.onCache) this.hooks.onCache();
    },

    /** The image planes that change over time, as planeFrameCached takes them. */
    _cachePlanes() {
        const out = [];
        if (!this.scene3d) return out;
        const fps = this.scene3d.fps || 24;
        for (const item of this.scene3d.items || []) {
            const entry = this._entries.get(item.id);
            if (!entry) continue;
            const offset = item.plane ? item.plane.offset : 0;
            if (entry.plateTex && entry.plateCache) {
                const cache = entry.plateCache;
                out.push({ kind: "plate", frames: entry.plateInfo && entry.plateInfo.frames, offset,
                           has: (n) => { const c = cache.get(n); return !!(c && c.ok); } });
            } else if (entry.video) {
                const v = entry.video, ranges = [];
                try { for (let i = 0; i < v.buffered.length; i++) ranges.push([v.buffered.start(i), v.buffered.end(i)]); } catch (_) {}
                out.push({ kind: "film", ranges, fps, duration: v.duration, offset });
            }
        }
        return out;
    },

    /** Has(frame) for the timeline's cache marks, or null when no plane changes over time. */
    planeCacheTest() {
        const planes = this._cachePlanes();
        if (!planes.length) return null;
        return (frame) => planeFrameCached(planes, frame);
    },

    /** Load `url` as a film texture; resolves once its first frame is there. */
    _loadVideoTexture(url) {
        const { THREE } = this.libs;
        const video = this.doc.createElement("video");
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.src = url;
        return new Promise((resolve, reject) => {
            const fail = () => reject(new Error("that film could not be loaded"));
            video.addEventListener("error", fail, { once: true });
            video.addEventListener("loadeddata", () => {
                const texture = new THREE.VideoTexture(video);
                texture.userData.imageViewerVideo = video;
                resolve(texture);
            }, { once: true });
            try { video.load(); } catch (_) { fail(); }
        });
    },

    /** Seek a film plane to the scene frame (from applyFrame). */
    _videoPlaneSeek(entry, item, frame) {
        const video = entry && entry.video;
        if (!video) return null;
        const fps = (this.scene3d && this.scene3d.fps) || 24;
        const offset = item && item.plane ? item.plane.offset : 0;
        const t = videoTime(frame, fps, video.duration, offset);
        if (entry.videoWant === t && !video.seeking) return null;
        entry.videoWant = t;
        if (Math.abs((video.currentTime || 0) - t) < 1e-4 && !video.seeking) return null;
        if (!entry.videoSeekBound) {
            entry.videoSeekBound = true;
            video.addEventListener("seeked", () => {
                if (entry.plane && entry.plane.material && entry.plane.material.map) {
                    entry.plane.material.map.needsUpdate = true;
                }
                // A newer wish came while this seek ran: go on to it.
                if (entry.videoWant !== undefined && Math.abs(video.currentTime - entry.videoWant) > 1e-4) {
                    try { video.currentTime = entry.videoWant; } catch (_) {}
                    return;
                }
                const waiting = entry.videoWaiters || [];
                entry.videoWaiters = [];
                for (const done of waiting) done();
                this.requestRender();
            });
        }
        try { video.currentTime = t; } catch (_) {}
        return t;
    },

    /** Every film plane seeked to `frame`, and its picture there. */
    async prepareVideoPlanes(frame) {
        if (!this.scene3d) return;
        const waits = [];
        for (const item of this.scene3d.items || []) {
            const entry = this._entries.get(item.id);
            if (!entry || !entry.video) continue;
            this._videoPlaneSeek(entry, item, frame);
            const video = entry.video;
            if (!video.seeking) continue;
            waits.push(new Promise((resolve) => {
                (entry.videoWaiters || (entry.videoWaiters = [])).push(resolve);
                // A seek that never lands must not stop a render for good.
                this.win.setTimeout(resolve, 5000);
            }));
        }
        // Plates: the picture of that frame in.
        for (const item of this.scene3d.items || []) {
            const entry = this._entries.get(item.id);
            if (!entry || !entry.plateTex) continue;
            this._platePlaneSeek(entry, item, frame);
            if (entry.plateShown === entry.plateWant) continue;
            waits.push(new Promise((resolve) => {
                (entry.plateWaiters || (entry.plateWaiters = [])).push(resolve);
                this.win.setTimeout(resolve, 15000);
            }));
        }
        if (waits.length) await Promise.all(waits);
        for (const item of this.scene3d.items || []) {
            const entry = this._entries.get(item.id);
            if (entry && entry.video && entry.plane && entry.plane.material.map) {
                entry.plane.material.map.needsUpdate = true;
            }
        }
    },

    /**
     * The first picture of a plate as a texture. The plate's facts and pictures ride on the texture
     * (`userData.plate`) until the plane takes it (`_plateAdopt`), so a load that lost the race to a newer one
     * touches nothing of the entry.
     */
    async _loadPlateTexture(entry, item) {
        const { THREE } = this.libs;
        if (!this.hooks.plateFrameUrl) throw new Error("plates are not served here");
        const src = item.src;
        let info = null;
        try { info = this.hooks.plateInfo ? await this.hooks.plateInfo(src) : null; } catch (e) {
            throw new Error((e && e.message) || "the plate could not be read");
        }
        const ps = { plateInfo: info || {}, plateSrc: src, plateCache: new Map(), plateWaiters: [] };
        const offset = item.plane ? item.plane.offset : 0;
        const n = plateFrame(this.sceneFrame || 0, ps.plateInfo.frames, offset);
        const img = await this._plateImage(ps, n).promise;
        if (!img) throw new Error("the plate's first picture could not be loaded");
        const texture = new THREE.Texture(img);
        texture.needsUpdate = true;
        ps.plateShown = n;
        texture.userData.plate = ps;
        return texture;
    },

    /** The plane takes the plate the texture carries. */
    _plateAdopt(entry, texture) {
        const ps = texture.userData.plate;
        Object.assign(entry, ps, { plateTex: texture, plateWant: ps.plateShown });
        delete texture.userData.plate;
        this._planeCacheChanged();
    },

    /** Picture n of a plane's plate: {img, promise, ok}; asked for once, kept (least recently used out). */
    _plateImage(entry, n) {
        const cache = entry.plateCache;
        let c = cache.get(n);
        if (c) { cache.delete(n); cache.set(n, c); return c; }
        const img = new (this.win.Image || Image)();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        c = { img, ok: false, done: false };
        c.promise = new Promise((resolve) => {
            img.onload = () => { c.ok = true; c.done = true; resolve(img); this._planeCacheChanged(); };
            img.onerror = () => { c.done = true; cache.delete(n); resolve(null); };
        });
        img.src = this.hooks.plateFrameUrl(entry.plateSrc, n);
        cache.set(n, c);
        let gone = false;
        while (cache.size > PLATE_CACHE) { cache.delete(cache.keys().next().value); gone = true; }
        if (gone) this._planeCacheChanged();
        return c;
    },

    /** Show the plate's picture for the scene frame (from applyFrame): the one wanted when it is in, the last meanwhile. */
    _platePlaneSeek(entry, item, frame) {
        if (!entry || !entry.plateTex || !entry.plateCache) return null;
        const offset = item && item.plane ? item.plane.offset : 0;
        const frames = entry.plateInfo && entry.plateInfo.frames;
        const n = plateFrame(frame, frames, offset);
        entry.plateWant = n;
        const c = this._plateImage(entry, n);
        if (c.ok) this._plateShow(entry, n, c.img);
        else c.promise.then((img) => { if (img && entry.plateWant === n) this._plateShow(entry, n, img); else this._plateSettle(entry); });
        // A few ahead, so playing does not wait on each one.
        let flying = 0;
        for (const x of entry.plateCache.values()) if (!x.done) flying++;
        for (let k = 1; k <= PLATE_AHEAD && flying < PLATE_FLIGHT; k++) {
            const m = n + k;
            if (frames > 0 && m >= frames) break;
            if (!entry.plateCache.has(m)) { this._plateImage(entry, m); flying++; }
        }
        return n;
    },

    _plateShow(entry, n, img) {
        if (!entry.plateTex) return;
        if (entry.plateShown !== n || entry.plateTex.image !== img) {
            entry.plateTex.image = img;
            entry.plateTex.needsUpdate = true;
            entry.plateShown = n;
            this.requestRender();
        }
        this._plateSettle(entry);
    },

    _plateSettle(entry) {
        if (entry.plateShown !== entry.plateWant) return;
        const waiting = entry.plateWaiters || [];
        entry.plateWaiters = [];
        for (const done of waiting) done();
    },

    /** Let a plate plane's pictures go (from _disposeEntry). */
    _platePlaneDrop(entry) {
        if (!entry) return;
        if (entry.plateCache) for (const c of entry.plateCache.values()) { try { c.img.src = ""; } catch (_) {} }
        entry.plateCache = null;
        entry.plateTex = null;
        this._planeCacheChanged();
        const waiting = entry.plateWaiters || [];
        entry.plateWaiters = [];
        for (const done of waiting) done();
    },

    /** Let a film plane's <video> go (from _disposeEntry). */
    _videoPlaneDrop(entry) {
        const video = entry && entry.video;
        if (!video) return;
        entry.video = null;
        entry.videoWaiters = [];
        this._planeCacheChanged();
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch (_) {}
    },
};
