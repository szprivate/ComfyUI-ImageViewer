// imageViewer_farm.js
// The Farm: GPU machines that render workflows like a render farm - rented on vast.ai or RunPod, or any ComfyUI
// added by its address - in a tab of the main canvas ("farm:", imageViewer_viewTabs.js).
//
// The farm itself lives in agentY-core's gpu_pool, run by the agentY host; the page only draws its state and sends
// actions: GET / POST /imageviewer/farm, relayed to the host's /agentY/pool (src/farm_routes.py). The provider keys
// stay on the host (the page sees only whether one is set), nothing here starts a process or names a path, and
// finished renders arrive in the History under "Farm" the way an Atlas render does.
//
// The tab: a spend bar (today against the daily cap, $/h of the machines up), the machines as cards (state, GPU,
// $/h, uptime, cost, what it renders; Start / Stop / Terminate / Remove / Open ComfyUI / Check workflow), the
// queue (each job's renders as chips; Cancel / Retry / Remove), and Setup (keys, cap, idle stop, image, limits).
// Dialogs: Add machines (live offers to rent, or a ComfyUI by address) and Render on farm (this canvas's workflow
// x N with its own seeds, on the machines picked). Polled every 2 s while the tab is up.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

export const FARM_PREFIX = "farm:";
const POLL_MS = 2000;
const STATE_LABEL = { ready: "Ready", starting: "Starting", stopped: "Stopped", gone: "Gone", unreachable: "Not answering",
    busy: "Rendering" };
const PROVIDER_LABEL = { vast: "vast.ai", runpod: "RunPod", url: "By address" };
const TASK_LABEL = { queued: "waiting", models: "getting models", uploading: "sending", running: "rendering", done: "done", failed: "failed",
    cancelled: "cancelled" };
const SEED_MODES = [["increment", "Seed +1 per render"], ["random", "Random seeds"], ["fixed", "Same seed (a repeat)"]];

const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;
function since(s) {
    s = Math.max(0, Math.round(Number(s) || 0));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
function ago(t) { return since(Date.now() / 1000 - (Number(t) || 0)) + " ago"; }

/** What a machine card says it is doing ("busy" is a ready machine with a task). */
export function machineShownState(m) {
    if (m.state === "ready" && m.task) return "busy";
    return m.state || "starting";
}

/** The spend bar's numbers: share of the cap used, and whether it is near / at the cap. */
export function spendLevel(spend) {
    const cap = Number(spend && spend.cap) || 0, today = Number(spend && spend.today) || 0;
    const share = cap > 0 ? Math.min(1, today / cap) : 0;
    return { share, warn: share >= 0.8, over: cap > 0 && today >= cap };
}

/** How far a render is, 0..1: the nodes done of all, the running node counted by its steps. */
export function farmLiveShare(live) {
    const total = Math.max(1, Number(live.nodes_total) || 1);
    const step = live.max ? Math.min(1, (Number(live.value) || 0) / live.max) : 0;
    return Math.min(1, ((Number(live.nodes_done) || 0) + (live.node ? step : 0)) / total);
}

/** "KSampler · step 12 of 30 · node 3 of 9". */
export function farmLiveText(live) {
    if (!live.started) return "Waiting to start";
    const parts = [];
    if (live.class_type || live.node) parts.push(live.class_type || `node ${live.node}`);
    if (live.max) parts.push(`step ${live.value} of ${live.max}`);
    parts.push(`node ${Math.min((live.nodes_done || 0) + (live.node ? 1 : 0), live.nodes_total || 0)} of ${live.nodes_total || 0}`);
    return parts.join(" · ");
}

export const FarmMixin = {

    // ── the tab kind ─────────────────────────────────────────────────────────

    _farmTabKind() {
        return {
            restore: () => ({ data: null, view: "machines" }),
            build: (rec) => this._farmBuild(rec),
            shown: (rec) => { this._farmPollStart(rec); },
            isDirty: () => false,
            dispose: (rec) => { this._farmPollStop(rec); rec.ui = null; },
        };
    },

    /** "Open Farm…": the Farm tab. */
    farmOpen(view) {
        const { rec } = this.vtOpen("farm", FARM_PREFIX, "Farm", { data: null, view: view || "machines" });
        if (view && rec.ui) this._farmView(rec, view);
        return rec;
    },

    /** "Render on farm…" from the canvas or the bar: the Farm tab with the render dialog over it. */
    async farmRenderDialog() {
        const rec = this.farmOpen();
        if (!rec.data) await this._farmLoad(rec);
        this._farmRenderDlg(rec);
    },

    _farmRec() { return this._vtState().tabs[FARM_PREFIX] || null; },

    // ── talking to the host ──────────────────────────────────────────────────

    async _farmLoad(rec) {
        let data = null;
        try {
            const res = await api.fetchApi("/imageviewer/farm");
            data = await res.json().catch(() => null);
            if (!res.ok && data && !data.error) data.error = `the viewer answered ${res.status}`;
        } catch (e) { data = { ok: false, offline: true, error: "the viewer backend did not answer" }; }
        rec.data = data || { ok: false, error: "nothing came back" };
        this._farmRender(rec);
        return rec.data;
    },

    async _farmPost(rec, body, { quiet = false } = {}) {
        let out = null, err = "";
        try {
            const res = await api.fetchApi("/imageviewer/farm", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            out = await res.json().catch(() => null);
            if (!res.ok || (out && out.ok === false)) err = (out && out.error) || `the viewer answered ${res.status}`;
        } catch (e) { err = "the viewer backend did not answer"; }
        if (out && out.state && !err) { rec.data = { ok: true, ...out.state }; this._farmRender(rec); }
        if (err && !quiet) this._farmToast(rec, err, "error");
        return err ? { error: err } : (out || {});
    },

    _farmPollStart(rec) {
        this._farmPollStop(rec);
        const tick = async () => {
            rec.pollTimer = null;
            if (!rec.ui || this.activeTab !== FARM_PREFIX) return;
            await this._farmLoad(rec);
            if (rec.ui && this.activeTab === FARM_PREFIX) rec.pollTimer = this._viewerWindow().setTimeout(tick, POLL_MS);
        };
        tick();
    },

    _farmPollStop(rec) {
        if (rec && rec.pollTimer) { this._viewerWindow().clearTimeout(rec.pollTimer); rec.pollTimer = null; }
    },

    // ── the page ─────────────────────────────────────────────────────────────

    _farmBuild(rec) {
        const doc = rec.el.ownerDocument;
        const h = (tag, cls, text) => {
            const e = doc.createElement(tag);
            if (cls) e.className = cls;
            if (text != null) e.textContent = text;
            return e;
        };
        const root = h("div", "fm-root");
        const bar = h("div", "fm-bar");
        const title = h("div", "fm-title", "Farm");
        const spend = h("div", "fm-spend");
        const meter = h("div", "fm-meter");
        const fill = h("div", "fm-meter-fill");
        meter.append(fill);
        const spendText = h("div", "fm-spend-text");
        spend.append(meter, spendText);
        const tabs = h("div", "fm-tabs");
        const views = {};
        for (const [id, label] of [["machines", "Machines"], ["queue", "Queue"], ["storage", "Storage"], ["setup", "Setup"]]) {
            const b = h("button", "fm-tab", label);
            b.dataset.view = id;
            b.onclick = () => this._farmView(rec, id);
            tabs.append(b);
            views[id] = b;
        }
        const add = h("button", "fm-btn fm-primary fm-add", "Add machines…");
        add.onclick = () => this._farmAddDlg(rec);
        const render = h("button", "fm-btn fm-render", "Render this workflow…");
        render.onclick = () => this._farmRenderDlg(rec);
        bar.append(title, tabs, spend, render, add);
        const body = h("div", "fm-body");
        const note = h("div", "fm-note");
        const machines = h("div", "fm-page fm-machines");
        const queue = h("div", "fm-page fm-queue");
        const storage = h("div", "fm-page fm-storage");
        const setup = h("div", "fm-page fm-setup");
        body.append(note, machines, queue, storage, setup);
        const toast = h("div", "fm-toast");
        root.append(bar, body, toast);
        rec.el.append(root);
        rec.ui = { root, bar, spend, fill, spendText, tabs: views, body, note, machines, queue, storage, setup, toast, h };
        this._farmView(rec, rec.view || "machines");
        this._farmRender(rec);
    },

    _farmView(rec, view) {
        rec.view = view;
        const ui = rec.ui;
        if (!ui) return;
        for (const [id, b] of Object.entries(ui.tabs)) b.classList.toggle("on", id === view);
        ui.machines.style.display = view === "machines" ? "" : "none";
        ui.queue.style.display = view === "queue" ? "" : "none";
        ui.storage.style.display = view === "storage" ? "" : "none";
        ui.setup.style.display = view === "setup" ? "" : "none";
        if (view === "setup") this._farmSetup(rec, true);
        if (view === "storage") this._farmStorage(rec, true);
    },

    _farmToast(rec, text, kind = "info") {
        const ui = rec.ui;
        if (!ui) return;
        ui.toast.textContent = text;
        ui.toast.className = `fm-toast show ${kind}`;
        const w = this._viewerWindow();
        w.clearTimeout(rec.toastTimer);
        rec.toastTimer = w.setTimeout(() => { if (rec.ui) rec.ui.toast.className = "fm-toast"; }, kind === "error" ? 7000 : 3500);
    },

    _farmRender(rec) {
        const ui = rec.ui, d = rec.data;
        if (!ui) return;
        if (!d) { ui.note.textContent = "Reading the farm…"; ui.note.className = "fm-note show"; return; }
        if (d.offline || d.ok === false) {
            ui.note.textContent = d.offline
                ? `The farm is run by the agentY host, which is not answering: ${d.error || ""} Start agentY, and the farm comes back as it was.`
                : `The farm could not be read: ${d.error || "no answer"}`;
            ui.note.className = "fm-note show warn";
            ui.root.classList.add("offline");
            return;
        }
        ui.root.classList.remove("offline");
        const keys = d.keys || {};
        const machines = d.machines || [];
        if (!machines.length && !keys.vast && !keys.runpod) {
            ui.note.textContent = "No machines yet. Add a ComfyUI by its address, or set a vast.ai or RunPod key in Setup to rent GPUs from here.";
            ui.note.className = "fm-note show";
        } else ui.note.className = "fm-note";
        const sp = d.spend || {};
        const lvl = spendLevel(sp);
        ui.fill.style.width = `${Math.round(lvl.share * 100)}%`;
        ui.spend.classList.toggle("warn", lvl.warn && !lvl.over);
        ui.spend.classList.toggle("over", lvl.over);
        ui.spendText.textContent = `Today ${money(sp.today)} of ${money(sp.cap)}` + (sp.per_hour ? ` · ${money(sp.per_hour)}/h running` : " · nothing running");
        const busy = (d.jobs || []).filter((j) => j.state === "running" || j.state === "queued").length;
        ui.tabs.queue.textContent = busy ? `Queue (${busy})` : "Queue";
        ui.tabs.machines.textContent = machines.length ? `Machines (${machines.length})` : "Machines";
        this._farmMachines(rec);
        this._farmQueue(rec);
        const vols = d.volumes || [];
        ui.tabs.storage.textContent = vols.length ? `Storage (${vols.length})` : "Storage";
        if (rec.view === "storage") this._farmStorage(rec, false);
        if (rec.view === "setup") this._farmSetup(rec, false);
    },

    _farmMachines(rec) {
        const ui = rec.ui, h = ui.h, d = rec.data;
        ui.machines.textContent = "";
        const machines = d.machines || [];
        const grid = h("div", "fm-grid");
        for (const m of machines) grid.append(this._farmCard(rec, m));
        const addCard = h("button", "fm-card fm-card-add");
        addCard.append(h("div", "fm-plus", "+"), h("div", "", "Add machines"));
        addCard.onclick = () => this._farmAddDlg(rec);
        grid.append(addCard);
        ui.machines.append(grid);
    },

    _farmCard(rec, m) {
        const h = rec.ui.h;
        const st = machineShownState(m);
        const card = h("div", `fm-card st-${st}`);
        card.dataset.id = m.id;
        const head = h("div", "fm-card-head");
        const dot = h("span", `fm-dot st-${st}`);
        const name = h("div", "fm-card-name", m.name || m.id);
        const prov = h("span", `fm-prov p-${m.provider}`, PROVIDER_LABEL[m.provider] || m.provider);
        head.append(dot, name, prov);
        const gpu = h("div", "fm-card-gpu", m.gpu_seen || m.gpu || "GPU not known yet");
        const stateLine = h("div", "fm-card-state", STATE_LABEL[st] || st);
        if (st === "busy" && m.state_note) stateLine.textContent = `Rendering ${m.state_note}`;
        const facts = h("div", "fm-facts");
        const fact = (k, v) => { const r = h("div", "fm-fact"); r.append(h("span", "k", k), h("span", "v", v)); facts.append(r); };
        fact("Rate", m.provider === "url" && !m.usd_per_hour ? "—" : `${money(m.usd_per_hour)}/h`);
        fact("Up", m.uptime_s ? since(m.uptime_s) : "—");
        fact("Cost", m.provider === "url" && !m.cost_usd ? "—" : money(m.cost_usd));
        fact("Renders", `${m.done || 0}` + (m.failed ? ` · ${m.failed} failed` : ""));
        if (m.region) fact("Where", m.region);
        card.append(head, gpu, stateLine);
        if (m.live) card.append(this._farmLive(rec, m.live));
        card.append(facts);
        if (m.parity) {
            const p = m.parity;
            const badge = h("div", `fm-parity ${p.ok ? "ok" : "bad"}`,
                p.ok ? "Workflow checked: nothing missing"
                    : `Missing ${p.missing_nodes.length} node type${p.missing_nodes.length === 1 ? "" : "s"}, ${p.missing_models.length} model${p.missing_models.length === 1 ? "" : "s"}`);
            badge.title = [...(p.missing_nodes || []), ...(p.missing_models || [])].join("\n");
            card.append(badge);
        }
        if (m.error) card.append(h("div", "fm-card-err", m.error));
        if (m.provider_error) card.append(h("div", "fm-card-err", m.provider_error));
        if (m.volume_note) card.append(h("div", "fm-card-vol", m.volume_note));
        const acts = h("div", "fm-acts");
        const act = (label, cls, fn, title) => {
            const b = h("button", `fm-btn ${cls || ""}`, label);
            if (title) b.title = title;
            b.onclick = (e) => { e.stopPropagation(); fn(b); };
            acts.append(b);
            return b;
        };
        const rented = m.provider !== "url";
        if (rented && (m.state === "stopped" || m.state === "gone")) {
            act("Start", "fm-primary", () => this._farmPost(rec, { action: "start", id: m.id }));
        } else if (rented) {
            act("Stop", "", () => this._farmPost(rec, { action: "stop", id: m.id }), "Stop billing for the GPU; the disk is kept (a few cents a day)");
        }
        if (m.url) {
            act("Open ComfyUI", "", async () => {
                // The farm image asks for the machine's token: fetch the address with it, then open it.
                const w = this._viewerWindow().open("", "_blank");
                const r = await this._farmPost(rec, { action: "open_url", id: m.id }, { quiet: true });
                if (!w) return;
                if (r.url) { w.opener = null; w.location.href = r.url; } else w.close();
            }, m.url);
        }
        act("Check workflow", "", async (b) => {
            const wf = await this._farmWorkflow(rec);
            if (!wf) return;
            b.disabled = true;
            const r = await this._farmPost(rec, { action: "parity", id: m.id, workflow: wf });
            b.disabled = false;
            if (r.parity) this._farmToast(rec, r.parity.ok ? `${m.name} has everything this workflow needs.`
                : `${m.name} lacks: ${[...r.parity.missing_nodes, ...r.parity.missing_models].slice(0, 6).join(", ")}`, r.parity.ok ? "info" : "warn");
        }, "Compare this canvas's node types and model files with the machine's");
        if (rented) {
            act("Terminate", "fm-danger", () => this._farmConfirm(rec, `Terminate ${m.name}?`,
                "The machine and its disk are destroyed at the provider and billing ends. A render on it goes back to the queue.",
                "Terminate", () => this._farmPost(rec, { action: "terminate", id: m.id })));
        } else {
            act("Remove", "fm-danger", () => this._farmPost(rec, { action: "remove", id: m.id }), "Take it out of the farm (the machine itself is not touched)");
        }
        card.append(acts);
        return card;
    },

    /** The render a machine runs, as its feed tells it: the newest preview, the node and its steps, nodes done. */
    _farmLive(rec, live, small = false) {
        const h = rec.ui.h;
        const box = h("div", `fm-live${small ? " small" : ""}`);
        if (live.preview) {
            const img = h("img", "fm-live-img");
            img.src = live.preview;
            img.alt = "preview";
            img.draggable = false;
            box.append(img);
        } else if (!small) box.append(h("div", "fm-live-img none", live.started ? "No preview from this machine" : "Waiting to start…"));
        if (!live.started) return box;
        const share = farmLiveShare(live);
        const bar = h("div", "fm-live-bar");
        const fill = h("div", "fm-live-fill");
        fill.style.width = `${Math.round(share * 100)}%`;
        bar.append(fill);
        box.append(bar);
        if (!small) box.append(h("div", "fm-live-text", farmLiveText(live)));
        box.title = farmLiveText(live);
        return box;
    },

    _farmQueue(rec) {
        const ui = rec.ui, h = ui.h, d = rec.data;
        ui.queue.textContent = "";
        const jobs = d.jobs || [];
        if (!jobs.length) {
            ui.queue.append(h("div", "fm-empty", "Nothing rendered yet. “Render this workflow…” sends the canvas's workflow to the farm, as many times as you ask."));
            return;
        }
        const names = Object.fromEntries((d.machines || []).map((m) => [m.id, m.name]));
        for (const j of jobs) {
            const row = h("div", `fm-job st-${j.state}`);
            row.dataset.id = j.id;
            const top = h("div", "fm-job-top");
            const done = (j.counts && j.counts.done) || 0;
            const name = h("div", "fm-job-name", j.name);
            const meta = h("div", "fm-job-meta", `${done} of ${j.batch} done · ${j.seed_mode} seeds · ${ago(j.created)}`);
            const stateEl = h("span", `fm-job-state st-${j.state}`, j.state);
            top.append(name, stateEl, meta);
            const prog = h("div", "fm-prog");
            const pf = h("div", "fm-prog-fill");
            pf.style.width = `${Math.round((done / Math.max(1, j.batch)) * 100)}%`;
            prog.append(pf);
            const chips = h("div", "fm-chips");
            for (const t of j.tasks || []) {
                const c = h("span", `fm-chip st-${t.state}`, String(t.i + 1));
                c.title = [`Render ${t.i + 1}: ${TASK_LABEL[t.state] || t.state}`, t.seed != null ? `seed ${t.seed}` : "",
                    t.machine ? `on ${names[t.machine] || t.machine}` : "", t.error || "",
                    (t.outputs || []).map((p) => String(p).split(/[\\/]/).pop()).join(", ")].filter(Boolean).join("\n");
                chips.append(c);
            }
            const acts = h("div", "fm-acts");
            const act = (label, cls, body) => {
                const b = h("button", `fm-btn ${cls}`, label);
                b.onclick = () => this._farmPost(rec, body);
                acts.append(b);
            };
            if (j.state === "running" || j.state === "queued") act("Cancel", "", { action: "cancel", id: j.id });
            if ((j.counts && (j.counts.failed || j.counts.cancelled))) act("Retry", "", { action: "retry", id: j.id });
            if (j.state !== "running" && j.state !== "queued") act("Remove", "fm-quiet", { action: "remove_job", id: j.id });
            row.append(top, prog, chips);
            const running = (d.machines || []).filter((m) => m.task && m.task.job === j.id && m.live)
                .sort((a, b) => a.task.i - b.task.i);
            if (running.length) {
                const strip = h("div", "fm-livestrip");
                for (const m of running) {
                    const cell = h("div", "fm-livecell");
                    cell.append(this._farmLive(rec, m.live, true), h("div", "fm-livecap", `#${m.task.i + 1} · ${m.name}`));
                    strip.append(cell);
                }
                row.append(strip);
            }
            row.append(acts);
            const err = (j.tasks || []).find((t) => t.state === "failed" && t.error);
            if (err) row.append(h("div", "fm-card-err", `Render ${err.i + 1}: ${err.error}`));
            ui.queue.append(row);
        }
    },

    _farmSetup(rec, rebuild) {
        const ui = rec.ui, h = ui.h, d = rec.data;
        if (!d || d.ok === false) return;
        // typing, or edits not saved yet: the refresh leaves the form alone (it used to wipe an edit once the field
        // lost focus, so Save sent the old values)
        if (!rebuild && (ui.setupDirty || ui.setup.contains(ui.setup.ownerDocument.activeElement))) return;
        ui.setupDirty = false;
        ui.setup.textContent = "";
        const st = d.settings || {}, keys = d.keys || {};
        const sec = (title, text) => {
            const s = h("div", "fm-sec");
            s.append(h("div", "fm-sec-title", title));
            if (text) s.append(h("div", "fm-sec-text", text));
            ui.setup.append(s);
            return s;
        };
        const k = sec("Provider keys", "The keys live in agentY's .env file on the machine that runs agentY, never in the viewer. "
            + "Add a line, then restart the agentY host:");
        for (const [p, env] of [["vast", "VAST_API_KEY"], ["runpod", "RUNPOD_API_KEY"]]) {
            const r = h("div", "fm-keyrow");
            r.append(h("span", `fm-dot ${keys[p] ? "st-ready" : "st-stopped"}`), h("span", "fm-keyname", PROVIDER_LABEL[p]),
                h("code", "", `${env}=…`), h("span", "fm-keystate", keys[p] ? "set" : "not set"));
            k.append(r);
        }
        const f = sec("Spending and machines", "");
        const form = h("div", "fm-form");
        const fields = [
            ["daily_cap_usd", "Daily cap ($)", "number", "Every rented machine is stopped when today's spend reaches it."],
            ["max_usd_per_hour", "Most per hour ($)", "number", "Offers dearer than this are not rented."],
            ["idle_stop_minutes", "Stop when idle (minutes)", "number", "A rented machine with nothing to render is stopped after this. 0 = never."],
            ["eu_only", "EU machines only", "checkbox", "Offers outside the EU (and Norway, Switzerland, the UK) are left out."],
            ["gpu", "GPU to look for", "text", "Part of the name, any case (5090), or with * as a wildcard (RTX 50*, *PRO 6000*). Empty = every GPU."],
            ["image", "Machine image", "text", "The Docker image every machine starts from. Empty = the agentY farm image (ComfyUI with the farm helper)."],
            ["disk_gb", "Disk (GB)", "number", "Room for the models the workflows need."],
            ["retries", "Retries on another machine", "number", "A render that fails is tried this many more times."],
            ["keep_models", "Keep models on storage", "checkbox", "Machines are rented with provider storage and keep the models there for the next one. See Storage."],
            ["volume_gb", "Volume size (GB)", "number", "The size of a volume the farm makes on its own. Room for every model you render with."],
        ];
        const inputs = {};
        for (const [key, label, type, help] of fields) {
            const row = h("label", "fm-field");
            const inp = h("input", "");
            inp.type = type;
            inp.dataset.key = key;
            if (type === "checkbox") inp.checked = !!st[key]; else inp.value = st[key] == null ? "" : String(st[key]);
            if (type === "number") { inp.min = "0"; inp.step = key.endsWith("usd") || key === "max_usd_per_hour" ? "0.5" : "1"; }
            if (key === "image") inp.placeholder = "registry/name:tag";
            inp.addEventListener(type === "checkbox" ? "change" : "input", () => { ui.setupDirty = true; });
            inputs[key] = inp;
            row.append(h("span", "fm-field-label", label), inp, h("span", "fm-field-help", help));
            form.append(row);
        }
        const save = h("button", "fm-btn fm-primary", "Save");
        save.onclick = async () => {
            const patch = {};
            for (const [key, inp] of Object.entries(inputs)) patch[key] = inp.type === "checkbox" ? inp.checked : inp.value;
            const r = await this._farmPost(rec, { action: "settings", settings: patch });
            if (!r.error) { this._farmToast(rec, "Saved."); this._farmSetup(rec, true); }
        };
        f.append(form, save);
        const days = Object.entries((d.spend && d.spend.days) || {});
        if (days.length) {
            const s = sec("Spent per day", "");
            const max = Math.max(0.01, ...days.map(([, v]) => v));
            const chart = h("div", "fm-days");
            for (const [day, v] of days) {
                const col = h("div", "fm-day");
                const b = h("div", "fm-day-bar");
                b.style.height = `${Math.max(2, Math.round((v / max) * 60))}px`;
                col.title = `${day}: ${money(v)}`;
                col.append(b, h("div", "fm-day-label", day.slice(5)));
                chart.append(col);
            }
            s.append(chart);
        }
    },

    // ── dialogs ──────────────────────────────────────────────────────────────

    _farmDialog(rec, title, cls = "") {
        const ui = rec.ui, h = ui.h;
        ui.root.querySelectorAll(".fm-shade").forEach((n) => n.remove());
        const shade = h("div", "fm-shade");
        const box = h("div", `fm-dlg ${cls}`);
        const head = h("div", "fm-dlg-head");
        const close = h("button", "fm-x", "×");
        close.title = "Close";
        close.onclick = () => shade.remove();
        head.append(h("div", "fm-dlg-title", title), close);
        const body = h("div", "fm-dlg-body");
        const foot = h("div", "fm-dlg-foot");
        box.append(head, body, foot);
        shade.append(box);
        shade.addEventListener("pointerdown", (e) => { if (e.target === shade) shade.remove(); });
        shade.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") shade.remove(); });
        ui.root.append(shade);
        return { shade, box, body, foot, h };
    },

    _farmConfirm(rec, title, text, label, fn) {
        const d = this._farmDialog(rec, title, "fm-confirm");
        d.body.append(d.h("div", "fm-sec-text", text));
        const no = d.h("button", "fm-btn", "Cancel");
        no.onclick = () => d.shade.remove();
        const yes = d.h("button", "fm-btn fm-danger-solid", label);
        yes.onclick = async () => { yes.disabled = true; await fn(); d.shade.remove(); };
        d.foot.append(no, yes);
        return d;
    },

    // ── storage ──────────────────────────────────────────────────────────────

    _farmStorage(rec, rebuild) {
        const ui = rec.ui, h = ui.h, d = rec.data;
        if (!d || d.ok === false) return;
        const vols = d.volumes || [];
        const sig = JSON.stringify(vols) + JSON.stringify(d.keys || {}) + String((d.settings || {}).keep_models);
        if (!rebuild && (ui.storageSig === sig || ui.storage.contains(ui.storage.ownerDocument.activeElement))) return;
        ui.storageSig = sig;
        ui.storage.textContent = "";
        const st = d.settings || {}, keys = d.keys || {};
        const intro = h("div", "fm-sec");
        intro.append(h("div", "fm-sec-title", "Storage for models"),
            h("div", "fm-sec-text", (st.keep_models ? "On: new machines are rented with storage, and the models they download stay there. "
                : "Off: every new machine downloads its models again (billed GPU time, and some vast.ai hosts charge for the traffic). Switch it on in Setup. ")
                + "A vast.ai volume lives on one machine, so only offers on that machine find the models; a RunPod network volume "
                + "belongs to a data centre, and pods are placed there."));
        ui.storage.append(intro);
        if (!vols.length) ui.storage.append(h("div", "fm-sec-text fm-empty", "No volumes yet."));
        for (const v of vols) ui.storage.append(this._farmVolumeCard(rec, v));
        const make = h("div", "fm-sec");
        make.append(h("div", "fm-sec-title", "Make a volume"));
        const row = h("div", "fm-mkvol");
        const prov = h("select", "fm-select");
        for (const [p, label] of [["vast", "vast.ai"], ["runpod", "RunPod"]]) {
            const o = h("option", "", label + (keys[p] ? "" : " (no key)"));
            o.value = p; o.disabled = !keys[p];
            prov.append(o);
        }
        if (!keys.vast && keys.runpod) prov.value = "runpod";
        const size = h("input", "fm-num");
        size.type = "number"; size.min = "10"; size.step = "10"; size.value = String(st.volume_gb || 150);
        const go = h("button", "fm-btn", "Find storage");
        const list = h("div", "fm-offers fm-voloffers");
        go.onclick = async () => {
            list.textContent = "Reading offers…";
            const r = await this._farmPost(rec, { action: "volume_offers", provider: prov.value }, { quiet: true });
            list.textContent = "";
            if (r.error) { list.append(h("div", "fm-card-err", r.error)); return; }
            const offers = r.offers || [];
            if (!offers.length) { list.append(h("div", "fm-sec-text", "No storage on offer right now.")); return; }
            for (const o of offers) {
                const line = h("div", "fm-offer fm-voloffer");
                const per = Number(o.usd_per_gb_month) || 0;
                line.append(h("span", "", o.region || o.where || "—"),
                    h("span", "", o.machine_id ? `machine ${o.machine_id}` : "data centre"),
                    h("span", "", o.free_gb ? `${o.free_gb} GB free` : ""),
                    h("span", "fm-price", per ? `${money(per * (Number(size.value) || 0))}/month` : "—"));
                const b = h("button", "fm-btn fm-primary", "Make");
                b.onclick = () => this._farmConfirm(rec, `Make a ${size.value} GB volume${o.region ? " in " + o.region : ""}?`,
                    (o.machine_id ? "It lives on that one machine: rent GPUs there to use it. Its size cannot change later. " : "Pods that use it run in this data centre. ")
                    + "It bills storage every month until you delete it, also while no machine runs.",
                    "Make", async () => {
                        const res = await this._farmPost(rec, { action: "create_volume", provider: o.provider, offer_id: o.offer_id || "",
                            where: o.where || "", size_gb: Number(size.value) || 0 });
                        if (!res.error) { this._farmToast(rec, "Volume made."); this._farmStorage(rec, true); }
                    });
                line.append(b);
                list.append(line);
            }
        };
        row.append(prov, h("span", "fm-field-label", "Size (GB)"), size, go);
        make.append(row, list);
        ui.storage.append(make);
    },

    _farmVolumeCard(rec, v) {
        const h = rec.ui.h;
        const card = h("div", "fm-card fm-volume");
        card.dataset.id = v.id;
        const top = h("div", "fm-card-head");
        top.append(h("span", "fm-card-name", v.name || v.id), h("span", "fm-chip", PROVIDER_LABEL[v.provider] || v.provider));
        card.append(top);
        const where = v.provider === "vast" ? `machine ${v.where}${v.region ? " · " + v.region : ""}` : `data centre ${v.where}`;
        const cost = v.usd_per_month ? `${money(v.usd_per_month)}/month` : "storage cost on vast.ai";
        card.append(h("div", "fm-card-line", `${Math.round(v.size_gb)} GB · ${where} · ${cost}`));
        const used = (v.machines || []).length ? `Used by ${v.machines.join(", ")}` : "No machine uses it";
        card.append(h("div", "fm-card-line", used));
        const models = v.models || [];
        if (models.length) {
            const det = h("details", "fm-vol-models");
            det.append(h("summary", "", `${models.length} model${models.length === 1 ? "" : "s"} · ${v.models_gb} GB`));
            for (const name of models) det.append(h("div", "fm-vol-model", name));
            card.append(det);
        } else card.append(h("div", "fm-card-line fm-dim", v.models_at ? "No models on it yet" : "Models show once a machine with it is ready"));
        const acts = h("div", "fm-acts");
        if (v.provider === "runpod") {
            const grow = h("button", "fm-btn", "Grow…");
            grow.onclick = () => {
                const size = h("input", "fm-num");
                size.type = "number"; size.min = String(Math.round(v.size_gb) + 10); size.step = "10";
                size.value = String(Math.round(v.size_gb) + 50);
                const dlg = this._farmConfirm(rec, `Grow ${v.name}`, "A network volume can grow, not shrink. RunPod bills about $0.07 per GB a month.",
                    "Grow", async () => {
                        const res = await this._farmPost(rec, { action: "resize_volume", id: v.id, size_gb: Number(size.value) || 0 });
                        if (!res.error) this._farmToast(rec, `${v.name} is now ${size.value} GB.`);
                    });
                if (dlg && dlg.body) dlg.body.append(size);
            };
            acts.append(grow);
        }
        const del = h("button", "fm-btn fm-danger", "Delete");
        del.disabled = (v.machines || []).length > 0;
        if (del.disabled) del.title = "Terminate the machines that use it first";
        del.onclick = () => this._farmConfirm(rec, `Delete ${v.name}?`,
            `The ${models.length || "stored"} model${models.length === 1 ? "" : "s"} on it are gone for good; the next machine downloads them again.`,
            "Delete", async () => {
                const res = await this._farmPost(rec, { action: "delete_volume", id: v.id });
                if (!res.error) this._farmToast(rec, `${v.name} deleted.`);
            });
        acts.append(del);
        card.append(acts);
        return card;
    },

    _farmAddDlg(rec) {
        const st = (rec.data && rec.data.settings) || {}, keys = (rec.data && rec.data.keys) || {};
        const d = this._farmDialog(rec, "Add machines", "fm-add-dlg");
        const h = d.h;
        const tabs = h("div", "fm-seg");
        const panes = {};
        const pick = (p) => {
            for (const b of tabs.children) b.classList.toggle("on", b.dataset.p === p);
            for (const [k, el] of Object.entries(panes)) el.style.display = k === p ? "" : "none";
        };
        for (const p of ["vast", "runpod", "url"]) {
            const b = h("button", "fm-seg-btn", PROVIDER_LABEL[p]);
            b.dataset.p = p;
            b.onclick = () => pick(p);
            tabs.append(b);
        }
        d.body.append(tabs);
        for (const p of ["vast", "runpod"]) {
            const pane = h("div", "fm-pane");
            panes[p] = pane;
            if (!keys[p]) {
                pane.append(h("div", "fm-sec-text", `No ${p === "vast" ? "VAST_API_KEY" : "RUNPOD_API_KEY"} is set on the agentY host. Put it in agentY's .env (Setup says how) to rent ${PROVIDER_LABEL[p]} GPUs from here.`));
                d.body.append(pane);
                continue;
            }
            const row = h("div", "fm-row");
            const gpu = h("input", "fm-gpu");
            gpu.value = st.gpu || "";
            gpu.placeholder = "GPU, e.g. 5090 or RTX 50*";
            gpu.title = "Part of the GPU name (any case), or * as a wildcard: RTX 50*, *PRO 6000*. Empty = every GPU.";
            const go = h("button", "fm-btn fm-primary", "Find offers");
            const where = h("span", "fm-sec-text", st.eu_only ? "EU only" : "Any region");
            row.append(gpu, go, where);
            const table = h("div", "fm-offers");
            pane.append(row, table);
            go.onclick = async () => {
                table.textContent = "Asking…";
                const r = await this._farmPost(rec, { action: "offers", provider: p, gpu: gpu.value }, { quiet: true });
                table.textContent = "";
                if (r.error) { table.append(h("div", "fm-card-err", r.error)); return; }
                this._farmOffers(rec, d, table, r.offers || []);
            };
            d.body.append(pane);
        }
        const pane = h("div", "fm-pane fm-form");
        panes.url = pane;
        const field = (label, ph, type = "text") => {
            const row = h("label", "fm-field");
            const inp = h("input", "");
            inp.type = type;
            inp.placeholder = ph;
            row.append(h("span", "fm-field-label", label), inp);
            pane.append(row);
            return inp;
        };
        const url = field("Address", "http://192.168.1.20:8188");
        const name = field("Name", "office-4090");
        const token = field("Token (optional)", "sent as Authorization: Bearer …", "password");
        const rate = field("$ per hour (optional)", "0", "number");
        const add = h("button", "fm-btn fm-primary", "Add");
        add.onclick = async () => {
            const r = await this._farmPost(rec, { action: "add_url", url: url.value, name: name.value, token: token.value,
                usd_per_hour: Number(rate.value) || 0 });
            if (!r.error) { d.shade.remove(); this._farmToast(rec, `${r.machine ? r.machine.name : "Machine"} added.`); }
        };
        pane.append(add);
        d.body.append(pane);
        pick(keys.vast ? "vast" : keys.runpod ? "runpod" : "url");
        return d;
    },

    _farmOffers(rec, d, table, offers) {
        const h = d.h;
        if (!offers.length) { table.append(h("div", "fm-sec-text", "No offers for that GPU right now.")); return; }
        const head = h("div", "fm-offer fm-offer-head");
        for (const c of ["GPU", "VRAM", "Where", "Reliability", "Down", "$/h", ""]) head.append(h("span", "", c));
        table.append(head);
        for (const o of offers) {
            const r = h("div", `fm-offer${o.too_dear ? " dear" : ""}`);
            const gpuCell = h("span", "", o.gpu);
            if (o.has_volume) { gpuCell.append(h("span", "fm-badge", "models here")); gpuCell.title = "One of your volumes is on this machine"; }
            r.append(gpuCell, h("span", "", o.vram_gb ? `${o.vram_gb} GB` : "—"), h("span", "", o.region || "—"),
                h("span", "", o.reliability ? `${Math.round(o.reliability * 100)}%` : "—"),
                h("span", "", o.down_mbps ? `${o.down_mbps} Mb/s` : "—"), h("span", "fm-price", money(o.usd_per_hour)));
            const b = h("button", "fm-btn fm-primary", o.too_dear ? "Too dear" : "Rent");
            b.disabled = !!o.too_dear;
            if (o.too_dear) b.title = "Above the most per hour in Setup";
            b.onclick = () => {
                const idle = (rec.data.settings || {}).idle_stop_minutes;
                this._farmConfirm(rec, `Rent ${o.gpu} for ${money(o.usd_per_hour)}/h?`,
                    `It bills from now until it is stopped or terminated. The farm stops it after ${idle} idle minute${idle === 1 ? "" : "s"}`
                    + ` and at the daily cap of ${money((rec.data.settings || {}).daily_cap_usd)}.`,
                    "Rent", async () => {
                        const res = await this._farmPost(rec, { action: "rent", provider: o.provider, offer_id: o.offer_id,
                            usd_per_hour: o.usd_per_hour, gpu: o.gpu, region: o.region });
                        if (!res.error) this._farmToast(rec, `Renting ${o.gpu}: it shows Ready once ComfyUI answers.`);
                    });
            };
            r.append(b);
            table.append(r);
        }
    },

    /** The canvas's workflow in API format (ComfyUI's own graphToPrompt), or null with a word to the user. */
    async _farmWorkflow(rec) {
        try {
            const p = await app.graphToPrompt();
            const wf = p && (p.output || p);
            rec.farmModelUrls = this._farmModelUrls(p && p.workflow);
            if (wf && typeof wf === "object" && Object.keys(wf).length) return wf;
        } catch (e) { console.warn("imageViewer: graphToPrompt", e); }
        this._farmToast(rec, "The canvas has no workflow to send.", "warn");
        return null;
    },

    /** Download addresses the workflow carries (ComfyUI templates list them per loader node under
     *  properties.models), as {"folder/name": url}: a farm machine that lacks a model downloads it from there. */
    _farmModelUrls(graph) {
        const out = {};
        const walk = (nodes) => {
            for (const n of nodes || []) {
                for (const mo of ((n && n.properties && n.properties.models) || [])) {
                    if (mo && mo.name && mo.directory && /^https:\/\//.test(mo.url || "")) out[`${mo.directory}/${mo.name}`] = mo.url;
                }
            }
        };
        walk(graph && graph.nodes);
        for (const sg of ((graph && graph.definitions && graph.definitions.subgraphs) || [])) walk(sg.nodes);
        for (const mo of ((graph && graph.models) || [])) {
            if (mo && mo.name && mo.directory && /^https:\/\//.test(mo.url || "")) out[`${mo.directory}/${mo.name}`] = mo.url;
        }
        return out;
    },

    _farmRenderDlg(rec) {
        const data = rec.data || {};
        const machines = (data.machines || []).filter((m) => m.state !== "gone");
        const d = this._farmDialog(rec, "Render on the farm", "fm-render-dlg");
        const h = d.h;
        const form = h("div", "fm-form");
        const field = (label, el, help) => {
            const row = h("label", "fm-field");
            row.append(h("span", "fm-field-label", label), el);
            if (help) row.append(h("span", "fm-field-help", help));
            form.append(row);
            return el;
        };
        const name = h("input", "");
        name.value = (app.graph && app.graph.extra && app.graph.extra.title) || (app.workflowManager && app.workflowManager.activeWorkflow
            && app.workflowManager.activeWorkflow.filename) || "Farm render";
        field("Name", name);
        const batch = h("input", "");
        batch.type = "number"; batch.min = "1"; batch.max = "256"; batch.value = "4";
        field("Renders", batch, "Each one is the whole workflow with its own seed.");
        const seed = h("select", "");
        for (const [v, l] of SEED_MODES) { const o = h("option", "", l); o.value = v; seed.append(o); }
        field("Seeds", seed);
        const list = h("div", "fm-mlist");
        const boxes = [];
        for (const m of machines) {
            const r = h("label", "fm-mrow");
            const cb = h("input", "");
            cb.type = "checkbox";
            cb.checked = true;
            cb.value = m.id;
            boxes.push(cb);
            const st = machineShownState(m);
            r.append(cb, h("span", `fm-dot st-${st}`), h("span", "fm-mname", m.name), h("span", "fm-sec-text",
                `${m.gpu_seen || m.gpu || ""} ${m.usd_per_hour ? "· " + money(m.usd_per_hour) + "/h" : ""} · ${STATE_LABEL[st] || st}`));
            list.append(r);
        }
        if (!machines.length) list.append(h("div", "fm-sec-text", "No machines in the farm yet: the renders wait in the queue until one is added and ready."));
        field("Machines", list);
        const est = h("div", "fm-est");
        const upd = () => {
            const n = Math.max(1, Number(batch.value) || 1);
            const on = machines.filter((m) => boxes.find((b) => b.value === m.id && b.checked));
            const rate = on.reduce((s, m) => s + (Number(m.usd_per_hour) || 0), 0);
            est.textContent = on.length
                ? `${n} render${n === 1 ? "" : "s"} over ${on.length} machine${on.length === 1 ? "" : "s"} (${money(rate)}/h together while they run). The renders come back into the History under “Farm”.`
                : "Pick at least one machine, or none to let any machine take them.";
        };
        batch.oninput = upd;
        boxes.forEach((b) => { b.onchange = upd; });
        upd();
        d.body.append(form, est);
        const cancel = h("button", "fm-btn", "Cancel");
        cancel.onclick = () => d.shade.remove();
        const go = h("button", "fm-btn fm-primary", "Render");
        go.onclick = async () => {
            const wf = await this._farmWorkflow(rec);
            if (!wf) return;
            go.disabled = true;
            const picked = boxes.filter((b) => b.checked).map((b) => b.value);
            const r = await this._farmPost(rec, { action: "submit", workflow: wf, name: name.value, batch: Number(batch.value) || 1,
                seed_mode: seed.value, machines: picked.length === boxes.length ? [] : picked, model_urls: rec.farmModelUrls || {} });
            go.disabled = false;
            if (!r.error) {
                d.shade.remove();
                this._farmView(rec, "queue");
                this._farmToast(rec, `${r.job ? r.job.batch : ""} renders queued.`);
            }
        };
        d.foot.append(cancel, go);
        return d;
    },
};
