// imageViewer_compExpr.js
// Comp: expressions on a node's numbers - a small, safe language (no names but the ones below, no loops,
// nothing reaches the page). Imports nothing; src/comp_expr.py is the same in Python and the two must agree
// (tests/test_comp_parity.py renders comps with expressions in both).
//
//   numbers      1  2.5  .5  1e3
//   operators    + - * / %  ^ (power, right to left)  < <= > >= == !=  && || !  c ? a : b
//   names        frame  time (frame / fps)  fps  width  height (the comp's)  value (the number's own,
//                its keys or what is typed)  pi  e
//   functions    sin cos tan asin acos atan atan2(y, x) sqrt abs exp log log10 pow floor ceil round fract
//                sign min max clamp(x, lo, hi) lerp(a, b, t) smoothstep(e0, e1, x) step(edge, x)
//                mod(a, b) (never negative) degrees radians if(c, a, b) random(seed) noise(x[, seed])
//   another node Blur1.size   Transform1.translate.x (or .y; a colour .r .g .b .a)   'Erode/Dilate1'.size
//                A bare vector (Transform1.translate) in a vector's expression is the same component.
//
// A wrong expression, or one that comes out as no number, leaves the value as it is (NaN from evalExpr).
// True is 1, false 0; a condition is true when it is a number other than 0.

const FNS = {
    sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan], asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan],
    atan2: [2, Math.atan2], sqrt: [1, Math.sqrt], abs: [1, Math.abs], exp: [1, Math.exp], log: [1, Math.log], log10: [1, Math.log10],
    pow: [2, Math.pow], floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, (x) => Math.floor(x + 0.5)],
    fract: [1, (x) => x - Math.floor(x)], sign: [1, (x) => (x > 0 ? 1 : x < 0 ? -1 : x)],
    min: [-1, (...a) => a.reduce((m, v) => (v < m || v !== v ? v : m))], max: [-1, (...a) => a.reduce((m, v) => (v > m || v !== v ? v : m))],
    clamp: [3, (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)], lerp: [3, (a, b, t) => a + (b - a) * t], mix: [3, (a, b, t) => a + (b - a) * t],
    smoothstep: [3, (e0, e1, x) => { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }],
    step: [2, (edge, x) => (x < edge ? 0 : 1)], mod: [2, (a, b) => a - b * Math.floor(a / b)],
    degrees: [1, (r) => (r * 180) / Math.PI], radians: [1, (d) => (d * Math.PI) / 180],
    if: [3, (c, a, b) => (truthy(c) ? a : b)],
    random: [1, (s) => hash01(Math.floor(s))],
    noise: [-1, (x, seed = 0) => noise1(x, seed)],
};
export const EXPR_FUNCTIONS = Object.keys(FNS);
export const EXPR_NAMES = ["frame", "time", "fps", "width", "height", "value", "pi", "e"];
const COMPONENTS = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, 0: 0, 1: 1, 2: 2, 3: 3 };

const truthy = (v) => v !== 0 && v === v;

/** A whole number's hash, 0 <= h < 2^32 (the same in Python: comp_expr.hash32). */
export function hash32(n) {
    const m = 4294967296;
    let x = ((n % m) + m) % m;
    x = x >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x;
}
const hash01 = (n) => hash32(n) / 4294967296;
function noise1(x, seed) {
    const i = Math.floor(x), f = x - i, s = Math.floor(seed) * 7919;
    const a = hash01(i + s) * 2 - 1, b = hash01(i + 1 + s) * 2 - 1;
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
}

// ── parsing ──────────────────────────────────────────────────────────────────

function tokens(src) {
    const out = [];
    let i = 0;
    const s = String(src);
    while (i < s.length) {
        const c = s[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
        // A dot right after a name is a member (Node.param), never the start of a number.
        const prev = out[out.length - 1], afterName = prev && (prev.t === "i" || prev.t === "s");
        const num = afterName && c === "." ? null : /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
        if (num) { out.push({ t: "n", v: parseFloat(num[0]) }); i += num[0].length; continue; }
        const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
        if (id) { out.push({ t: "i", v: id[0] }); i += id[0].length; continue; }
        if (c === "'" || c === '"') {
            const j = s.indexOf(c, i + 1);
            if (j < 0) throw new Error("a name in quotes is not closed");
            out.push({ t: "s", v: s.slice(i + 1, j) }); i = j + 1; continue;
        }
        const two = s.slice(i, i + 2);
        if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) { out.push({ t: "o", v: two }); i += 2; continue; }
        if ("+-*/%^<>!?:(),.".includes(c)) { out.push({ t: "o", v: c }); i++; continue; }
        throw new Error(`"${c}" is not part of an expression`);
    }
    return out;
}

/** The expression as a tree; throws an Error saying what is wrong. */
export function parseExpr(src) {
    const tk = tokens(src);
    let p = 0;
    const peek = () => tk[p];
    const isOp = (v) => tk[p] && tk[p].t === "o" && tk[p].v === v;
    const want = (v) => { if (!isOp(v)) throw new Error(`"${v}" expected${tk[p] ? ` before "${tk[p].v}"` : " at the end"}`); p++; };
    const ternary = () => {
        const c = or();
        if (isOp("?")) { p++; const a = ternary(); want(":"); const b = ternary(); return { k: "t", c, a, b }; }
        return c;
    };
    const left = (next, ops) => () => {
        let a = next();
        while (tk[p] && tk[p].t === "o" && ops.includes(tk[p].v)) { const op = tk[p++].v; a = { k: "b", op, a, b: next() }; }
        return a;
    };
    const unary = () => {
        if (isOp("-") || isOp("+") || isOp("!")) { const op = tk[p++].v; return { k: "u", op, a: unary() }; }
        return power();
    };
    const mul = left(unary, ["*", "/", "%"]);
    const add = left(mul, ["+", "-"]);
    const cmp = left(add, ["<", "<=", ">", ">=", "==", "!="]);
    const and = left(cmp, ["&&"]);
    const or = left(and, ["||"]);
    function power() {
        const a = postfix();
        if (isOp("^")) { p++; return { k: "b", op: "^", a, b: unary() }; }
        return a;
    }
    function members() {
        const m = [];
        while (isOp(".")) {
            p++;
            const t = peek();
            if (!t || (t.t !== "i" && t.t !== "n")) throw new Error("a name expected after \".\"");
            m.push(String(t.t === "n" ? t.v : t.v)); p++;
        }
        return m;
    }
    function ref(nodeId) {
        const m = members();
        if (!m.length) throw new Error(`"${nodeId}" alone: name one of its numbers (${nodeId}.size)`);
        if (m.length > 2) throw new Error(`"${[nodeId, ...m].join(".")}": a node, a number and at most a component`);
        if (m.length === 2 && !(m[1] in COMPONENTS)) throw new Error(`"${m[1]}" is no component (x y z w, r g b a)`);
        return { k: "r", node: nodeId, param: m[0], comp: m.length === 2 ? COMPONENTS[m[1]] : null };
    }
    function postfix() {
        const t = peek();
        if (!t) throw new Error("the expression ends too soon");
        if (t.t === "n") { p++; return { k: "n", v: t.v }; }
        if (t.t === "s") { p++; return ref(t.v); }
        if (t.t === "i") {
            p++;
            if (isOp("(")) {
                p++;
                const args = [];
                if (!isOp(")")) { args.push(ternary()); while (isOp(",")) { p++; args.push(ternary()); } }
                want(")");
                const f = FNS[t.v];
                if (!f) throw new Error(`no function "${t.v}"`);
                if (f[0] >= 0 ? args.length !== f[0] : args.length < 1) throw new Error(`${t.v} takes ${f[0] >= 0 ? f[0] : "one or more"} number(s)`);
                if (t.v === "noise" && args.length > 2) throw new Error("noise takes one or two numbers");
                return { k: "f", name: t.v, args };
            }
            if (isOp(".")) return ref(t.v);
            if (!EXPR_NAMES.includes(t.v)) throw new Error(`no name "${t.v}" (another node's number is Node.param)`);
            return { k: "v", name: t.v };
        }
        if (isOp("(")) { p++; const a = ternary(); want(")"); return a; }
        throw new Error(`"${t.v}" in the wrong place`);
    }
    if (!tk.length) throw new Error("empty");
    const tree = ternary();
    if (p < tk.length) throw new Error(`"${tk[p].v}" in the wrong place`);
    return tree;
}

const parsed = new Map();
function treeOf(src) {
    if (parsed.has(src)) return parsed.get(src);
    let t;
    try { t = parseExpr(src); } catch (e) { t = { err: String(e.message || e) }; }
    if (parsed.size > 500) parsed.clear();
    parsed.set(src, t);
    return t;
}

/** What is wrong with an expression, or null. */
export function checkExpr(src) { const t = treeOf(String(src || "")); return t.err || null; }

/** The node ids an expression reads. */
export function exprRefs(src) {
    const t = treeOf(String(src || "")), out = [];
    const walk = (n) => {
        if (!n || n.err) return;
        if (n.k === "r") { if (!out.includes(n.node)) out.push(n.node); return; }
        for (const c of [n.a, n.b, n.c, ...(n.args || [])]) if (c) walk(c);
    };
    walk(t);
    return out;
}

const div = (a, b) => a / b;
const BIN = {
    "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "/": div, "%": (a, b) => a % b, "^": Math.pow,
    "<": (a, b) => (a < b ? 1 : 0), "<=": (a, b) => (a <= b ? 1 : 0), ">": (a, b) => (a > b ? 1 : 0), ">=": (a, b) => (a >= b ? 1 : 0),
    "==": (a, b) => (a === b ? 1 : 0), "!=": (a, b) => (a !== b ? 1 : 0),
    "&&": (a, b) => (truthy(a) && truthy(b) ? 1 : 0), "||": (a, b) => (truthy(a) || truthy(b) ? 1 : 0),
};

/**
 * The expression's number. ``env``: { vars: {frame, time, fps, width, height, value}, ref(nodeId, param, comp)
 * -> number (NaN when there is none) }. NaN when it is wrong or makes no number.
 */
export function evalExpr(src, env) {
    const t = treeOf(String(src || ""));
    if (t.err) return NaN;
    const ev = (n) => {
        switch (n.k) {
        case "n": return n.v;
        case "v": return n.name === "pi" ? Math.PI : n.name === "e" ? Math.E : Number(env.vars[n.name] ?? NaN);
        case "u": { const a = ev(n.a); return n.op === "-" ? -a : n.op === "!" ? (truthy(a) ? 0 : 1) : a; }
        case "b": return BIN[n.op](ev(n.a), ev(n.b));
        case "t": return truthy(ev(n.c)) ? ev(n.a) : ev(n.b);
        case "f": return FNS[n.name][1](...n.args.map(ev));
        case "r": return env.ref ? Number(env.ref(n.node, n.param, n.comp)) : NaN;
        default: return NaN;
        }
    };
    try { return ev(t); } catch (_) { return NaN; }
}

/** How a node is named in an expression: as it is when it can be, else in quotes. */
export function refName(id) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(id) && !EXPR_NAMES.includes(id) && !FNS[id] ? id : `'${String(id).replace(/'/g, "")}'`; }

/** The expression a link writes: another node's number (component ``comp`` of a vector, or null), x scale + offset. */
export function linkExpr(id, param, comp, scale = 1, offset = 0) {
    const letter = comp === null || comp === undefined ? "" : "." + "xyzw"[comp];
    let s = `${refName(id)}.${param}${letter}`;
    if (scale !== 1) s += ` * ${scale}`;
    if (offset) s += offset < 0 ? ` - ${-offset}` : ` + ${offset}`;
    return s;
}

/** A link written by linkExpr, read back: {node, param, comp, scale, offset}, or null for any other expression. */
export function parseLink(src) {
    const m = /^\s*('[^']*'|[A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([xyzwrgba0-3]))?\s*(?:\*\s*(-?[\d.eE+-]+))?\s*(?:([+-])\s*([\d.eE+-]+))?\s*$/.exec(String(src || ""));
    if (!m) return null;
    const node = m[1].startsWith("'") ? m[1].slice(1, -1) : m[1];
    if (EXPR_NAMES.includes(node)) return null;
    const scale = m[4] !== undefined ? parseFloat(m[4]) : 1, off = m[6] !== undefined ? parseFloat(m[6]) * (m[5] === "-" ? -1 : 1) : 0;
    if (!Number.isFinite(scale) || !Number.isFinite(off)) return null;
    return { node, param: m[2], comp: m[3] !== undefined ? COMPONENTS[m[3]] : null, scale, offset: off };
}

/** The expression with every reference to node ``from`` made one to node ``to``. */
export function renameRef(src, from, to) {
    const esc = String(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let out = String(src).replace(new RegExp(`(['"])${esc}\\1(?=\\s*\\.)`, "g"), () => refName(to));
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(from)) out = out.replace(new RegExp(`(^|[^A-Za-z0-9_.'"])${esc}(?=\\s*\\.)`, "g"), (m, a) => a + refName(to));
    return out;
}
