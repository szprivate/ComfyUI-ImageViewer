// imageViewer_atlasSplat.js
// "Export Gaussian splat…" (the Atlas menu): World Labs builds a Gaussian splat from the open Atlas world's posed
// views (posedImages2Splats). Through ComfyUI (POST /imageviewer/atlas_splat) to the agentY host, which runs the
// same core function as the agent's atlas_views_to_splat. The price comes first from a dry run; nothing is spent
// until the button is pressed on it. The SPZ (Atlas world frame, Y up) and a viewer-axes PLY land in the world's
// splats/ folder; the PLY joins the History. The 3D space stays where it is.
import { api } from "../../scripts/api.js";
import { notice } from "./imageViewer_exportUI.js";
import * as A from "./imageViewer_atlasRender.js";
import { floatDialog } from "./imageViewer_atlasDrops.js";

async function asJson(res) {
    let body = {};
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error(body.error || `the viewer server answered ${res.status}`);
    return body;
}

const postSplat = async (body) => asJson(await api.fetchApi("/imageviewer/atlas_splat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
const getSplat = async (id) => asJson(await api.fetchApi(`/imageviewer/atlas_splat?id=${encodeURIComponent(id)}`));

export const SPLAT_QUALITIES = [["refined", "Refined (best)"], ["draft", "Draft (fast, cheap)"]];

/** What the dry run's plan says, in a line. */
export function describeSplatPlan(plan) {
    if (!plan) return "";
    const est = plan.estimate || {};
    const left = ((plan.consistency || {}).excluded || []).length;
    return `${plan.frame_count} views go to World Labs${left ? ` (${left} left out: they disagree with the others)` : ""}. `
        + `About US$ ${Number(est.usd || 0).toFixed(2)} (${Number(est.credits || 0).toLocaleString("en")} credits; `
        + "failed runs are free). It takes 10-20 minutes.";
}

export const AtlasSplatMixin = {

    atlasSplatDialog() {
        if (this._atlasSplatDlg && this._atlasSplatDlg.isConnected) { if (!this._atlasSplatBusy) this._atlasSplatDlg.remove(); return; }
        const item = this.previzAtlasItem && this.previzAtlasItem();
        const host = this.container;
        if (!item || !host) { notice("warn", "Export Gaussian splat", "Open an Atlas world in the 3D space first."); return; }
        const doc = host.ownerDocument;
        const el = (tag, cls, text) => {
            const n = doc.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const worldName = A.atlasWorldName(item.src.path);
        const shade = el("div", "rd-shade atlas-dlg atlas-splat");
        const box = el("div", "rd-box");
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", "Export Gaussian splat");
        const head = el("div", "rd-head");
        const x = el("button", "rd-x", "✕");
        x.title = "Close (Esc)";
        head.append(el("span", "rd-title", `Export Gaussian splat — ${worldName}`), x);
        const row = (label, ...kids) => {
            const r = el("div", "rd-row");
            r.append(el("span", "rd-label", label), ...kids);
            return r;
        };
        const quality = el("select", "rd-in atlas-splat-quality");
        for (const [v, label] of SPLAT_QUALITIES) quality.append(Object.assign(el("option"), { value: v, textContent: label }));
        const check = el("input");
        check.type = "checkbox";
        check.checked = true;
        const checkWrap = el("label", "rd-inline");
        checkWrap.append(check, el("span", "rd-sub", "Leave out views that disagree with the others (they make the splat ghost)"));
        const nameIn = el("input", "rd-in atlas-splat-name");
        nameIn.value = `${worldName}_splat`.slice(0, 60);
        const price = el("div", "rd-hint atlas-price", "Asking agentY for the plan and the price…");
        const hint = el("div", "rd-hint", "World Labs reconstructs the splat from the world's views and their depth. The "
            + "SPZ (Y up, as the world) and a PLY for the viewer go into the world's splats folder; the PLY joins the History.");
        const message = el("div", "rd-message");
        const progress = el("div", "rd-progress");
        const bar = el("div", "rd-bar");
        progress.append(bar);
        const cancel = el("button", "rd-btn", "Close");
        const go = el("button", "rd-btn rd-go", "Export splat");
        go.disabled = true;
        const foot = el("div", "rd-row export-foot");
        foot.append(cancel, go);
        box.append(head, row("Quality", quality), row("", checkWrap), row("Name", nameIn), price, hint, progress, message, foot);
        shade.append(box);
        floatDialog(shade, box, head);
        host.append(shade);
        this._atlasSplatDlg = shade;

        const win = this._viewerWindow ? this._viewerWindow() : window;
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
        const close = () => {
            if (this._atlasSplatBusy) return;
            shade.remove();
            win.removeEventListener("keydown", onKey, true);
        };
        win.addEventListener("keydown", onKey, true);
        x.onclick = close;
        cancel.onclick = close;

        const request = (extra) => ({ world_path: item.src.path, refine: quality.value === "refined",
                                      check_consistency: check.checked, name: nameIn.value.trim(), ...extra });
        let plan = null, asked = 0;
        const quote = async () => {
            const mine = ++asked;
            go.disabled = true;
            plan = null;
            price.classList.remove("error");
            price.textContent = "Asking agentY for the plan and the price…";
            try {
                const out = await postSplat(request({ dry_run: true }));
                if (mine !== asked) return;
                if (out.error) throw new Error(out.error);
                plan = out.plan || null;
                if (!plan) throw new Error("agentY gave no plan");
                price.textContent = describeSplatPlan(plan);
                go.textContent = `Export splat (US$ ${Number((plan.estimate || {}).usd || 0).toFixed(2)})`;
                go.disabled = false;
            } catch (e) {
                if (mine !== asked) return;
                price.classList.add("error");
                price.textContent = A.explainError(e) + " — this needs agentY running.";
            }
        };
        quality.onchange = () => { quote(); };
        check.onchange = () => { quote(); };
        quote();

        go.onclick = async () => {
            if (this._atlasSplatBusy || !plan) return;
            this._atlasSplatBusy = true;
            go.disabled = quality.disabled = check.disabled = nameIn.disabled = true;
            box.classList.add("rendering");
            message.classList.remove("error");
            message.textContent = "Sending the views to World Labs…";
            bar.style.width = "10%";
            try {
                const state = await A.runAtlasRender({
                    post: postSplat, get: getSplat, request: request({ confirm_cost: true }),
                    pollMs: 5000, timeoutMs: 45 * 60 * 1000,
                    onState: (s) => {
                        message.textContent = `${s.phase || "World Labs is building the splat"}… ${A.clock(s.elapsed)}`;
                        bar.style.width = "50%";
                    },
                });
                bar.style.width = "100%";
                this._atlasSplatBusy = false;
                const file = state.ply || state.spz || "";
                if (file) {
                    try {
                        await api.fetchApi("/imageviewer/push", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ paths: [file], group: "Atlas splats", label: "Atlas splat", focus: false }),
                        });
                    } catch (_) { /* the file is there either way */ }
                }
                notice(state.message ? "warn" : "success", "Gaussian splat ready",
                       (state.message ? state.message + " " : "") + (state.spz || file || "in the world's splats folder"));
                close();
            } catch (e) {
                message.classList.add("error");
                message.textContent = A.explainError(e);
                box.classList.remove("rendering");
                go.disabled = quality.disabled = check.disabled = nameIn.disabled = false;
                this._atlasSplatBusy = false;
            }
        };
    },
};
