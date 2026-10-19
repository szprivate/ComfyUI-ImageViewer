const listeners = {};
export const api = {
  api_base: "",
  apiURL: (p) => p, fileURL: (p) => p,
  addEventListener(n, f) { (listeners[n] ||= []).push(f); },
  removeEventListener() {},
  dispatch(n, detail) { (listeners[n] || []).forEach((f) => f({ detail })); },
  async fetchApi(path, opts) { return window.__fetchApi(path, opts); },
  getUserData: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }),
  storeUserData: async () => ({ ok: true }),
  socket: null, queuePrompt() {},
};
window.__api = api;
