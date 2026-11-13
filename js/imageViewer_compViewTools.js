// The Comp picture's viewer tools, on the stage: A / B compare (wipe, difference, mix), the pixel sampler, the
// scopes, the out-of-range marks and the guides. The arithmetic is imageViewer_compScopes.js; this file is the
// menu, the drawing over the picture and the pointer, and knows the editor only through `api` (createCompEditor).
import * as S from "./imageViewer_compScopes.js";

const KEY = "imageviewer.comp.viewTools";

function load() {
    const d = { compare: "off", wipe: 0.5, angle: 0, sampler: false, scope: "", wave: "luma", range: false, guides: { format: false, safe: false, centre: false } };
    try {
        const v = JSON.parse(localStorage.getItem(KEY) || "null");
        if (v && typeof v === "object") {
            if (S.COMPARE_MODES.includes(v.compare)) d.compare = v.compare;
            if (Number.isFinite(v.wipe)) d.wipe = Math.max(0, Math.min(1, v.wipe));
            if (Number.isFinite(v.angle)) d.angle = v.angle;
            d.sampler = !!v.sampler; d.range = !!v.range;
            if (S.SCOPES.includes(v.scope)) d.scope = v.scope;
            if (v.wave === "rgb") d.wave = "rgb";
            if (v.guides && typeof v.guides === "object") for (const k of Object.keys(d.guides)) d.guides[k] = !!v.guides[k];
        }
    } catch (_) { /* none kept */ }
    return d;
}

export function createViewTools(api) {
    const { doc, el, svgEl, stage } = api;
    const vt = load();
    let B = null;                 // the node compared with the one on show
    let last = null;              // what was drawn: {img (float, shown), px (8-bit), scale, w, h}
    let hover = null, box = null; // the sampler: the pointer, a box (in pixels of the picture on show)
    const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(vt)); } catch (_) { /* not kept */ } };
    const readout = el(doc, "div", "cp-sample");
    const scopeBox = el(doc, "div", "cp-scope");
    const scopeCanvas = el(doc, "canvas");
    const scopeTitle = el(doc, "div", "cp-scope-title");
    scopeBox.append(scopeTitle, scopeCanvas);
    for (const t of ["pointerdown", "wheel", "dblclick"]) scopeBox.addEventListener(t, (e) => e.stopPropagation());
    scopeBox.addEventListener("click", (e) => { e.stopPropagation(); if (vt.scope === "waveform") { vt.wave = vt.wave === "rgb" ? "luma" : "rgb"; keep(); drawScope(); } });
    stage.append(readout, scopeBox);

    const set = (patch, what = "render") => {
        Object.assign(vt, patch);
        keep();
        if (what === "render") api.rerender();
        api.overlay();
        if (api.bar) api.bar();
        sync();
    };
    function sync() {
        readout.style.display = vt.sampler ? "" : "none";
        scopeBox.style.display = vt.scope ? "" : "none";
        if (vt.sampler) drawReadout();
        if (vt.scope) drawScope();
    }

    /** The node to draw beside the one on show (compare is on and B is a node), else null. */
    function bNeeded(viewed) {
        if (vt.compare === "off" || !B) return null;
        if (!api.node(B)) { B = null; return null; }
        return B === viewed ? null : B;
    }
    function setB(id) {
        B = id && api.node(id) ? id : null;
        if (B && vt.compare === "off") vt.compare = "wipe";
        keep(); api.rerender(); api.overlay(); api.graph();
        if (api.bar) api.bar();
    }
    const compose = (A, Bimg) => S.compareImages(A, Bimg, Bimg ? vt.compare : "off", { wipe: vt.wipe, angle: vt.angle });

    /** After the picture is encoded for the screen: scopes read it, the out-of-range marks go on it. */
    function afterEncode(img, px, scale) {
        last = { img, px: vt.scope || vt.sampler ? Uint8ClampedArray.from(px) : null, scale, w: img.w, h: img.h };
        if (vt.scope) drawScope();
        let marked = 0;
        if (vt.range) marked = S.markOutOfRange(img, px);
        if (vt.sampler) drawReadout();
        return marked;
    }

    // ── the scopes ──────────────────────────────────────────────────────
    function drawScope() {
        if (!vt.scope || !last || !last.px) { scopeTitle.textContent = S.SCOPE_LABELS[vt.scope] || ""; return; }
        const { px, w, h } = last, g = scopeCanvas.getContext("2d");
        if (vt.scope === "histogram") {
            const W = 256, H = 120;
            scopeCanvas.width = W; scopeCanvas.height = H;
            const hi = S.histogram(px, w, h);
            let max = 1;
            for (const k of ["r", "g", "b"]) for (let i = 1; i < 255; i++) max = Math.max(max, hi[k][i]);
            g.clearRect(0, 0, W, H);
            g.globalCompositeOperation = "lighter";
            for (const [k, col] of [["r", "#ff3b3b"], ["g", "#3bff5a"], ["b", "#3b7bff"]]) {
                g.fillStyle = col; g.globalAlpha = 0.8;
                g.beginPath(); g.moveTo(0, H);
                for (let i = 0; i < 256; i++) g.lineTo(i, H - Math.min(H, (hi[k][i] / max) * (H - 4)));
                g.lineTo(W, H); g.closePath(); g.fill();
            }
            g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
            scopeTitle.textContent = "Histogram (as shown)";
        } else if (vt.scope === "waveform") {
            const wf = S.waveform(px, w, h, 256, 128, vt.wave);
            scopeCanvas.width = wf.cols; scopeCanvas.height = wf.rows;
            const im = g.createImageData(wf.cols, wf.rows), n = wf.cols * wf.rows;
            if (vt.wave === "rgb") {
                for (let p = 0; p < 3; p++) {
                    const lv = S.densityLevels(wf.data.subarray(p * n, (p + 1) * n));
                    for (let i = 0; i < n; i++) im.data[i * 4 + p] = lv[i];
                }
            } else {
                const lv = S.densityLevels(wf.data);
                for (let i = 0; i < n; i++) { im.data[i * 4] = lv[i] * 0.6; im.data[i * 4 + 1] = lv[i]; im.data[i * 4 + 2] = lv[i] * 0.6; }
            }
            for (let i = 0; i < n; i++) im.data[i * 4 + 3] = 255;
            g.putImageData(im, 0, 0);
            g.strokeStyle = "#ffffff30"; g.lineWidth = 1;
            for (const v of [0, 0.25, 0.5, 0.75, 1]) { const y = Math.round((1 - v) * (wf.rows - 1)) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(wf.cols, y); g.stroke(); }
            scopeTitle.textContent = `Waveform · ${vt.wave === "rgb" ? "RGB" : "luma"} (click: ${vt.wave === "rgb" ? "luma" : "RGB"})`;
        } else {
            const N = 128, vs = S.vectorscope(px, w, h, N);
            scopeCanvas.width = N; scopeCanvas.height = N;
            const im = g.createImageData(N, N), lv = S.densityLevels(vs.data);
            for (let i = 0; i < N * N; i++) { im.data[i * 4] = lv[i] * 0.7; im.data[i * 4 + 1] = lv[i]; im.data[i * 4 + 2] = lv[i] * 0.8; im.data[i * 4 + 3] = 255; }
            g.putImageData(im, 0, 0);
            g.strokeStyle = "#ffffff40"; g.lineWidth = 1;
            g.beginPath(); g.arc(N / 2, N / 2, N / 2 - 1, 0, Math.PI * 2); g.stroke();
            g.beginPath(); g.moveTo(N / 2, 0); g.lineTo(N / 2, N); g.moveTo(0, N / 2); g.lineTo(N, N / 2); g.stroke();
            g.fillStyle = "#ffffffa0"; g.font = "9px sans-serif";
            for (const [name, x, y] of S.vectorTargets()) { const X = x * (N - 1), Y = y * (N - 1); g.strokeRect(X - 3, Y - 3, 6, 6); g.fillText(name, X + 5, Y + 3); }
            scopeTitle.textContent = "Vectorscope (Rec. 709)";
        }
    }

    // ── the sampler ─────────────────────────────────────────────────────
    function drawReadout() {
        readout.replaceChildren();
        if (!last) { readout.textContent = "Sampler: no picture yet"; return; }
        const k = last.scale;
        const line = (label, vals, cls = "") => {
            const r = el(doc, "div", "cp-srow " + cls);
            r.append(el(doc, "span", "cp-sl", label));
            ["r", "g", "b", "a"].forEach((c, i) => r.append(el(doc, "span", "cp-sv " + c, vals[i])));
            readout.append(r);
        };
        const disp = (c) => (c ? c.map((v) => (v / 255).toFixed(3)) : ["-", "-", "-", "-"]);
        if (box) {
            const st = S.boxStats(last.img, box[0] * k, box[1] * k, box[2] * k, box[3] * k);
            readout.append(el(doc, "div", "cp-shead", st ? `Box ${Math.round(Math.abs(box[2] - box[0]))}×${Math.round(Math.abs(box[3] - box[1]))} · mean of ${st.n} px` : "Box: outside the picture"));
            if (st) {
                line("working", S.fmtValues(st.mean));
                line("straight", S.fmtValues(S.straight(st.mean)), "dim");
                line("min", S.fmtValues(st.min), "dim");
                line("max", S.fmtValues(st.max), "dim");
                const [ax, ay, bx, by] = st.box, s = [0, 0, 0, 0];
                for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) { const i = (y * last.w + x) * 4; for (let c = 0; c < 4; c++) s[c] += last.px ? last.px[i + c] : 0; }
                line("display", disp(s.map((v) => v / st.n)), "dim");
            }
        } else if (hover) {
            const c = S.sampleAt(last.img, hover[0] * k, hover[1] * k);
            readout.append(el(doc, "div", "cp-shead", `x ${Math.floor(hover[0])}  y ${Math.floor(hover[1])}`));
            line("working", S.fmtValues(c));
            line("straight", S.fmtValues(S.straight(c)), "dim");
            let d = null;
            if (c && last.px) { const i = (Math.floor(hover[1] * k) * last.w + Math.floor(hover[0] * k)) * 4; d = [last.px[i], last.px[i + 1], last.px[i + 2], last.px[i + 3]]; }
            line("display", disp(d), "dim");
        } else readout.append(el(doc, "div", "cp-shead", "Sampler: point at the picture · Shift+drag a box"));
        if (k !== 1) readout.append(el(doc, "div", "cp-snote", `read at the preview's 1/${Math.round(1 / k)} size`));
    }
    /** The pointer over the stage (pixels of the picture on show). */
    function move(xy) {
        if (!vt.sampler) return;
        hover = xy;
        drawReadout();
    }
    function down(e, xy) {
        if (!vt.sampler || e.button !== 0 || !e.shiftKey) return false;
        e.preventDefault(); e.stopPropagation();
        stage.setPointerCapture(e.pointerId);
        box = [xy[0], xy[1], xy[0], xy[1]];
        stage.onpointermove = (ev) => { const p = api.compXY(ev); box[2] = p[0]; box[3] = p[1]; hover = p; api.overlay(); drawReadout(); };
        stage.onpointerup = () => {
            stage.onpointermove = null; stage.onpointerup = null;
            if (Math.abs(box[2] - box[0]) < 1 && Math.abs(box[3] - box[1]) < 1) box = null;
            api.overlay(); drawReadout();
        };
        return true;
    }

    // ── over the picture: guides, the wipe, the sampler's box ───────────
    function overlay(over) {
        const vf = api.viewFmt(), F = api.fmt(), z = api.zoom();
        const g = svgEl(doc, "g", { class: "cp-vt" });
        over.append(g);
        const G = vt.guides;
        if (G.format || G.safe || G.centre) {
            const dy = vf.height - F.height, R = S.guideRects(F.width, F.height);
            const rect = (r, cls) => g.append(svgEl(doc, "rect", { class: cls, x: r[0], y: r[1] + dy, width: r[2], height: r[3] }));
            if (G.format) {
                rect(R.format, "cp-gfmt");
                const t = svgEl(doc, "text", { class: "cp-glabel", x: 4 / z, y: dy - 4 / z, "font-size": 11 / z }); t.textContent = `${F.width}×${F.height}`; g.append(t);
            }
            if (G.safe) { rect(R.action, "cp-gsafe"); rect(R.title, "cp-gsafe title"); }
            if (G.centre) {
                const [cx, cy] = R.centre, k = 14 / z;
                g.append(svgEl(doc, "line", { class: "cp-gsafe", x1: cx - k, y1: cy + dy, x2: cx + k, y2: cy + dy }), svgEl(doc, "line", { class: "cp-gsafe", x1: cx, y1: cy + dy - k, x2: cx, y2: cy + dy + k }));
            }
        }
        if (vt.compare === "wipe" && B && api.node(B)) {
            const [[x0, y0], [x1, y1]] = S.wipeLine(vf.width, vf.height, vt.wipe, vt.angle);
            g.append(svgEl(doc, "line", { class: "cp-wipe", x1: x0, y1: y0, x2: x1, y2: y1 }));
            const cx = vt.wipe * vf.width, cy = vf.height / 2;
            const h = svgEl(doc, "circle", { class: "cp-wipeh", cx, cy, r: 7 / z });
            const tip = svgEl(doc, "title", {}); tip.textContent = "Drag: move the wipe · Shift+drag: turn it · double-click: back to the middle";
            h.append(tip);
            h.addEventListener("pointerdown", (e) => wipeDrag(e, vf));
            h.addEventListener("dblclick", (e) => { e.stopPropagation(); set({ wipe: 0.5, angle: 0 }); });
            g.append(h);
            const lab = (text, x) => { const t = svgEl(doc, "text", { class: "cp-wlabel", x, y: 16 / z, "font-size": 12 / z }); t.textContent = text; g.append(t); };
            lab(`A ${api.label(api.viewed())}`, Math.max(4 / z, cx - 120 / z));
            lab(`B ${api.label(B)}`, Math.min(vf.width - 90 / z, cx + 10 / z));
        }
        if (vt.sampler && box) {
            g.append(svgEl(doc, "rect", { class: "cp-sbox", x: Math.min(box[0], box[2]), y: Math.min(box[1], box[3]), width: Math.abs(box[2] - box[0]), height: Math.abs(box[3] - box[1]) }));
        }
    }
    function wipeDrag(e, vf) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        stage.setPointerCapture(e.pointerId);
        const turn = e.shiftKey, a0 = vt.angle, p0 = api.compXY(e);
        stage.onpointermove = (ev) => {
            const p = api.compXY(ev);
            if (turn) {
                const cx = vt.wipe * vf.width, cy = vf.height / 2;
                const a = (Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(p0[1] - cy, p0[0] - cx)) * (180 / Math.PI);
                vt.angle = Math.round((a0 + a) * 10) / 10;
            } else vt.wipe = Math.max(0, Math.min(1, p[0] / vf.width));
            keep(); api.rerender(); api.overlay();
        };
        stage.onpointerup = () => { stage.onpointermove = null; stage.onpointerup = null; };
    }

    // ── the menu ────────────────────────────────────────────────────────
    const tick = (on, label) => `${on ? "✓ " : " "}${label}`;
    function menuItems() {
        const items = [];
        const others = api.nodes().filter((n) => n.id !== api.viewed());
        items.push([`B: ${B ? api.label(B) : "none"} - choose…`, () => api.pop(api.barAnchor(), [["None", () => setB(null)], null,
            ...others.map((n) => [tick(n.id === B, n.name || n.id), () => setB(n.id)])]), others.length > 0, "2"]);
        for (const m of S.COMPARE_MODES) items.push([tick(vt.compare === m, `Compare: ${S.COMPARE_LABELS[m]}`), () => set({ compare: m }), m === "off" || !!B, m === "wipe" ? "W" : undefined]);
        items.push(null);
        items.push([tick(vt.sampler, "Pixel sampler"), () => { if (vt.sampler) { box = null; hover = null; } set({ sampler: !vt.sampler }); }, true, "I"]);
        for (const s of S.SCOPES.slice(1)) items.push([tick(vt.scope === s, S.SCOPE_LABELS[s]), () => set({ scope: vt.scope === s ? "" : s })]);
        items.push([tick(vt.range, "Out-of-range colours"), () => set({ range: !vt.range })]);
        items.push(null);
        items.push([tick(vt.guides.format, "Format box"), () => set({ guides: { ...vt.guides, format: !vt.guides.format } }, "overlay")]);
        items.push([tick(vt.guides.safe, "Action / title safe"), () => set({ guides: { ...vt.guides, safe: !vt.guides.safe } }, "overlay")]);
        items.push([tick(vt.guides.centre, "Centre"), () => set({ guides: { ...vt.guides, centre: !vt.guides.centre } }, "overlay")]);
        return items;
    }
    function key(e) {
        const k = e.key.toLowerCase();
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (k === "w") { set({ compare: vt.compare === "wipe" ? "off" : "wipe" }); if (!B) api.toast("Pick the node to compare with: select it and press 2", "info"); return true; }
        if (k === "i") { if (vt.sampler) { box = null; hover = null; } set({ sampler: !vt.sampler }); return true; }
        return false;
    }
    sync();
    return {
        state: vt, bNeeded, setB, b: () => B, compose, afterEncode, overlay, menuItems, key, move, down, sync,
        leave() { if (hover && !box) { hover = null; if (vt.sampler) drawReadout(); } },
        summary() {
            const on = [];
            if (vt.compare !== "off" && B) on.push(vt.compare);
            if (vt.sampler) on.push("sampler");
            if (vt.scope) on.push(vt.scope);
            if (vt.range) on.push("range");
            if (vt.guides.format || vt.guides.safe || vt.guides.centre) on.push("guides");
            return on;
        },
    };
}

export const VIEW_TOOLS_CSS = `
.cp-sample{position:absolute;left:8px;top:8px;background:#000c;border:1px solid #ffffff22;border-radius:4px;padding:4px 6px;font:11px/1.35 ui-monospace,Consolas,monospace;pointer-events:none;z-index:3;min-width:220px}
.cp-shead{color:#ddd;margin-bottom:2px}.cp-snote{color:#888;font-size:10px;margin-top:2px}
.cp-srow{display:flex;gap:6px}.cp-srow.dim{opacity:.75}
.cp-sl{width:56px;color:#999}.cp-sv{width:52px;text-align:right}.cp-sv.r{color:#ff7a7a}.cp-sv.g{color:#7aff8f}.cp-sv.b{color:#7aaeff}.cp-sv.a{color:#ddd}
.cp-scope{position:absolute;right:8px;bottom:26px;background:#000d;border:1px solid #ffffff22;border-radius:4px;padding:3px;z-index:3;cursor:default}
.cp-scope canvas{display:block;width:200px;height:auto;image-rendering:auto}
.cp-scope-title{font-size:10px;color:#aaa;margin:0 2px 2px}
.cp-over .cp-gfmt{fill:none;stroke:#ffcf3a;stroke-width:1px;vector-effect:non-scaling-stroke}
.cp-over .cp-gsafe{fill:none;stroke:#ffffff80;stroke-width:1px;stroke-dasharray:5 4;vector-effect:non-scaling-stroke}
.cp-over .cp-gsafe.title{stroke:#ffffff55}
.cp-over .cp-glabel{fill:#ffcf3a}
.cp-over .cp-wipe{stroke:#fff;stroke-width:1.5px;vector-effect:non-scaling-stroke}
.cp-over .cp-wipeh{fill:#0009;stroke:#fff;stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:all;cursor:ew-resize}
.cp-over .cp-wlabel{fill:#fff;paint-order:stroke;stroke:#000;stroke-width:3px;font-weight:600}
.cp-over .cp-sbox{fill:#3ad1ff18;stroke:#3ad1ff;stroke-width:1px;vector-effect:non-scaling-stroke}
.cp-node .cp-btag{position:absolute;left:100%;margin-left:6px;top:7px;font-size:10px;font-weight:700;color:#111;background:#3ad1ff;border-radius:2px;padding:0 4px;pointer-events:none}
.mg-btn.cp-vtools.on{font-weight:600}
`;
