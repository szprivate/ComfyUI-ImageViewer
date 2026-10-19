export const app = {
  registerExtension(e) { window.__ext = e; }, graph: { _nodes: [], getNodeById() { return null; }, add() {}, remove() {}, onNodeAdded: null },
  canvas: { selected_nodes: {}, graph: null, setDirty() {} }, queuePrompt() {}, ui: { settings: { getSettingValue: () => undefined, addSetting() {} } },
  extensionManager: { toast: { add() {} } }, graphToPrompt: async () => ({}),
};
