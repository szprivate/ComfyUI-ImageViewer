// Paint's brush tips: the .abr reader (on files built here byte by byte, as the format is laid out),
// PackBits, shrinking, a tip from pixels, and the brush stamping with a tip, turned and jittered.
// Run: node --test tests/test_paint_abr.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "../js/imageViewer_paintAbr.js";
import * as D from "../js/imageViewer_paintData.js";

class W {
    constructor() { this.b = []; }
    u8(v) { this.b.push(v & 255); return this; }
    u16(v) { return this.u8(v >> 8).u8(v); }
    u32(v) { return this.u16(v >>> 16).u16(v & 0xffff); }
    i32(v) { return this.u32(v >>> 0); }
    s(t) { for (const c of t) this.u8(c.charCodeAt(0)); return this; }
    bytes(a) { for (const v of a) this.u8(v); return this; }
    get length() { return this.b.length; }
    out() { return new Uint8Array(this.b); }
}

/** PackBits, the simplest way: every row as literal runs of at most 128. */
const pack = (row) => { const o = []; for (let i = 0; i < row.length; i += 128) { const n = Math.min(128, row.length - i); o.push(n - 1, ...row.slice(i, i + n)); } return o; };
const tipPx = (w, h) => Array.from({ length: w * h }, (_, i) => (i * 37) % 256);

function sampleBody(w, h, px, rle, depth = 8) {
    const b = new W();
    b.i32(0).i32(0).i32(h).i32(w).u16(depth).u8(rle ? 1 : 0);
    const data = depth === 16 ? px.flatMap((v) => [v, 0]) : px;
    if (!rle) b.bytes(data);
    else {
        const rows = [];
        for (let y = 0; y < h; y++) rows.push(pack(data.slice(y * w * (depth / 8), (y + 1) * w * (depth / 8))));
        for (const r of rows) b.u16(r.length);
        for (const r of rows) b.bytes(r);
    }
    return b.b;
}

test("PackBits: literal and repeated runs", () => {
    const [out, p] = A.packbits(new Uint8Array([2, 1, 2, 3, 0xfd, 9, 0x80, 0, 7]), 0, 8);
    assert.deepEqual([...out], [1, 2, 3, 9, 9, 9, 9, 7]);
    assert.equal(p, 9);
});

test("version 1 and 2: sampled brushes read, computed ones left out", () => {
    for (const version of [1, 2]) {
        const f = new W().u16(version).u16(3);
        // A computed (round) brush: type 1.
        f.u16(1).u32(14).bytes(new Array(14).fill(0));
        for (const [w, h, rle] of [[5, 4, false], [7, 3, true]]) {
            const body = new W().u32(0).u16(30);
            if (version === 2) body.u32(3).u16(65).u16(98).u16(0);
            body.u8(1).bytes(new Array(8).fill(0)).bytes(sampleBody(w, h, tipPx(w, h), rle));
            f.u16(2).u32(body.length).bytes(body.b);
        }
        const r = A.readAbr(f.out());
        assert.equal(r.version, version);
        assert.equal(r.tips.length, 2);
        assert.equal(r.left, 1);
        assert.deepEqual([r.tips[0].w, r.tips[0].h, r.tips[1].w, r.tips[1].h], [5, 4, 7, 3]);
        assert.deepEqual([...r.tips[1].a], tipPx(7, 3));
        assert.equal(r.tips[0].spacing, 30);
        if (version === 2) assert.equal(r.tips[0].name, "Ab");
    }
});

test("version 6: the samp section, sub-versions 1 and 2, 8 and 16 bits, padded blocks", () => {
    for (const sub of [1, 2]) {
        const samp = new W();
        for (const [w, h, rle, depth] of [[6, 5, true, 8], [3, 3, false, 16]]) {
            const blk = new W().u8(4).s("abcd").bytes(new Array(sub === 1 ? 10 : 264).fill(0)).bytes(sampleBody(w, h, tipPx(w, h), rle, depth));
            samp.u32(blk.length).bytes(blk.b);
            while (samp.length % 4) samp.u8(0);
        }
        const f = new W().u16(6).u16(sub).s("8BIM").s("samp").u32(samp.length).bytes(samp.b).s("8BIM").s("desc").u32(4).u32(0);
        const r = A.readAbr(f.out());
        assert.equal(r.tips.length, 2, `sub ${sub}`);
        assert.deepEqual([...r.tips[0].a], tipPx(6, 5));
        assert.deepEqual([...r.tips[1].a], tipPx(3, 3));
        assert.ok(r.notes.some((n) => n.includes("settings")));
    }
    assert.throws(() => A.readAbr(new Uint8Array([0, 9, 0, 0])), /version 9/);
});

test("a tip shrinks to its largest side and is made from dark pixels", () => {
    const big = { name: "b", w: 2048, h: 1024, a: new Uint8Array(2048 * 1024).fill(200) };
    const s = A.shrinkTip(big, 512);
    assert.deepEqual([s.w, s.h, s.a[100]], [512, 256, 200]);
    const px = new Uint8ClampedArray(10 * 10 * 4).fill(255);
    for (let y = 3; y < 6; y++) for (let x = 2; x < 8; x++) px.set([0, 0, 0, 255], (y * 10 + x) * 4);
    const t = A.tipFromPixels(px, 10, 10);
    assert.deepEqual([t.w, t.h, t.a[0]], [6, 3, 255]);
    assert.equal(A.tipFromPixels(new Uint8ClampedArray(400).fill(255), 10, 10), null);
});

test("a stamp with a tip paints its shape, turned by the angle", () => {
    // A bar tip, 10 wide and 2 high: across at 0°, down at 90°.
    const tip = { w: 10, h: 2, a: new Uint8Array(20).fill(255) };
    const mk = () => { const w = 40, h = 40, px = new Uint8ClampedArray(w * h * 4);
        return { px, orig: new Uint8ClampedArray(px), cover: new Float32Array(w * h), lw: w, lh: h, lx: 0, ly: 0, color: [255, 0, 0], opacity: 1, erase: false, lockAlpha: false, sel: null, W: w, H: h, tip }; };
    const a = mk(); D.stamp(a, 20, 20, 10, 1, 1, 0);
    assert.equal(a.px[(20 * 40 + 27) * 4 + 3], 255);
    assert.equal(a.px[(27 * 40 + 20) * 4 + 3], 0);
    const b = mk(); D.stamp(b, 20, 20, 10, 1, 1, Math.PI / 2);
    assert.equal(b.px[(27 * 40 + 20) * 4 + 3], 255);
    assert.equal(b.px[(20 * 40 + 27) * 4 + 3], 0);
    // Jitter: the same seed, the same dabs; none moves beyond its scatter.
    const r1 = D.seeded(5), r2 = D.seeded(5);
    for (let i = 0; i < 20; i++) {
        const j = D.jitter(r1, 10, { scatter: 50, sizeJitter: 40, angleJitter: 100 });
        assert.deepEqual(j, D.jitter(r2, 10, { scatter: 50, sizeJitter: 40, angleJitter: 100 }));
        assert.ok(Math.abs(j.dx) <= 10 && Math.abs(j.dy) <= 10 && j.k >= 0.6 && j.k <= 1 && Math.abs(j.da) <= Math.PI);
    }
});
