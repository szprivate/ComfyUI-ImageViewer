// Helper for tests/test_source_map.py (kept out of tests/*.mjs: it reads stdin) (not a test of its own): what the Edit tab shows on each
// film frame of a range - the clip (pictureAt's key, every live track counted) and the moment of
// its source (srcLocal) - for the cuts given on stdin as [{cut, start, end}]. Prints JSON.
import * as D from "../../js/imageViewer_editTimelineData.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
    const out = JSON.parse(raw).map(({ cut, start, end }) => {
        const fps = cut.fps > 0 ? cut.fps : 24;
        const live = D.liveTracks(cut);
        const frames = [];
        for (let f = start; f <= end; f++) {
            const at = D.pictureAt(cut, (f + 0.5) / fps, live);
            frames.push({ f, key: at && at.clip ? at.key : "", local: at && at.clip ? at.local : null });
        }
        return frames;
    });
    process.stdout.write(JSON.stringify(out));
});
