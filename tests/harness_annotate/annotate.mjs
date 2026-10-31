// End-to-end run of the Annotation tool in the real viewer (headless Chrome),
// against stubbed ComfyUI scripts / routes (server.mjs) and a small ffmpeg mp4:
// text tool (place, move, resize, recolour, edit, delete), marks on video frames
// and ranges, timeline markers + navigation, sidecar persistence across a reload,
// and what "Send to agentY" hands the bridge. Screenshots go to $SHOTS.
//
//   PLAYWRIGHT_CORE=<dir with node_modules/playwright-core> SHOTS=<dir> node annotate.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { boot } from "./common.mjs";

const SHOTS = process.env.SHOTS || ".";
fs.mkdirSync(SHOTS, { recursive: true });
const h = await boot({ halted: true });
const { page } = h;
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
let step = 0;
const ok = (m) => console.log(`ok ${++step} - ${m}`);

const P = (fn, arg) => page.evaluate(fn, arg);
const toClient = (x, y) => P(([x, y]) => window.__panel._normToClient(x, y), [x, y]);
const click = async (x, y, opts) => { const c = await toClient(x, y); await page.mouse.click(c.x, c.y, opts); return c; };
const drag = async (a, b) => {
    const p = await toClient(a[0], a[1]), q = await toClient(b[0], b[1]);
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 });
    await page.mouse.move(q.x, q.y, { steps: 4 }); await page.mouse.up();
};
const items = () => P(() => (window.__panel._annotItems(false) || []).map((i) => ({ ...i })));
const frame = (f) => P(async (f) => { window.__panel.setFrame(f); await new Promise((r) => setTimeout(r, 250)); }, f);
const type = async (text) => { await page.keyboard.type(text, { delay: 5 }); };
const TEXTBOX = "bepic-viewer-panel >> .bepic-annot-text-input";

// -- a clip in the viewer, the annotate tool on ------------------------------
const openVideo = (p) => window.__panel.updateData({ unique_id: "9", tab_name: "agent",
    tabs: { tab1: [{ path: p, kind: "video", fps: 24, frames: 96 }] } }, null);
await P(openVideo, h.videoPath);
await page.waitForFunction(() => window.__panel._videoMode && window.__panel.videoBase.videoWidth > 0);
await P(() => window.__panel.setActiveTool("annotate"));
await frame(48);
ok("video is up, annotate tool on, at frame 48");

// -- text tool: place a text on frame 48 --------------------------------------
await P(() => window.__panel._annotSetTool("text"));
await P(() => window.__panel._annotSetColor("#ffcc00"));
await click(0.3, 0.25);
await page.waitForSelector(TEXTBOX);
await type("face drifts");
await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
await type("eyes too wide");
await page.keyboard.press("Enter");
let it = await items();
assert.equal(it.length, 1);
assert.equal(it[0].type, "text");
assert.equal(it[0].text, "face drifts\neyes too wide");
assert.equal(it[0].f, 48); assert.equal(it[0].fe, 48);
ok("text placed (two lines), stamped with frame 48");
await shot("01_text_on_video");

// -- select, move, resize, recolour --------------------------------------------
const t0 = it[0];
await drag([t0.x + 0.02, t0.y + 0.02], [t0.x + 0.22, t0.y + 0.32]);
it = await items();
assert.ok(it[0].x > t0.x + 0.15 && it[0].y > t0.y + 0.25, `moved: ${it[0].x},${it[0].y}`);
assert.equal(it[0].text, t0.text);
ok("text dragged to a new place");
const size0 = it[0].size;
const handle = await P(() => {
    const v = window.__panel, s = v._annotSelected(), p = v._normToClient(s.x, s.y), b = v._annotTextBox(s), k = v._annotScale();
    return { x: p.x + b.w * k, y: p.y + b.h * k };
});
await page.mouse.move(handle.x, handle.y); await page.mouse.down();
await page.mouse.move(handle.x + 120, handle.y + 60, { steps: 5 }); await page.mouse.up();
it = await items();
assert.ok(it[0].size > size0 * 1.2, `resized ${size0} -> ${it[0].size}`);
ok(`text resized by its corner handle (${size0} -> ${it[0].size})`);
await P(() => window.__panel._annotSetColor("#0a84ff"));
it = await items();
assert.equal(it[0].color, "#0a84ff");
ok("selected text recoloured");
await shot("02_text_moved_resized_recoloured");

// -- edit by double-click -------------------------------------------------------
await P(() => window.__panel._annotSetTool("pen"));       // double-click works with any tool
const mid = await P(() => { const v = window.__panel, s = v._annotSelected(), p = v._normToClient(s.x, s.y); return { x: p.x + 10, y: p.y + 10 }; });
await page.mouse.dblclick(mid.x, mid.y);
await page.waitForSelector(TEXTBOX);
await page.keyboard.press("Control+A");
await type("lips out of sync");
await page.keyboard.press("Enter");
it = await items();
assert.equal(it.length, 1);
assert.equal(it[0].text, "lips out of sync");
ok("double-click edits the text in place");

// -- delete key ------------------------------------------------------------------
await page.keyboard.press("Delete");
assert.equal((await items()).length, 0);
ok("Delete removes the selected text");
await P(() => window.__panel._annotSetTool("text"));
await P(() => window.__panel._annotSetColor("#ff3b30"));

// -- marks over frames and ranges -----------------------------------------------
await P(() => { window.__panel._annot.hold = 10; });
await click(0.12, 0.12);
await type("face drifts"); await page.keyboard.press("Enter");
it = await items();
assert.deepEqual([it[0].f, it[0].fe], [48, 57]);
ok("hold=10 gives the mark frames 48-57");
await P(() => { window.__panel._annot.hold = 1; });
await P(() => window.__panel._annotSetTool("arrow"));
await frame(70);
await drag([0.5, 0.5], [0.7, 0.3]);
await P(() => window.__panel._annotSetTool("text"));
await click(0.55, 0.62); await type("hand clips through wall"); await page.keyboard.press("Enter");
await frame(54);
let vis = await P(() => window.__panel._annotVisible().map((i) => i.type));
assert.deepEqual(vis, ["text"]);
await frame(60);
vis = await P(() => window.__panel._annotVisible().map((i) => i.type));
assert.deepEqual(vis, []);
ok("marks are shown only on their frames");
await frame(75);
await P(() => window.__panel._annotOutHere());
it = await items();
assert.equal(it.filter((i) => i.f === 70).every((i) => i.fe === 75), true);
ok("Out here extends the last annotation to the current frame");
await frame(52);
await shot("03_range_text_frame52");
const marks = await P(() => [...window.__panel.shadowRoot.querySelectorAll(".timeline-annot i")].map((e) => e.title));
assert.equal(marks.length, 2);
assert.match(marks[0], /frames 48-57: face drifts/);
assert.match(marks[1], /frames 70-75/);
ok(`timeline markers: ${JSON.stringify(marks)}`);
await frame(0);
const cur = () => P(() => Math.round(window.__panel.currentFrame));
await P(() => window.__panel._annotJump(1));
assert.equal(await cur(), 48);
await P(() => window.__panel._annotJump(1));
assert.equal(await cur(), 70);
await P(() => window.__panel._annotJump(-1));
assert.equal(await cur(), 48);
ok("next / previous mark moves the playhead");
await shot("04_timeline_markers");

// -- persisted beside the film ----------------------------------------------------
await page.waitForTimeout(1200);
const side = JSON.parse(fs.readFileSync(h.server.sidecar, "utf8"));
assert.equal(side.version, 1);
assert.equal(side.items.length, 3);
assert.ok(side.items.some((i) => i.type === "text" && i.f === 48 && i.fe === 57 && i.text === "face drifts"));
assert.ok(!side.items.some((i) => "_editing" in i));
ok(`sidecar written: ${h.server.sidecar.split(/[\\/]/).pop()} (${side.items.length} marks)`);

// -- a new page: the marks come back from the sidecar -----------------------------
await page.reload();
await page.waitForFunction(() => window.__ready === true);
await P(openVideo, h.videoPath);
await page.waitForFunction(() => window.__panel._videoMode && window.__panel.videoBase.videoWidth > 0);
await page.waitForFunction(() => (window.__panel._annotStore["vid:" + window.__panel._videoKey] || []).length === 3);
assert.equal(await P(() => window.__panel.shadowRoot.querySelectorAll(".timeline-annot i").length), 2);
ok("after a reload the marks and their timeline markers are back");

// -- send to agentY ---------------------------------------------------------------
await P(() => window.__panel.setActiveTool("annotate"));
await frame(10);
await P(() => window.__panel._annotSend(false));
await page.waitForFunction(() => window.__sent.length === 1);
const sent = await P(() => window.__sent[0]);
console.log("---- message to agentY ----\n" + sent.text + "\n---------------------------");
assert.match(sent.text, /Review feedback/);                       // the stage is halted in this run
assert.ok(sent.text.includes(h.videoPath));
assert.match(sent.text, /2 annotations/);
assert.match(sent.text, /frames 48-57 \(00:00:02\.00 to 00:00:02\.09\)/);
assert.match(sent.text, /frames 70-75/);
assert.match(sent.text, /notes: "face drifts"/);
assert.match(sent.text, /text at 12%,12%/);
assert.match(sent.text, /arrow from 50%,50% .* to 70%,30%/);
assert.equal(sent.files.length, 2);
for (const f of sent.files) assert.ok(fs.statSync(f).size > 1000, f);
assert.equal(await cur(), 10);
ok("Send hands the bridge one picture per annotation + the words; playhead restored");
fs.copyFileSync(sent.files[0], `${SHOTS}/05_sent_frame_48.png`);
fs.copyFileSync(sent.files[1], `${SHOTS}/06_sent_frame_70.png`);

await frame(72);
await P(() => window.__panel._annotSend(true));
await page.waitForFunction(() => window.__sent.length === 2);
const one = await P(() => window.__sent[1]);
assert.match(one.text, /1 annotation\./);
assert.equal(one.files.length, 1);
ok("'This frame' sends only the annotation on screen");

// -- an image tab: text + send -----------------------------------------------------
await P((p) => window.__panel.updateData({ unique_id: "10", tab_name: "stills",
    tabs: { tab1: [{ path: p, name: "still.png" }] } }, null), h.imagePath);
await P(() => window.__panel.switchTab("named:stills"));
await page.waitForFunction(() => !window.__panel._videoMode && window.__panel.imgBase.naturalWidth > 0);
await P(() => window.__panel.setActiveTool("annotate"));
await P(() => window.__panel._annotSetTool("text"));
await click(0.1, 0.1); await type("logo too small"); await page.keyboard.press("Enter");
await P(() => window.__panel._annotSend(false));
await page.waitForFunction(() => window.__sent.length === 3);
const img = await P(() => window.__sent[2]);
console.log("---- image message ----\n" + img.text + "\n-----------------------");
assert.match(img.text, /Image: .*still\.png/);
assert.match(img.text, /text at 10%,10%/);
assert.equal(img.files.length, 1);
fs.copyFileSync(img.files[0], `${SHOTS}/07_sent_image.png`);
await shot("08_image_tab");
ok("image tab: text sent as picture + words, with the image path");

// -- a picture's marks are kept beside it, and read once a session ----------------
const imgSide = h.imagePath.replace(/\.[^.\\/]+$/, "") + ".annotations.json";
const sideCount = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")).items.length; } catch (_) { return -1; } };
await page.waitForTimeout(900);
assert.equal(sideCount(imgSide), 1);
const vidBefore = sideCount(h.server.sidecar);
// To the clip and back, twice: neither file's marks may be read in a second time.
for (let i = 0; i < 2; i++) {
    await P(() => window.__panel.switchTab("named:agent")); await page.waitForTimeout(300);
    await P(() => window.__panel.switchTab("named:stills")); await page.waitForTimeout(300);
}
await page.waitForTimeout(900);
assert.equal((await items()).length, 1);
assert.equal(sideCount(imgSide), 1);
assert.equal(sideCount(h.server.sidecar), vidBefore);
const said = await P(() => window.__panel.agentViewerAnnotations({}));
assert.equal(said.count, 1);
assert.deepEqual(said.annotations[0].notes, ["logo too small"]);
assert.equal(said.saved_beside, true);
ok("a picture's marks are written beside it; switching away and back reads no file twice");

assert.deepEqual(h.errors.filter((e) => !/404/.test(e)), []);
ok("no page errors");
await h.close();
console.log(`\nall ${step} checks passed`);
