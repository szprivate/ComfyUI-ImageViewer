// bEpicViewer_agentPanel.js
// The agentY chat panel as a dock panel of the viewer.
//
// There is ONE agentY panel per page (agentY-comfyuiConnect, web/agent_chat.js):
// its DOM is built once and re-parented into whichever place shows it. That is
// how the ComfyUI sidebar tab already works (ComfyUI unmounts the tab when you
// leave it), and it is what makes "an exact copy of the side panel" exact: it is
// the same panel, the same conversation, the same running turn, moved. The
// viewer therefore holds no chat code - only a body for it to be mounted into.
//
// The two sides meet in two small objects on the page:
//
//   window.agentYPanelHost  (put there by agentY)
//       mountInto(el, { where: "viewer", back })  - move the panel into `el`
//       toSidebar({ quiet })                      - give it back to the sidebar
//       where()                                   - "sidebar" | "viewer"
//   window.bEpicViewerApi   (put here)
//       show()                                    - open the viewer if it is closed
//       openAgentPanel() / closeAgentPanel()      - show / put away the dock panel
//       extractFrame(item)                        - "frame N of this clip" -> a PNG file
//                                                   (what a drop of the timeline's frame needs)
//
// Without agentY the panel's body says the agentY panel is not installed.

const PANEL_ID = "agentChat";
const NOT_THERE = "The agentY panel is not loaded. Install or enable agentY-comfyuiConnect and reload ComfyUI.";

const CSS = `
.agent-chat-panel { min-width: 0; }
.agent-chat-panel > .agent-chat-body {
    flex: 1 1 auto; min-height: 0; position: relative; display: flex; flex-direction: column;
    background: #15171c;
}
.agent-chat-body > .agent-chat-note {
    margin: auto; padding: 16px; max-width: 260px; text-align: center;
    color: #9aa0aa; font-size: 12px; line-height: 1.5;
}
.agent-chat-body.ay-host { height: auto; }
.agent-chat-body .ay-bar { flex-wrap: wrap; }
.agent-chat-body > .ay-wrap { flex: 1 1 auto; height: auto; min-height: 0; }
.panel-titlebar .pt-agent-back { margin-left: auto; }
`;

export const AgentPanelMixin = {

    /** Make the panel's element (before _initDock adopts it into a rail). */
    _initAgentPanel() {
        const doc = (this.container && this.container.ownerDocument) || document;
        const panel = doc.createElement("div");
        panel.id = "agent-chat-panel";
        panel.className = "curves-panel agent-chat-panel";
        const body = doc.createElement("div");
        body.className = "agent-chat-body";
        panel.append(body);
        this.agentChatPanel = panel;
        this._agentChatBody = body;
        const style = doc.createElement("style");
        style.id = "agent-chat-panel-css";
        style.textContent = CSS;
        this.shadowRoot.appendChild(style);

        const self = this;
        window.bEpicViewerApi = Object.assign(window.bEpicViewerApi || {}, {
            openAgentPanel: () => self.agentPanelOpen(),
            closeAgentPanel: () => self.agentPanelClose(),
            extractFrame: (item) => self._extractedFramePayload(item),
        });
    },

    /** Show the panel in its dock slot (and the viewer, if it is closed). */
    agentPanelOpen() {
        const api = window.bEpicViewerApi || {};
        try { if (api.show) api.show(); } catch (_) { /* the viewer may already be up */ }
        if (!this.isPanelDocked(PANEL_ID)) this.setPanelDocked(PANEL_ID, true);
        else this._agentPanelMount();
        if (this.isPanelFront && !this.isPanelFront(PANEL_ID)) this.dockTabFront(PANEL_ID);
    },

    /** Put the panel away; agentY takes its panel back into the sidebar. */
    agentPanelClose() {
        if (this.isPanelDocked(PANEL_ID)) this.setPanelDocked(PANEL_ID, false);   // _notifyPanelsShown hands it back
        else this._agentPanelRelease();
    },

    /** The dock showed the panel: put agentY's panel into it. */
    _agentPanelMount() {
        const body = this._agentChatBody;
        if (!body) return;
        this._agentPanelDecorateBar();
        const host = window.agentYPanelHost;
        if (!host || typeof host.mountInto !== "function") {
            // agentY may still be loading (extensions start in no fixed order).
            if (!body.firstChild) this._agentPanelNote(NOT_THERE);
            clearTimeout(this._agentPanelRetry);
            this._agentPanelTries = (this._agentPanelTries || 0) + 1;
            if (this._agentPanelTries < 20) {
                this._agentPanelRetry = setTimeout(() => {
                    if (this.isPanelFront(PANEL_ID)) this._agentPanelMount();
                }, 500);
            }
            return;
        }
        this._agentPanelTries = 0;
        body.querySelector(":scope > .agent-chat-note")?.remove();
        host.mountInto(body, { where: "viewer", back: () => this.agentPanelClose() });
    },

    /** The dock put the panel away (or somewhere it is not drawn). */
    _agentPanelRelease() {
        clearTimeout(this._agentPanelRetry);
        const host = window.agentYPanelHost;
        const body = this._agentChatBody;
        if (host && typeof host.toSidebar === "function" && body && body.querySelector(":scope > .ay-wrap")) {
            host.toSidebar({ quiet: true });
        }
    },

    _agentPanelNote(text) {
        const body = this._agentChatBody;
        if (!body) return;
        body.querySelector(":scope > .agent-chat-note")?.remove();
        const n = body.ownerDocument.createElement("div");
        n.className = "agent-chat-note";
        n.textContent = text;
        body.append(n);
    },

    /** "back to sidebar" in the panel's title bar, once. */
    _agentPanelDecorateBar() {
        const bar = this.agentChatPanel && this.agentChatPanel.querySelector(":scope > .panel-titlebar");
        if (!bar || bar.querySelector(".pt-agent-back")) return;
        const doc = bar.ownerDocument;
        const b = doc.createElement("button");
        b.className = "pt-btn pt-agent-back";
        b.title = "Back to the ComfyUI sidebar";
        b.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" '
            + 'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M17 7 7 17"/><path d="M17 17H7V7"/></svg>';
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        b.addEventListener("click", (e) => { e.stopPropagation(); this.agentPanelClose(); });
        bar.insertBefore(b, bar.querySelector(".pt-close"));
    },
};
