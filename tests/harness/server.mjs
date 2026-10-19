import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const VIEWER = process.argv[2], HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".png": "image/png" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); let p = u.pathname;
  let file = p.startsWith("/extensions/viewer/") ? path.join(VIEWER, "js", p.slice("/extensions/viewer/".length))
           : path.join(HERE, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); res.end(buf);
  });
}).listen(8765, () => console.log("up"));
