// A stand-in for ComfyUI's scripts/app.js, just enough for the viewer to boot.
const extensions = [];
export const app = {
    graph: { nodes: [], _nodes: [], links: {}, getNodeById() { return null; }, serialize() { return {}; } },
    canvas: { graph: null, setDirty() {}, ds: { scale: 1 } },
    extensionManager: { toast: { add(t) { (window.__toasts ||= []).push(t); } }, setting: { get() { return undefined; } } },
    ui: { settings: { getSettingValue(_id, d) { return d; }, setSettingValue() {}, addSetting() {}, onChange() {} } },
    registerExtension(ext) { extensions.push(ext); },
    queuePrompt() {},
    loadGraphData() {},
    getPreviewFormatParam() { return ""; },
    __extensions: extensions,
};
window.app = app;
