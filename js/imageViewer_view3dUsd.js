// imageViewer_view3dUsd.js
// Model3DView's side of the scene as USD (View3DUsdMixin):
//
//   * what a model's edits inside its asset look like here: a USD asset is
//     drawn through the server's display copy, which takes the edits as part
//     of its URL (so a hidden prim or a picked variant comes back drawn that
//     way); any other file is the page's own node tree, and a hidden node is
//     hidden right here;
//   * an unloaded payload draws nothing;
//   * the node tree of a loaded model, for the Outliner's Contents rows;
//   * the meshes the page built itself (a terrain, a scatter, a depth mesh,
//     an image plane's card, a model only the page could read), handed to
//     the server on save as arrays (usd_io.write_geometry_layer's shape).
//
// The arithmetic is imageViewer_usdData.js.

import { editsKey, hiddenByOvers, isUnloaded, isUsdSrc, usdEdits } from "./imageViewer_usdData.js";

/** Kinds whose geometry only the page has. */
export const BUILT_KINDS = ["terrain", "scatter", "depthmesh", "mesh"];
/** Files the server cannot read meshes out of: the page sends what it drew. */
const PAGE_MESH_RE = /\.fbx$/i;
const MAX_VERTICES = 6e6;           // past this a save would send hundreds of MB

function b64(typed) {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function attrArray(attr, width) {
    if (!attr) return null;
    const n = attr.count;
    const out = new Float32Array(n * width);
    const get = [attr.getX, attr.getY, attr.getZ].slice(0, width);
    for (let i = 0; i < n; i++) for (let k = 0; k < width; k++) out[i * width + k] = get[k].call(attr, i);
    return out;
}

export const View3DUsdMixin = {
    /** What decides whether a model must be read again: its file, its edits (on USD), unloaded. */
    _modelKey(item) {
        let key = this._srcKey(item && item.src);
        if (isUnloaded(item)) return `${key}|unloaded`;
        const edits = usdEdits(item);
        if (edits && isUsdSrc(item.src)) key += `|${editsKey(edits)}`;
        return key;
    },

    /** The src as the file route should be asked for it: with the edits, for a USD asset. */
    _usdSrcForUrl(item) {
        const edits = usdEdits(item);
        return edits && isUsdSrc(item.src) && item.src.path ? { ...item.src, usd: editsKey(edits) } : item.src;
    },

    /** A node's path below the model's own object ("Body/Head"), as the Outliner names it. */
    _usdRelOf(root, node) {
        const parts = [];
        for (let n = node; n && n !== root; n = n.parent) parts.unshift(n.name || n.type);
        return parts.join("/");
    },

    /** Hide the nodes the Outliner hid (a file that is not USD: the page's own tree). */
    usdSyncOvers(entry, item) {
        if (!entry || !entry.object || isUsdSrc(item.src)) return;
        const key = JSON.stringify((item.usd && item.usd.overs) || {});
        if (entry.oversKey === key) return;
        entry.oversKey = key;
        const root = entry.object;
        root.traverse((n) => {
            if (n === root || n.isBone) return;
            if (n.userData.ivBaseVisible === undefined) n.userData.ivBaseVisible = n.visible;
            n.visible = n.userData.ivBaseVisible && !hiddenByOvers(item, this._usdRelOf(root, n));
        });
        this.requestRender();
    },

    /**
     * A loaded model's node tree as the Outliner's Contents: [{rel, name, parent, type}],
     * parents first; bones are the Skeleton rows' and left out. Null while not loaded.
     */
    usdContentsOf(itemId) {
        const e = this._entries && this._entries.get(itemId);
        if (!e || !e.object) return null;
        const root = e.object, out = [], seen = new Set();
        root.traverse((n) => {
            if (n === root || n.isBone || out.length >= 3000) return;
            if (n.parent && n.parent !== root && !seen.has(n.parent)) return;    // under a bone
            seen.add(n);
            const rel = this._usdRelOf(root, n);
            const parent = n.parent === root ? "" : this._usdRelOf(root, n.parent);
            out.push({ rel, name: n.name || n.type, parent,
                       type: n.isSkinnedMesh ? "SkinnedMesh" : n.isMesh ? "Mesh" : n.isLight ? "Light" : "Xform" });
        });
        return out;
    },

    /** True when the page holds geometry the server could not make itself for this item. */
    usdNeedsPageMesh(item) {
        if (!item) return false;
        if (BUILT_KINDS.includes(item.kind) || item.kind === "imageplane") return true;
        if (item.kind !== "model" || !item.src) return false;
        const src = item.src;
        if (src.url && !src.path && !src.filename) return true;
        return PAGE_MESH_RE.test(String(src.path || src.filename || src.name || ""));
    },

    /**
     * The meshes of `ids` as drawn, in each item's own space (under its frozen
     * transform, where its USD prim's children sit): {id: {meshes: [...]}}.
     * Returns {geometry, skipped: [names]}.
     */
    usdCollectGeometry(ids) {
        const { THREE } = this.libs;
        const geometry = {}, skipped = [];
        let total = 0;
        const inv = new THREE.Matrix4(), rel = new THREE.Matrix4();
        if (this.scene) this.scene.updateMatrixWorld(true);
        for (const id of ids) {
            const e = this._entries && this._entries.get(id);
            if (!e || !e.object) continue;
            const frame = this._bodyOf(e);
            inv.copy(frame.matrixWorld).invert();
            const meshes = [];
            const root = e.object;
            root.traverse((n) => {
                if (!n.isMesh || !n.geometry || !n.visible) return;
                const g = n.geometry;
                const pos = g.getAttribute("position");
                if (!pos) return;
                total += pos.count;
                if (total > MAX_VERTICES) return;
                rel.multiplyMatrices(inv, n.matrixWorld);
                const mesh = { name: n.name || "mesh", path: n === root ? (n.name || "mesh") : this._usdRelOf(root, n),
                               matrix: rel.toArray(), positions: b64(attrArray(pos, 3)) };
                const nrm = g.getAttribute("normal");
                if (nrm) mesh.normals = b64(attrArray(nrm, 3));
                const uv = g.getAttribute("uv");
                if (uv) mesh.uvs = b64(attrArray(uv, 2));
                const mat = Array.isArray(n.material) ? n.material[0] : n.material;
                const col = g.getAttribute("color");
                if (col && mat && mat.vertexColors) mesh.colors = b64(attrArray(col, 3));
                else if (mat && mat.color) mesh.color = `#${mat.color.getHexString()}`;
                if (g.index) mesh.indices = b64(Uint32Array.from(g.index.array));
                if (n.isInstancedMesh) mesh.instances = b64(n.instanceMatrix.array.slice(0, n.count * 16));
                meshes.push(mesh);
            });
            if (total > MAX_VERTICES) { skipped.push(e.item.name); continue; }
            if (meshes.length) geometry[id] = { meshes };
        }
        return { geometry, skipped };
    },
};
