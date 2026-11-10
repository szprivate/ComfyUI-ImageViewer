const listeners = {};
export const api = {
  api_base: "",
  apiURL: (p) => p, fileURL: (p) => p,
  addEventListener(n, f) { (listeners[n] ||= []).push(f); },
  removeEventListener() {},
  dispatch(n, detail) { (listeners[n] || []).forEach((f) => f({ detail })); },
  async fetchApi(path, opts) { return window.__fetchApi(path, opts); },
  // window.__userDataDelay: ms a userdata read takes, as a real ComfyUI's HTTP read does (tests/test_viewer_restore_browser.py).
  // window.__userData: { name: json } files that are there (tests/test_layout_menu_browser.py).
  getUserData: async (name) => {
    if (window.__userDataDelay) await new Promise((r) => setTimeout(r, window.__userDataDelay));
    const files = window.__userData || {};
    if (name in files) return { ok: true, status: 200, json: async () => files[name], text: async () => JSON.stringify(files[name]) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  },
  storeUserData: async () => ({ ok: true }),
  socket: null, queuePrompt() {},
};
window.__api = api;
