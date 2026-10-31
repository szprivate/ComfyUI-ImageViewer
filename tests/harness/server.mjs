import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
const VIEWER = process.argv[2], HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".png": "image/png",
                ".jpg": "image/jpeg", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };

// HARNESS_MEDIA=1: answer /bepic/thumb and /bepic/raw_view with real pictures, made up per path, with the
// real server's cache headers - a tile is kept for good, a picture is revalidated. THUMB_DELAY_MS holds every
// tile back that long, the way the thumbnails of renders on a network share arrive
// (tests/test_history_switch_perf_browser.py).
const MEDIA = process.env.HARNESS_MEDIA === "1";
const THUMB_DELAY_MS = Number(process.env.THUMB_DELAY_MS || 0);
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1");
  data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out;
};
const pngs = new Map();
function png(w, h, seed) {
  const key = `${w}x${h}:${seed}`;
  if (pngs.has(key)) return pngs.get(key);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3;
    raw[o] = (x + seed * 37) & 255; raw[o + 1] = (y + seed * 91) & 255; raw[o + 2] = ((x ^ y) + seed) & 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const buf = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
  pngs.set(key, buf); return buf;
}
const seedOf = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) & 0xffff, 7);

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); let p = u.pathname;
  if (MEDIA && (p === "/bepic/thumb" || p === "/bepic/raw_view")) {
    const seed = seedOf(u.searchParams.get("path") || u.searchParams.get("filename"));
    if (p === "/bepic/thumb") {
      const send = () => { res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=31536000" }); res.end(png(64, 40, seed)); };
      if (THUMB_DELAY_MS) setTimeout(send, THUMB_DELAY_MS); else send();
    } else {
      const etag = `"${seed}"`;
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag, "cache-control": "no-cache" }); res.end(); return; }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache", etag }); res.end(png(1600, 1000, seed));
    }
    return;
  }
  // HARNESS_MEDIA_DIR: real media and its readings, served under /media/ - and a file the viewer asks for as
  // D:/out/<name> (raw_view / view_file) is the one of that name there, with ranges, so a film can be sought.
  const MDIR = process.env.HARNESS_MEDIA_DIR;
  if (MDIR && (p.startsWith("/media/") || p === "/bepic/view_file" || p === "/bepic/raw_view")) {
    const name = p.startsWith("/media/") ? decodeURIComponent(p.slice(7)) : path.basename(u.searchParams.get("path") || "");
    const f = path.resolve(MDIR, name);
    if (!f.startsWith(path.resolve(MDIR)) || !fs.existsSync(f)) { res.writeHead(404); res.end("nf"); return; }
    const size = fs.statSync(f).size, type = types[path.extname(f).toLowerCase()] || "application/octet-stream";
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (range) {
      const a = range[1] ? Number(range[1]) : 0, b = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${a}-${b}/${size}`, "accept-ranges": "bytes", "content-length": b - a + 1 });
      fs.createReadStream(f, { start: a, end: b }).pipe(res);
    } else {
      res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
      fs.createReadStream(f).pipe(res);
    }
    return;
  }
  let file = p.startsWith("/scenes/") ? path.join(VIEWER, "..", "agentY-core", "agenty_core", "motion_graphics", "examples", p.slice(8))
           : p.startsWith("/extensions/viewer/") ? path.join(VIEWER, "js", p.slice("/extensions/viewer/".length))
           : path.join(HERE, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); res.end(buf);
  });
}).listen(Number(process.env.PORT) || 8765, () => console.log("up"));
