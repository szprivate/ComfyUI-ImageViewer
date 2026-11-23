// Reads cases [{pts, kind, closed, scale}] as JSON on stdin, answers each shape's polyline (tests/test_mask_shape.py).
import * as MS from "../js/imageViewer_maskShape.js";
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
    const cases = JSON.parse(s);
    const out = cases.map((c) => MS.shapePolygon(c.pts.map(MS.fromArr), c.kind, c.closed, c.scale));
    process.stdout.write(JSON.stringify(out));
});
