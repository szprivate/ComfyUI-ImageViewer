// imageViewer_lensChart.js
// A checkerboard to film for the lens: shown full screen on any monitor, tablet or laptop, filmed with the
// lens and focus of the shot, then read by the Matchmove's lens step (matchmove.solve_lens_grid finds the
// corners where four squares meet). A screen is flat and sharp, which is all a chart has to be.
//
// The layout is pure (`chartLayout`), so a test can draw the same chart and check that the lens step reads it.
// Written from scratch.

export const CHART_COLUMNS = [8, 10, 12, 14, 16, 20, 24];
export const CHART_DEFAULT = 12;

/**
 * Whole squares across W x H screen pixels, centred, at least one square of white round them (the outer corners
 * are no crossings, the inner ones are): {cell, cols, rows, x0, y0}.
 */
export function chartLayout(W, H, columns = CHART_DEFAULT) {
    const cols = Math.max(4, Math.round(columns));
    const cell = Math.max(4, Math.floor(W / (cols + 2)));
    const rows = Math.max(3, Math.floor(H / cell) - 2);
    const x0 = Math.round((W - cols * cell) / 2), y0 = Math.round((H - rows * cell) / 2);
    return { cell, cols, rows, x0, y0 };
}

/** Is the square at column i, row j dark? (The top left one is.) */
export const chartDark = (i, j) => (i + j) % 2 === 0;

/** The chart drawn on a 2D context W x H (white ground, black squares). */
export function drawChart(g, W, H, columns = CHART_DEFAULT) {
    const L = chartLayout(W, H, columns);
    g.fillStyle = "#fff";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#000";
    for (let j = 0; j < L.rows; j++) {
        for (let i = 0; i < L.cols; i++) if (chartDark(i, j)) g.fillRect(L.x0 + i * L.cell, L.y0 + j * L.cell, L.cell, L.cell);
    }
    return L;
}

const HINT = "Film this with the shot's lens, zoom and focus: get close enough that the squares fill the camera's picture out to its corners, "
    + "hold still a moment, then tilt a little and hold again. + / − more or fewer squares · Esc or a click closes.";

/**
 * The chart over the whole of `doc`'s window, full screen where the browser allows. Keys: + / - change the
 * squares, Esc closes; a click closes. -> {close, root}.
 */
export function openLensChart(doc, { columns = CHART_DEFAULT, onClose } = {}) {
    const win = doc.defaultView || window;
    const old = doc.querySelector(".iv-lens-chart");
    if (old && old.__chart) old.__chart.close();
    const root = doc.createElement("div");
    root.className = "iv-lens-chart";
    Object.assign(root.style, { position: "fixed", inset: "0", zIndex: "2147483000", background: "#fff", cursor: "none" });
    const canvas = doc.createElement("canvas");
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
    const hint = doc.createElement("div");
    hint.textContent = HINT;
    Object.assign(hint.style, { position: "absolute", left: "50%", bottom: "24px", transform: "translateX(-50%)", maxWidth: "80%",
                                padding: "8px 12px", borderRadius: "6px", background: "rgba(0,0,0,0.75)", color: "#fff",
                                font: "13px sans-serif", textAlign: "center", transition: "opacity 0.6s", pointerEvents: "none" });
    root.append(canvas, hint);
    doc.body.append(root);
    let cols = CHART_COLUMNS.includes(columns) ? columns : CHART_DEFAULT;
    const draw = () => {
        const dpr = win.devicePixelRatio || 1;
        const W = Math.round(root.clientWidth * dpr), H = Math.round(root.clientHeight * dpr);
        if (!W || !H) return;
        canvas.width = W;
        canvas.height = H;
        const L = drawChart(canvas.getContext("2d"), W, H, cols);
        root.dataset.cols = String(L.cols);
        root.dataset.rows = String(L.rows);
        root.dataset.cell = String(L.cell);
    };
    let hintTimer = 0;
    const showHint = () => {
        hint.style.opacity = "1";
        win.clearTimeout(hintTimer);
        hintTimer = win.setTimeout(() => { hint.style.opacity = "0"; }, 4000);
    };
    const onKey = (e) => {
        if (e.key === "Escape") { close(); }
        else if (e.key === "+" || e.key === "=") { cols = CHART_COLUMNS[Math.min(CHART_COLUMNS.length - 1, CHART_COLUMNS.indexOf(cols) + 1)]; draw(); showHint(); }
        else if (e.key === "-" || e.key === "_") { cols = CHART_COLUMNS[Math.max(0, CHART_COLUMNS.indexOf(cols) - 1)]; draw(); showHint(); }
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
    };
    const onFull = () => { if (!doc.fullscreenElement && closed === false && wentFull) close(); else draw(); };
    let closed = false, wentFull = false;
    const ro = new win.ResizeObserver(draw);
    function close() {
        if (closed) return;
        closed = true;
        ro.disconnect();
        win.removeEventListener("keydown", onKey, true);
        doc.removeEventListener("fullscreenchange", onFull);
        win.clearTimeout(hintTimer);
        if (doc.fullscreenElement === root && doc.exitFullscreen) doc.exitFullscreen().catch(() => {});
        root.remove();
        if (onClose) onClose();
    }
    ro.observe(root);
    win.addEventListener("keydown", onKey, true);
    doc.addEventListener("fullscreenchange", onFull);
    root.addEventListener("pointerdown", (e) => { e.preventDefault(); close(); });
    root.addEventListener("pointermove", showHint);
    draw();
    showHint();
    if (root.requestFullscreen) {
        root.requestFullscreen({ navigationUI: "hide" }).then(() => { wentFull = true; draw(); }).catch(() => { /* a window then */ });
    }
    const api = { close, root, columns: () => cols };
    root.__chart = api;
    return api;
}
