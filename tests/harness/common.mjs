// Shared by the harness runs: a small test mp4, the server, a browser.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./server.mjs";

export function makeVideo(dir, frames = 96, fps = 24) {
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, "shot_01.mp4");
    execFileSync(process.env.FFMPEG || "ffmpeg", ["-y", "-loglevel", "error",
        "-f", "lavfi", "-i", `testsrc=size=640x360:rate=${fps}:duration=${frames / fps}`,
        "-pix_fmt", "yuv420p", "-g", "1", "-c:v", "libx264", out]);
    return out;
}

// PLAYWRIGHT_CORE: a directory holding node_modules/playwright-core;
// CHROME: a Chrome / Chromium executable. Always a fresh headless browser.
export async function launch() {
    const req = createRequire((process.env.PLAYWRIGHT_CORE || "") + "/");
    const { chromium } = req("playwright-core");
    return chromium.launch({
        executablePath: process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
        headless: true, args: ["--autoplay-policy=no-user-gesture-required"],
    });
}

export function makeImage(dir) {
    const out = path.join(dir, "still.png");
    execFileSync(process.env.FFMPEG || "ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi",
        "-i", "testsrc2=size=640x360", "-frames:v", "1", out]);
    return out;
}

export async function boot({ halted = false } = {}) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "bepic-annot-"));
    const videoPath = makeVideo(path.join(work, "film"));
    const imagePath = makeImage(path.join(work, "film"));
    const server = await startServer({ videoPath, dataDir: path.join(work, "out") });
    const browser = await launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(server.url + "/page?bepic_viewer_only=1" + (halted ? "&halted=1" : ""));
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    return { page, browser, server, work, videoPath, imagePath, errors,
        async close() { await browser.close(); server.close(); } };
}
