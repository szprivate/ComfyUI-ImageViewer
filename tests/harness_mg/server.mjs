// node tests/harness_mg/server.mjs [port]  -> http://127.0.0.1:8766/page.html?scene=lower_third
// Serves the viewer's js/ and the example scenes from the agentY-core checkout; /save writes to a temp folder.
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const JS = path.join(HERE, "..", "..", "js");
const EX = path.join(HERE, "..", "..", "..", "agentY-core", "agenty_core", "motion_graphics", "examples");
const OUT = path.join(os.tmpdir(), "mg_harness_saved"); fs.mkdirSync(OUT, { recursive: true });
const types = { ".js": "text/javascript", ".html": "text/html", ".json": "application/json", ".png": "image/png" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); const p = u.pathname;
  if (p === "/save" && req.method === "POST") {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { fs.writeFileSync(path.join(OUT, u.searchParams.get("name") + ".mgscene.json"), b); res.end("ok"); }); return;
  }
  const file = p.startsWith("/js/") ? path.join(JS, p.slice(4)) : p.startsWith("/scenes/") ? path.join(EX, p.slice(8)) : path.join(HERE, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); res.end(buf);
  });
}).listen(+process.argv[2] || 8766, "127.0.0.1", () => console.log("up"));
