// imageViewer_compComfyTab.js
// "Comp" in ComfyUI's own bottom panel (the strip under the canvas that holds the Terminal and the Logs): the node
// graph of the comp the viewer is on, there instead of in the viewer's Node Graph panel, with a small bar - the comp's
// name, play / step and the frame, and a button that brings the viewer up on the comp. It is the SAME editor: the
// graph element is moved there while the tab is up and back when it goes (CompPanelMixin.compBottomAttach /
// compBottomDetach), so a change in either place is a change of the one comp. Nothing in ComfyUI's graph changes.
//
// Registered through the extension's `bottomPanelTabs` (a custom tab: `render(el)` when it is shown, `destroy()`
// when it goes). A frontend without bottom panel tabs simply has no such tab.
import { installCompStyles } from "./imageViewer_compEditor.js";

const CSS = `
.ivc-root{position:absolute;inset:0;display:flex;flex-direction:column;background:#202024;color:#d8d8dc;font:12px/1.35 system-ui,Segoe UI,sans-serif}
.ivc-bar{display:flex;align-items:center;gap:6px;padding:3px 8px;border-bottom:1px solid #2c2c32;flex:none;white-space:nowrap}
.ivc-bar button{background:#2c2c33;border:1px solid #3a3a42;color:#e6e6ea;border-radius:3px;font:inherit;padding:1px 8px;cursor:pointer;height:22px}
.ivc-bar button:hover{border-color:#ff6a1a}
.ivc-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ivc-frame{font-variant-numeric:tabular-nums;opacity:.8;min-width:72px}
.ivc-gap{flex:1}
.ivc-body{flex:1;position:relative;min-height:0}
.ivc-note{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#9a9aa2;text-align:center;padding:12px}
.ivc-note button{background:#ff6a1a;border:0;color:#111;font:600 12px system-ui,sans-serif;padding:6px 16px;border-radius:4px;cursor:pointer}
`;

function installStyles(doc) {
    if (doc.querySelector("style[data-ivc]")) return;
    const s = doc.createElement("style");
    s.setAttribute("data-ivc", "1");
    s.textContent = CSS;
    doc.head.appendChild(s);
}

/**
 * The bottom panel tab. `getPanel()` is the viewer (may be null before it exists), `showViewer()` brings it up.
 */
export function compBottomTabs(getPanel, showViewer) {
    let mounted = null;
    return [{
        id: "imageviewer-comp",
        title: "Comp",
        type: "custom",
        render(el) {
            const doc = el.ownerDocument;
            installStyles(doc);
            installCompStyles(doc);
            if (mounted) mounted.stop();
            const root = doc.createElement("div");
            root.className = "ivc-root";
            const bar = doc.createElement("div");
            bar.className = "ivc-bar";
            const name = doc.createElement("span");
            name.className = "ivc-name";
            const btn = (label, title, fn) => {
                const b = doc.createElement("button");
                b.textContent = label;
                b.title = title;
                b.addEventListener("click", fn);
                return b;
            };
            const panel = () => getPanel();
            const frame = doc.createElement("span");
            frame.className = "ivc-frame";
            const play = btn("▶", "Play / stop (the viewer's transport)", () => { const p = panel(); if (p && p._cpOn) (p.isPlaying ? p.stop() : p.play()); });
            const gap = doc.createElement("span");
            gap.className = "ivc-gap";
            bar.append(name,
                btn("◀", "A frame back", () => { const p = panel(); if (p && p._cpOn) p.step(-1); }),
                play,
                btn("▶|", "A frame on", () => { const p = panel(); if (p && p._cpOn) p.step(1); }),
                frame, gap,
                btn("Show the picture", "Bring up the viewer on this comp", () => { showViewer(); }),
                btn("Open Comp…", "The comp that is open, the last one, or a new one", async () => {
                    showViewer();
                    const p = panel();
                    if (p && p.spaceOpen) await p.spaceOpen("comp");
                }));
            const body = doc.createElement("div");
            body.className = "ivc-body";
            root.append(bar, body);
            el.style.position = el.style.position || "relative";
            if (!el.style.height) el.style.height = "100%";
            el.replaceChildren(root);

            let last = "";
            const tick = () => {
                const p = panel();
                const ed = p && p.compEditor ? p.compEditor() : null;
                const sig = ed ? `${ed.state.path}|${ed.state.frame}|${p.isPlaying}|${ed.isDirty()}|${ed.comp().format.frames}` : "none";
                if (sig === last) return;
                last = sig;
                name.textContent = ed ? (ed.state.path.split(/[\\/]/).pop() + (ed.isDirty() ? " •" : "")) : "No comp in the viewer";
                name.title = ed ? ed.state.path : "";
                frame.textContent = ed ? `${ed.state.frame} / ${ed.comp().format.frames - 1}` : "";
                play.textContent = p && p.isPlaying && ed ? "■" : "▶";
            };
            const timer = setInterval(tick, 150);
            const p0 = panel();
            if (p0 && p0.compBottomAttach) p0.compBottomAttach(body);
            else body.replaceChildren(Object.assign(doc.createElement("div"), { className: "ivc-note", textContent: "The viewer is not up yet." }));
            tick();
            mounted = {
                stop() {
                    clearInterval(timer);
                    const p = panel();
                    if (p && p.compBottomDetach) p.compBottomDetach(body);
                    mounted = null;
                },
            };
        },
        destroy() { if (mounted) mounted.stop(); },
    }];
}
