// bEpicViewer_loraModel.js
// The Dataset panel's edits, as pure functions on a LoRA dataset manifest (the format is the
// contract in agentY-core: agenty_core/tools/lora_training/formats.py). No DOM, so the logic is
// tested under node (tests/test_lora_model.mjs). Every edit function mutates the manifest it is
// given; the panel snapshots before it calls one (History) to get undo.
//
// A removed item is `included: false` and keeps its file, so it can be restored. Training sees
// only included items; a crop is [x, y, w, h] normalised 0..1 on the original file (null = all).

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
export const MIN_CROP = 0.05;

export const itemById = (m, id) => (m.items || []).find((i) => i.id === id) || null;
export const isIncluded = (it) => it.included !== false;

/** Counts as the tool layer writes them into summary (count / included / removed), warnings kept. */
export function summary(m) {
    const items = m.items || [];
    const inc = items.filter(isIncluded).length;
    const warnings = (m.summary && Array.isArray(m.summary.warnings)) ? m.summary.warnings : [];
    return { count: items.length, included: inc, removed: items.length - inc, warnings: [...warnings] };
}

/** Write summary counts into the manifest, the way formats.save_manifest does. */
export function recount(m) {
    const s = summary(m);
    m.summary = Object.assign({}, m.summary || {}, { count: s.count, included: s.included, removed: s.removed });
    return m;
}

export function isDirty(saved, current) {
    return JSON.stringify(saved) !== JSON.stringify(current);
}

export function setCaption(m, id, text) {
    const it = itemById(m, id);
    if (!it) return false;
    it.caption = String(text ?? "");
    return true;
}

/** Exclude an item (a user's removal): keeps the file, says who and why. */
export function removeItem(m, id, reason = "") {
    const it = itemById(m, id);
    if (!it || !isIncluded(it)) return false;
    it.included = false;
    it.removed_by = "user";
    if (reason) it.note = reason;
    recount(m);
    return true;
}

export function removeItems(m, ids, reason = "") {
    let n = 0;
    for (const id of ids) if (removeItem(m, id, reason)) n++;
    return n;
}

export function restoreItem(m, id) {
    const it = itemById(m, id);
    if (!it || isIncluded(it)) return false;
    it.included = true;
    it.removed_by = null;
    recount(m);
    return true;
}

/** The include/exclude switch on an item. Returns the new `included`, or null for an unknown id. */
export function toggleItem(m, id, reason = "") {
    const it = itemById(m, id);
    if (!it) return null;
    if (isIncluded(it)) removeItem(m, id, reason); else restoreItem(m, id);
    return isIncluded(it);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find and replace in captions. opts: { ids (only these items; default every included item),
 * caseSensitive (false), regex (false), wholeWord (false) }. Returns the number of captions changed.
 * A bad regex throws (the panel shows the message).
 */
export function bulkReplace(m, find, repl, opts = {}) {
    if (!find) return 0;
    const { ids, caseSensitive = false, regex = false, wholeWord = false } = opts;
    let src = regex ? find : esc(find);
    if (wholeWord) src = `\\b(?:${src})\\b`;
    const re = new RegExp(src, caseSensitive ? "g" : "gi");
    const only = ids ? new Set(ids) : null;
    let n = 0;
    for (const it of m.items || []) {
        if (only ? !only.has(it.id) : !isIncluded(it)) continue;
        const before = it.caption || "";
        const after = before.replace(re, regex ? repl : () => repl);
        if (after !== before) { it.caption = after; n++; }
    }
    return n;
}

/** Does this caption carry the trigger word (as a word, any case)? */
export function hasTrigger(caption, word) {
    if (!word) return true;
    return new RegExp(`(^|[^A-Za-z0-9_])${esc(word)}($|[^A-Za-z0-9_])`, "i").test(caption || "");
}

/** Put the trigger word at the front of every caption that lacks it. Returns how many changed. */
export function ensureTrigger(m, ids) {
    const word = (m.trigger_word || "").trim();
    if (!word) return 0;
    const only = ids ? new Set(ids) : null;
    let n = 0;
    for (const it of m.items || []) {
        if (only && !only.has(it.id)) continue;
        if (hasTrigger(it.caption, word)) continue;
        const c = (it.caption || "").trim();
        it.caption = c ? `${word}, ${c}` : word;
        n++;
    }
    return n;
}

/**
 * Change the trigger word. With rewrite, the old word is replaced in every caption that has it and
 * the new one is prepended where neither is present. Returns { changed } (captions touched).
 */
export function setTrigger(m, next, rewrite = false) {
    const old = (m.trigger_word || "").trim();
    const word = String(next ?? "").trim();
    m.trigger_word = word;
    if (!rewrite || old === word) return { changed: 0 };
    let changed = 0;
    if (old) {
        const re = new RegExp(`(^|[^A-Za-z0-9_])${esc(old)}(?=$|[^A-Za-z0-9_])`, "gi");
        for (const it of m.items || []) {
            const after = (it.caption || "").replace(re, (_, pre) => pre + word);
            if (after !== it.caption) { it.caption = after; changed++; }
        }
    }
    return { changed: changed + ensureTrigger(m) };
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);

/** A crop [x, y, w, h] kept inside the picture and at least MIN_CROP big. Null/garbage -> null. */
export function clampCrop(crop) {
    if (!Array.isArray(crop) || crop.length !== 4) return null;
    let [x, y, w, h] = crop.map((v) => num(v, NaN));
    if (![x, y, w, h].every(Number.isFinite)) return null;
    w = Math.min(1, Math.max(MIN_CROP, w));
    h = Math.min(1, Math.max(MIN_CROP, h));
    x = Math.min(1 - w, Math.max(0, x));
    y = Math.min(1 - h, Math.max(0, y));
    const r = (v) => Math.round(v * 1e4) / 1e4;
    return [r(x), r(y), r(w), r(h)];
}

/** A crop from two drag points (normalised, any order). */
export function cropFromDrag(a, b) {
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    return clampCrop([Math.max(0, x0), Math.max(0, y0), Math.min(1, x1) - Math.max(0, x0), Math.min(1, y1) - Math.max(0, y0)]);
}

/** Set (or with null / the whole picture, clear) an item's crop. Returns the stored value. */
export function setCrop(m, id, crop) {
    const it = itemById(m, id);
    if (!it) return undefined;
    let c = clampCrop(crop);
    if (c && c[0] === 0 && c[1] === 0 && c[2] === 1 && c[3] === 1) c = null;
    it.crop = c;
    return c;
}

/** Items split for the two sections of the grid, in manifest order. */
export function split(m) {
    const kept = [], removed = [];
    for (const it of m.items || []) (isIncluded(it) ? kept : removed).push(it);
    return { kept, removed };
}

/** Captions that need a look: empty, or missing the trigger word. */
export function captionIssues(m) {
    const out = [];
    for (const it of m.items || []) {
        if (!isIncluded(it)) continue;
        if (!(it.caption || "").trim()) out.push({ id: it.id, issue: "empty caption" });
        else if (!hasTrigger(it.caption, m.trigger_word)) out.push({ id: it.id, issue: "no trigger word" });
    }
    return out;
}

/** A snapshot stack for undo, like the Motion editor's. */
export class History {
    constructor(limit = 100) { this.limit = limit; this.past = []; this.future = []; }
    push(m) {
        this.past.push(JSON.stringify(m));
        if (this.past.length > this.limit) this.past.shift();
        this.future.length = 0;
    }
    undo(m) {
        if (!this.past.length) return null;
        this.future.push(JSON.stringify(m));
        return JSON.parse(this.past.pop());
    }
    redo(m) {
        if (!this.future.length) return null;
        this.past.push(JSON.stringify(m));
        return JSON.parse(this.future.pop());
    }
    get canUndo() { return this.past.length > 0; }
    get canRedo() { return this.future.length > 0; }
}

// ── training tab helpers (pure) ─────────────────────────────────────────────

/** Exponential moving average of [[step, loss], ...] (alpha 0..1, smaller = smoother). */
export function smoothLoss(series, alpha = 0.15) {
    const out = [];
    let acc = null;
    for (const p of series || []) {
        if (!Array.isArray(p) || !Number.isFinite(+p[1])) continue;
        acc = acc === null ? +p[1] : acc + alpha * (+p[1] - acc);
        out.push([+p[0], acc]);
    }
    return out;
}

const validPts = (series) => (series || []).filter((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]));

/** {x0, x1, y0, y1} of a series, so two curves (raw and smoothed) can share one scale. */
export function seriesRange(series) {
    const pts = validPts(series);
    if (!pts.length) return null;
    const xs = pts.map((p) => +p[0]), ys = pts.map((p) => +p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** An SVG path "M x y L ..." for a series fitted into w x h (loss up = up). Empty for < 2 points. */
export function sparkPath(series, w, h, pad = 2, range = null) {
    const pts = validPts(series);
    if (pts.length < 2) return "";
    const { x0, x1, y0, y1 } = range || seriesRange(pts);
    const dx = x1 - x0 || 1, dy = y1 - y0 || 1;
    return pts.map((p, i) => {
        const x = pad + ((+p[0] - x0) / dx) * (w - 2 * pad);
        const y = h - pad - ((+p[1] - y0) / dy) * (h - 2 * pad);
        return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
}

/** "1h 02m", "4m 05s", "12s"; "-" for unknown. */
export function fmtDuration(s) {
    if (s === null || s === undefined || !Number.isFinite(+s) || +s < 0) return "-";
    s = Math.round(+s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
    return `${sec}s`;
}

/** The events a panel has not shown yet (id > last), oldest first. */
export function eventsAfter(events, lastId) {
    return (events || []).filter((e) => Number.isFinite(+e.id) && +e.id > lastId).sort((a, b) => a.id - b.id);
}

export const maxEventId = (events) => (events || []).reduce((m, e) => (Number.isFinite(+e.id) && +e.id > m ? +e.id : m), 0);

/** Polling gap in ms: fast while a run runs and the panel is open, slow otherwise. */
export function pollDelay(status, panelOpen) {
    if (!panelOpen) return 15000;
    return (status === "running" || status === "starting") ? 3000 : 12000;
}

const isLive = (r) => !!r && (r.status === "running" || r.status === "starting");

/** "v3" from a run name like "cozy_cabin_v3" ("" when the name has no version suffix). */
export function runVersion(name) {
    const m = /_v(\d+)$/.exec(String(name || ""));
    return m ? "v" + m[1] : "";
}

/** "v3 of 8 on cozy_cabin": which run this is among the runs of its dataset. */
export function runLabel(name, runs) {
    const r = (runs || []).find((x) => x.name === name);
    if (!r) return name || "";
    const same = (runs || []).filter((x) => (x.dataset || "") === (r.dataset || ""));
    const v = runVersion(name);
    return `${v || name}${v && same.length > 1 ? ` of ${same.length}` : ""}${r.dataset ? ` on ${r.dataset}` : ""}`;
}

/** Which run the Training tab shows after a poll.
 *  runs: newest first (lora_io.list_runs). cur: {run, picked, seen: Set|null, dataset}.
 *  A run the page has not seen before is a run that was just started: it is shown (the tab used to keep
 *  the old run, so a new start looked like nothing happened) unless the user is watching a LIVE run of
 *  another dataset; then it is only offered (`offer`). Without a new run, an unpicked tab follows the
 *  live run (else the newest), a picked one stays while it exists.
 *  Returns {run, picked, switched, offer, fresh, seen}. */
export function chooseRun(runs, cur) {
    runs = runs || [];
    const seen = new Set(cur.seen || []);
    const fresh = cur.seen ? runs.filter((r) => !seen.has(r.name)) : [];
    runs.forEach((r) => seen.add(r.name));
    const have = runs.find((r) => r.name === cur.run);
    let run = cur.run, picked = !!cur.picked, switched = false, offer = "";
    const cand = fresh[0];
    if (cand) {
        const watching = have && isLive(have) && (have.dataset || "") !== (cand.dataset || "") && picked;
        if (watching) offer = cand.name;
        else { run = cand.name; picked = false; switched = cand.name !== cur.run; }
    } else if (!picked || !have) {
        run = ((runs.find(isLive) || runs[0]) || {}).name || "";
        picked = false;
        switched = run !== cur.run;
    }
    return { run, picked, switched, offer, fresh: fresh.map((r) => r.name), seen };
}

export const sampleSteps = (samples) => (samples || []).filter((s) => s && Array.isArray(s.files)).sort((a, b) => a.step - b.step);

export { clone };
