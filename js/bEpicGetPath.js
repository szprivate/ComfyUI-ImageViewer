// Helper for adding the "Open in Explorer" button to bEpicGetPath nodes
import { api } from "../../scripts/api.js";

export function registerBepicGetPath(nodeType) {
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function() {
        onNodeCreated?.apply(this, arguments);
        this.addWidget("button", "Open in Explorer", null, () => {
            const paths_id = this.widgets.find(w => w.name === "paths_id")?.value;
            const path_key = this.widgets.find(w => w.name === "path_key")?.value;
            const suffix = this.widgets.find(w => w.name === "suffix")?.value;
            console.log("[bEpicGetPath] explorer button clicked", {paths_id, path_key, suffix});
            const url = api.apiURL("/bepic/open_path");
            console.log("[bEpicGetPath] requesting", url);
            fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths_id, path_key, suffix }),
            })
            .then(res => {
                if (!res.ok) {
                    // try GET as fallback when status not in 200-299
                    return fetch(url + `?paths_id=${encodeURIComponent(paths_id)}&path_key=${encodeURIComponent(path_key)}&suffix=${encodeURIComponent(suffix)}`);
                }
                return res;
            })
            .catch(err => {
                // network error: also attempt GET
                fetch(url + `?paths_id=${encodeURIComponent(paths_id)}&path_key=${encodeURIComponent(path_key)}&suffix=${encodeURIComponent(suffix)}`)
                    .catch(console.error);
            });
        });
    };
}
