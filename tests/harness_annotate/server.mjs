// The viewer's page served without ComfyUI: its own js, stand-ins for ComfyUI's
// scripts, and stubs for the /bepic routes the annotation tool uses. Sidecar and
// saved pictures are really written, into `dataDir`, so a test can read them.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
    ".html": "text/html", ".json": "application/json", ".png": "image/png", ".mp4": "video/mp4",
    ".svg": "image/svg+xml" };

export function startServer({ videoPath, dataDir, port = 0 }) {
    fs.mkdirSync(dataDir, { recursive: true });
    const sidecar = videoPath.replace(/\.[^.]+$/, "") + ".annotations.json";
    const log = [];
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        const send = (code, body, type = "application/json") => {
            res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-cache" });
            res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
        };
        const file = (p) => {
            try { return fs.readFileSync(p); } catch (_) { return null; }
        };
        const p = u.pathname;
        if (p === "/page") {
            return send(200, fs.readFileSync(path.join(HERE, "page.html")), "text/html");
        }
        if (p === "/ext/scripts/app.js") return send(200, file(path.join(HERE, "app_stub.js")), TYPES[".js"]);
        if (p === "/ext/scripts/api.js") return send(200, file(path.join(HERE, "api_stub.js")), TYPES[".js"]);
        if (p.startsWith("/ext/viewer/")) {
            const f = path.join(ROOT, p.slice("/ext/viewer/".length));
            const b = f.startsWith(ROOT) ? file(f) : null;
            return b ? send(200, b, TYPES[path.extname(f)] || "application/octet-stream") : send(404, "no");
        }
        if (p === "/bepic/raw_view" || p === "/bepic/view_file") {
            const want = u.searchParams.get("path");
            if (want && !/\.mp4$/i.test(want) && fs.existsSync(want)) {
                return send(200, fs.readFileSync(want), TYPES[path.extname(want).toLowerCase()] || "application/octet-stream");
            }
            const stat = fs.statSync(videoPath);
            const range = req.headers.range;
            if (range) {
                const m = /bytes=(\d*)-(\d*)/.exec(range);
                const start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : stat.size - 1;
                res.writeHead(206, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
                    "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
                return fs.createReadStream(videoPath, { start, end }).pipe(res);
            }
            res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": stat.size });
            return fs.createReadStream(videoPath).pipe(res);
        }
        if (p === "/bepic/video_annotations") {
            if (req.method === "GET") {
                let doc = { version: 1, items: [] };
                try { doc = JSON.parse(fs.readFileSync(sidecar, "utf8")); } catch (_) {}
                return send(200, { ...doc, media_path: videoPath });
            }
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const j = JSON.parse(body);
                log.push({ route: "video_annotations", count: (j.items || []).length });
                fs.writeFileSync(sidecar, JSON.stringify({ version: 1, media: j.media, fps: j.fps,
                    frames: j.frames, items: j.items || [] }, null, 1));
                send(200, { ok: true, path: sidecar, media_path: videoPath, count: (j.items || []).length });
            });
            return;
        }
        if (p === "/bepic/save_annotation") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const j = JSON.parse(body);
                const raw = Buffer.from(String(j.dataurl).split(",")[1], "base64");
                const n = fs.readdirSync(dataDir).filter((f) => f.endsWith(".png")).length + 1;
                const name = `${String(j.name || "annotation").replace(/[^A-Za-z0-9_-]/g, "")}_${String(n).padStart(3, "0")}.png`;
                const full = path.join(dataDir, name);
                fs.writeFileSync(full, raw);
                send(200, { filename: name, subfolder: "", type: "output", path: full });
            });
            return;
        }
        if (p.startsWith("/bepic/")) return send(200, {});
        send(404, "not found");
    });
    return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve({
        url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close(), sidecar, log,
    })));
}
