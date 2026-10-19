// A stand-in for ComfyUI's scripts/api.js: fetchApi goes to the harness server.
const listeners = {};
export const api = {
    fetchApi(route, opts) { return fetch(route, opts); },
    apiURL(route) { return route; },
    fileURL(route) { return route; },
    addEventListener(n, f) { (listeners[n] ||= []).push(f); },
    removeEventListener() {},
    getUserData() { return Promise.resolve({ status: 404, json: async () => ({}) }); },
    storeUserData() { return Promise.resolve({}); },
};
