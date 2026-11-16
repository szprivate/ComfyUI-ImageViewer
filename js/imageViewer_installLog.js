/**
 * The install log window: ONE floating window that every install and download of the viewer opens, showing
 * what it prints as it runs (pip, git, the installer's steps, the model downloads' progress).
 *
 * The server keeps the lines (src/install_log.py, GET /imageviewer/install_log?id=&since=); the window asks for
 * the new ones about once a second while what it shows runs, and stops asking when that is over or the window is
 * closed. Closing it does not stop the install; its Stop button does (POST {id, cancel: true}).
 *
 * The window is not in the viewer's shadow root: it goes on the body of the document the viewer is in (the
 * pop-out's when popped out), with its own small stylesheet (classes `ivlog-*`, prefixed because ComfyUI's
 * Tailwind owns names like `fixed`).
 */
import { api } from "../../scripts/api.js";

const STYLE_ID = "imageviewer-install-log-style";
const POS_KEY = "imageviewer.viewer.installLogBox";
const POLL_MS = 900;

const CSS = `
.ivlog-box { position: fixed; z-index: 100000; display: flex; flex-direction: column;
    width: 640px; height: 360px; min-width: 320px; min-height: 160px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px);
    background: #161616; color: #ddd; border: 1px solid #444; border-radius: 6px; box-shadow: 0 10px 32px rgba(0,0,0,.7);
    font: 12px sans-serif; resize: both; overflow: hidden; box-sizing: border-box; }
.ivlog-box.ivlog-min { height: auto !important; min-height: 0; resize: none; }
.ivlog-box.ivlog-min .ivlog-body, .ivlog-box.ivlog-min .ivlog-foot { display: none; }
.ivlog-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #333;
    cursor: move; user-select: none; background: #1d1d1d; border-radius: 6px 6px 0 0; }
.ivlog-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: bold; color: #eee; }
.ivlog-state { flex: 0 0 auto; padding: 1px 6px; border-radius: 8px; font-size: 11px; background: #333; color: #ccc; }
.ivlog-state[data-state="running"] { background: #4a3410; color: #f0b050; }
.ivlog-state[data-state="done"] { background: #173a1c; color: #7cd38a; }
.ivlog-state[data-state="error"], .ivlog-state[data-state="failed"] { background: #451818; color: #f08080; }
.ivlog-pick { flex: 0 1 180px; min-width: 60px; background: #111; color: #ccc; border: 1px solid #3a3a3a; border-radius: 3px; font: inherit; }
.ivlog-btn { background: #262626; color: #ccc; border: 1px solid #3a3a3a; border-radius: 3px; padding: 2px 8px;
    font: inherit; cursor: pointer; }
.ivlog-btn:hover { color: #fff; border-color: #666; }
.ivlog-btn:disabled { opacity: .45; cursor: default; }
.ivlog-x { background: none; border: none; color: #999; font-size: 14px; cursor: pointer; padding: 0 4px; }
.ivlog-x:hover { color: #fff; }
.ivlog-body { flex: 1 1 auto; margin: 0; padding: 6px 8px; overflow: auto; background: #0d0d0d;
    font: 11px/1.35 ui-monospace, Consolas, "Cascadia Mono", Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
.ivlog-line.cmd { color: #6cc6e0; }
.ivlog-line.err { color: #f08080; }
.ivlog-line.end { color: #7cd38a; }
.ivlog-empty { color: #777; font-style: italic; }
.ivlog-foot { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-top: 1px solid #333; flex-wrap: wrap; }
.ivlog-file { flex: 1 1 auto; min-width: 0; color: #888; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ivlog-follow { color: #aaa; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
`;

/** One window per document: {doc, box, id, since, timer, follow}. */
const _windows = new WeakMap();

function lineClass(l) {
    if (/^\$ /.test(l)) return "cmd";
    if (/^!!|Traceback|\bERROR\b|\berror:|^-- (error|failed|cancelled|stopped)/i.test(l)) return "err";
    if (/^-- done --/.test(l)) return "end";
    return "";
}

function readPos() {
    try { const p = JSON.parse(localStorage.getItem(POS_KEY) || "null"); return p && typeof p === "object" ? p : null; } catch (_) { return null; }
}
function writePos(p) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch (_) { /* not kept */ }
}

async function getJson(url, init) {
    const r = await fetch(api.apiURL(url), init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
}

function docOf(host) {
    if (host && host.ownerDocument) return host.ownerDocument;
    return document;
}

function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const st = doc.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    (doc.head || doc.documentElement).append(st);
}

function build(doc) {
    ensureStyle(doc);
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const box = el("div", "ivlog-box");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Install log");
    const head = el("div", "ivlog-head");
    const title = el("div", "ivlog-title", "Install log");
    const state = el("span", "ivlog-state", "");
    const pick = el("select", "ivlog-pick");
    pick.title = "Earlier installs and downloads";
    const min = el("button", "ivlog-x", "–"); min.title = "Fold the window";
    const close = el("button", "ivlog-x", "✕"); close.title = "Close (what runs goes on)";
    head.append(title, state, pick, min, close);
    const body = el("pre", "ivlog-body");
    const foot = el("div", "ivlog-foot");
    const file = el("span", "ivlog-file", "");
    const followLab = el("label", "ivlog-follow");
    const follow = Object.assign(el("input"), { type: "checkbox", checked: true });
    followLab.append(follow, "Follow");
    const copy = el("button", "ivlog-btn", "Copy log");
    const copyPath = el("button", "ivlog-btn", "Copy file path");
    const stop = el("button", "ivlog-btn", "Stop");
    foot.append(file, followLab, copyPath, copy, stop);
    box.append(head, body, foot);

    const pos = readPos();
    const vw = doc.defaultView.innerWidth, vh = doc.defaultView.innerHeight;
    const w = Math.min(pos && pos.w || 640, vw - 16), h = Math.min(pos && pos.h || 360, vh - 16);
    const left = pos && pos.x != null ? Math.max(8, Math.min(pos.x, vw - 120)) : Math.max(8, vw - w - 24);
    const top = pos && pos.y != null ? Math.max(8, Math.min(pos.y, vh - 40)) : Math.max(8, vh - h - 24);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
    doc.body.append(box);

    const keep = () => { const r = box.getBoundingClientRect(); writePos({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: box.classList.contains("ivlog-min") ? (readPos() || {}).h : Math.round(r.height) }); };
    // Drag by the header.
    head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button, select")) return;
        e.preventDefault();
        const r = box.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
        const move = (ev) => {
            box.style.left = `${Math.max(0, Math.min(r.left + ev.clientX - x0, doc.defaultView.innerWidth - 80))}px`;
            box.style.top = `${Math.max(0, Math.min(r.top + ev.clientY - y0, doc.defaultView.innerHeight - 30))}px`;
        };
        const up = () => { doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up); keep(); };
        doc.addEventListener("pointermove", move);
        doc.addEventListener("pointerup", up);
    });
    // The size the user gives it is kept too.
    if (doc.defaultView.ResizeObserver) {
        let t = null;
        new doc.defaultView.ResizeObserver(() => { clearTimeout(t); t = setTimeout(keep, 300); }).observe(box);
    }
    // Keys typed in it are its own (the viewer's hotkeys must not see them).
    box.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") w0.close(); });
    // A press scrolling up stops following; at the bottom again it follows.
    body.addEventListener("scroll", () => {
        const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
        if (!atEnd && follow.checked && w0.userScrolled) follow.checked = false;
        if (atEnd && !follow.checked && w0.userScrolled) follow.checked = true;
    });
    body.addEventListener("wheel", () => { w0.userScrolled = true; }, { passive: true });
    body.addEventListener("pointerdown", () => { w0.userScrolled = true; });

    const w0 = {
        doc, box, title, state, pick, body, file, follow, stop, copyPath, id: null, since: 0, timer: null, lines: [], logFile: "", userScrolled: false,
        close() {
            clearTimeout(this.timer);
            this.timer = null;
            box.remove();
            _windows.delete(doc);
        },
    };
    close.addEventListener("click", () => w0.close());
    min.addEventListener("click", () => { box.classList.toggle("ivlog-min"); min.textContent = box.classList.contains("ivlog-min") ? "▢" : "–"; });
    copy.addEventListener("click", () => copyText(doc, w0.lines.join("\n")));
    copyPath.addEventListener("click", () => copyText(doc, w0.logFile));
    stop.addEventListener("click", async () => {
        stop.disabled = true;
        try { await getJson("/imageviewer/install_log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: w0.id, cancel: true }) }); } catch (_) { /* said by the next poll */ }
    });
    pick.addEventListener("change", () => { if (pick.value && pick.value !== w0.id) show(w0, pick.value); });
    return w0;
}

function copyText(doc, text) {
    if (!text) return;
    const nav = doc.defaultView.navigator;
    if (nav.clipboard && nav.clipboard.writeText) { nav.clipboard.writeText(text).catch(() => {}); return; }
    const ta = doc.createElement("textarea");
    ta.value = text; doc.body.append(ta); ta.select();
    try { doc.execCommand("copy"); } catch (_) { /* nothing */ }
    ta.remove();
}

function append(w, lines) {
    if (!lines.length) return;
    const body = w.body;
    const empty = body.querySelector(".ivlog-empty");
    if (empty) empty.remove();
    const frag = w.doc.createDocumentFragment();
    for (const l of lines) {
        const d = w.doc.createElement("div");
        const c = lineClass(l);
        d.className = c ? `ivlog-line ${c}` : "ivlog-line";
        d.textContent = l || " ";
        frag.append(d);
        w.lines.push(l);
    }
    body.append(frag);
    // Keep the page light: the window holds the last 5000 lines, as the server does.
    const over = body.childElementCount - 5000;
    for (let i = 0; i < over; i++) body.firstElementChild.remove();
    if (w.lines.length > 5000) w.lines.splice(0, w.lines.length - 5000);
    if (w.follow.checked) body.scrollTop = body.scrollHeight;
}

async function fillPick(w) {
    let logs = [];
    try { logs = (await getJson("/imageviewer/install_log")).logs || []; } catch (_) { return; }
    const pick = w.pick;
    pick.textContent = "";
    for (const l of logs) {
        const o = w.doc.createElement("option");
        o.value = l.id;
        const when = new Date(l.started * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        o.textContent = `${when} · ${l.title}${l.state === "running" ? " (running)" : ""}`;
        pick.append(o);
    }
    pick.value = w.id || "";
    pick.style.display = logs.length > 1 ? "" : "none";
}

async function poll(w) {
    const id = w.id;
    let v;
    try {
        v = await getJson(`/imageviewer/install_log?id=${encodeURIComponent(id)}&since=${w.since}`);
    } catch (e) {
        if (w.id !== id) return;
        if (!w.lines.length) {
            w.body.textContent = "";
            w.body.append(Object.assign(w.doc.createElement("div"), { className: "ivlog-empty", textContent: `The log is not there: ${e.message || e}` }));
        }
        w.state.textContent = "?";
        w.timer = setTimeout(() => poll(w), POLL_MS * 3);
        return;
    }
    if (w.id !== id || !w.box.isConnected) return;
    if (v.dropped > w.since) append(w, [`… ${v.dropped - w.since} earlier lines are only in the log file`]);
    append(w, v.lines || []);
    w.since = v.next;
    w.title.textContent = v.title || "Install log";
    w.title.title = v.title || "";
    const secs = Math.round(v.seconds || 0);
    w.state.textContent = `${v.state} · ${secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`}`;
    w.state.dataset.state = v.state;
    w.logFile = v.log_file || "";
    w.file.textContent = v.log_file ? `Log file: ${v.log_file}` : (v.error ? v.error : "");
    w.file.title = w.file.textContent;
    w.copyPath.style.display = v.log_file ? "" : "none";
    w.stop.style.display = v.state === "running" ? "" : "none";
    w.stop.disabled = !v.can_stop;
    if (v.state === "running") w.timer = setTimeout(() => poll(w), POLL_MS);
    else { w.timer = null; fillPick(w); }
}

function show(w, id) {
    clearTimeout(w.timer);
    w.id = String(id);
    w.since = 0;
    w.lines = [];
    w.userScrolled = false;
    w.follow.checked = true;
    w.body.textContent = "";
    w.body.append(Object.assign(w.doc.createElement("div"), { className: "ivlog-empty", textContent: "Waiting for the first lines…" }));
    w.box.classList.remove("ivlog-min");
    fillPick(w);
    poll(w);
}

/**
 * Open the log window on the install / download `id` (a job id the server answered: rig/install's `job`,
 * paint/download's and rig/body_pose_download's `job`). `host`: an element of the viewer, so the window goes
 * into its document (the pop-out's when popped out). The same window is reused; it shows the newest call.
 */
export function showInstallLog(id, { host = null } = {}) {
    if (!id) return null;
    const doc = docOf(host);
    let w = _windows.get(doc);
    if (!w || !w.box.isConnected) { w = build(doc); _windows.set(doc, w); }
    if (w.id !== String(id) || !w.timer) show(w, id);
    return w;
}

/** Open the window on the newest log (the Rig menu's "Install log…"); says so when there is none yet. */
export async function openLatestInstallLog({ host = null } = {}) {
    let logs = [];
    try { logs = (await getJson("/imageviewer/install_log")).logs || []; } catch (_) { /* none */ }
    const doc = docOf(host);
    if (!logs.length) {
        let w = _windows.get(doc);
        if (!w || !w.box.isConnected) { w = build(doc); _windows.set(doc, w); }
        w.body.textContent = "";
        w.body.append(Object.assign(doc.createElement("div"), { className: "ivlog-empty", textContent: "Nothing has been installed or downloaded since ComfyUI started." }));
        w.state.textContent = "";
        w.stop.style.display = "none";
        w.pick.style.display = "none";
        return w;
    }
    return showInstallLog((logs.find((l) => l.state === "running") || logs[0]).id, { host });
}

/** For tests: the window of a document, if open. */
export function installLogWindow(doc = document) {
    return _windows.get(doc) || null;
}
