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

export const View3DVideoPlaneMixin = {
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
        if (waits.length) await Promise.all(waits);
        for (const item of this.scene3d.items || []) {
            const entry = this._entries.get(item.id);
            if (entry && entry.video && entry.plane && entry.plane.material.map) {
                entry.plane.material.map.needsUpdate = true;
            }
        }
    },

    /** Let a film plane's <video> go (from _disposeEntry). */
    _videoPlaneDrop(entry) {
        const video = entry && entry.video;
        if (!video) return;
        entry.video = null;
        entry.videoWaiters = [];
        try { video.pause(); video.removeAttribute("src"); video.load(); } catch (_) {}
    },
};
