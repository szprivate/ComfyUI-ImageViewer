// bEpicViewer_mgRefs.js
// How the viewer names a file when it asks the server for the motion-graphics scene that belongs to it
// (GET /bepic/mgscene), and which files can have one at all. Pure, so the node tests run it.

const SCENE_RE = /\.mgscene\.json$/i;
const BELONGS_RE = /\.(png|mp4|m4v|mov|webm|mkv)$/i;

/** The query that names a file the way the history strip knows it: a path, or {filename, subfolder, type}. */
export function mgRefQuery(ref) {
    if (typeof ref === "string") return `path=${encodeURIComponent(ref)}`;
    if (ref && ref.path) return `path=${encodeURIComponent(ref.path)}`;
    if (ref && ref.filename) {
        let q = `filename=${encodeURIComponent(ref.filename)}&type=${encodeURIComponent(ref.type || "output")}`;
        if (ref.subfolder) q += `&subfolder=${encodeURIComponent(ref.subfolder)}`;
        return q;
    }
    return "";
}

/** The name of the file a ref points at ("" when it points at none). */
export function mgRefName(ref) {
    return typeof ref === "string" ? ref : (ref && (ref.path || ref.filename)) || "";
}

/** A scene file itself: no question to ask the server. */
export function mgIsSceneFile(ref) { return SCENE_RE.test(mgRefName(ref)); }

/** Can "Edit in Motion" apply at all: a scene file, a poster PNG, or a film (the server says whether a scene belongs to it). */
export function mgMayHaveScene(ref) {
    const name = mgRefName(ref);
    return SCENE_RE.test(name) || BELONGS_RE.test(name);
}
