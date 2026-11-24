// imageViewer_previzAgentRender.js
// The agent's hands on the 3D space's Render panel (Sebastian 2026-11-24: "a prompt field in the render view,
// which the agent should be able to access"). agentY-core's scene tool sends these through POST
// /imageviewer/rig/agent like the rest of SCENE_AGENT_ACTIONS (imageViewer_previzAgentScene.js lists them;
// rig_routes.AGENT_ACTIONS too):
//
//   render_panel_info   {panel?}                       the panel: prompt, workflow (+ its settings), AI / IPR /
//                                                      region, the last render and result; the prepared list
//   render_panel_set    {panel?, prompt?, workflow?, values?, ai?, ipr?, region?}
//                       workflow: a prepared id ("comp_r3_zimage_depth" ...), "canvas", or null (off);
//                       region: [x0, y0, x1, y1] shares of the picture (y down), true / false, or null (whole)
//   render_panel_render {panel?, ai?, frame?}           Render as the button does; answers the result's file
//
// `panel` is a Render panel's id ("render3d" the first one; render_panel_info lists them). The panel is opened
// when it is not up. The prompt is the panel's own (scene.renderAi[id].prompt) and fills the workflow's prompt.

import * as RP from "./imageViewer_previzRenderPanel.js";

export const RENDER_PANEL_AGENT_ACTIONS = ["render_panel_info", "render_panel_set", "render_panel_render"];

export const PrevizAgentRenderMixin = {

    /** The Render panel the agent names (the first one by default), opened when it is not up. */
    _asaRenderPanel(a) {
        const want = a && a.panel ? String(a.panel) : "";
        let inst = (this._r3All ? this._r3All() : []).find((x) => !want || x.st.id === want);
        if (!inst && (!want || want === "render3d")) inst = this.previzRenderPanelOpen();
        if (!inst) throw new Error(want ? `no Render panel ${want} (render_panel_info lists them)` : "the Render panel could not be opened (is a 3D tab up?)");
        return inst;
    },

    _asaRenderPanelInfo(inst) {
        const st = inst.st;
        const k = st.mine();
        const c = k.custom;
        const pp = RP.promptParam(c);
        const out = {
            panel: st.id,
            prompt: k.prompt || "",
            workflow: c ? {
                name: c.name || "", source: c.source || "", id: c.source === "prepared" ? c.path : undefined,
                takes: [...new Set((c.inputs || []).map((x) => this._r3PassOf(x)))],
                takes_prompt: !!pp, default_prompt: pp ? String(pp.def || "") : undefined,
                settings: (c.params || []).filter((p) => p !== pp).map((p) => ({ id: p.id, name: p.name, kind: p.kind,
                    value: k.values && k.values[p.id] !== undefined ? k.values[p.id] : p.def })),
            } : null,
            ai: !!(st.aiOn && c), ipr: !!st.ipr,
            region: st.region && st.region.on && st.region.box ? st.region.box : null,
            rendered: st.frame === null ? null : { frame: st.frame, size: st.size || null, preview: !!(st.passes && st.passes.preview) },
            busy: st.busy ? st.busy.text : st.run ? "running the workflow" : "",
        };
        const last = k.last;
        if (last && last.main) out.result = { frame: last.frame, file: last.main, region: last.region || null };
        if (st.error) out.error = st.error;
        return out;
    },

    async _asa_render_panel_info(_scene, a) {
        const inst = this._asaRenderPanel(a);
        const out = this._asaRenderPanelInfo(inst);
        out.panels = (this._r3All ? this._r3All() : []).map((x) => x.st.id);
        out.prepared = (await this._r3Prepared().catch(() => [])).map((w) => ({ id: w.id, label: w.label, group: w.group || "edit", api: !!w.api,
            needs_download: !!(w.missing && w.missing.some((m) => m.kind !== "node")) }));
        return out;
    },

    async _asa_render_panel_set(_scene, a) {
        const inst = this._asaRenderPanel(a);
        const st = inst.st;
        if (a.workflow !== undefined) {
            if (a.workflow === null || a.workflow === "" || a.workflow === false) {
                const kk = st.keep();
                if (kk) { delete kk.custom; delete kk.values; delete kk.last; }
                st.ai = null;
                if (String(st.pass).startsWith("ai")) st.pass = "beauty";
                st.wipe = false;
            } else if (a.workflow === "canvas") {
                await this._r3Take(st, { how: "canvas" });
            } else {
                const list = await this._r3Prepared();
                const it = list.find((w) => w.id === a.workflow || w.label === a.workflow);
                if (!it) throw new Error(`no prepared workflow ${a.workflow}; there are: ${list.map((w) => w.id).join(", ")}`);
                await this._r3TakePrepared(st, it);
            }
            if (st.error) throw new Error(st.error);
        }
        const kk = st.keep();
        if (!kk) throw new Error("no 3D scene is up");
        if (a.prompt !== undefined) kk.prompt = a.prompt === null ? "" : String(a.prompt);
        if (a.values && typeof a.values === "object") {
            const c = kk.custom;
            if (!c) throw new Error("the panel has no workflow: set one first (workflow)");
            kk.values = kk.values || {};
            for (const [key, val] of Object.entries(a.values)) {
                const p = (c.params || []).find((x) => x.id === key || x.name === key);
                if (!p) throw new Error(`the workflow has no setting ${key}; it has ${(c.params || []).map((x) => x.name).join(", ")}`);
                kk.values[p.id] = val;
            }
        }
        if (a.ai !== undefined) st.aiOn = !!a.ai;
        if (a.region !== undefined) {
            if (a.region === null || a.region === false) st.region = { on: false, box: st.region.box };
            else if (a.region === true) st.region.on = true;
            else {
                const box = RP.cleanBox(a.region);
                if (!box) throw new Error("region is [x0, y0, x1, y1], shares of the picture from its top left, at least 1 % wide and tall");
                st.region = { on: true, box };
            }
        }
        st.persist();
        if (st.rebuildAi) st.rebuildAi();
        if (a.ipr !== undefined) this.previzRenderPanelIpr(st, !!a.ipr);
        st.draw && st.draw();
        return this._asaRenderPanelInfo(inst);
    },

    async _asa_render_panel_render(_scene, a) {
        const inst = this._asaRenderPanel(a);
        const st = inst.st;
        if (Number.isFinite(Number(a.frame)) && a.frame !== null && a.frame !== undefined && this.setFrame) {
            this.setFrame(Math.round(Number(a.frame)));
        }
        const res = await this.previzRenderPanelRender(st, { ai: a.ai === undefined ? null : !!a.ai });
        const out = this._asaRenderPanelInfo(inst);
        out.ok = !!(res && res.ok);
        if (res && res.error) out.error = res.error;
        if (res && res.stopped) out.stopped = true;
        return out;
    },
};
