// bEpicViewer_codeHighlight.js
// A small, dependency-free syntax highlighter for the Agent code panel.
//
// highlight(code, language) -> one array per line, each a list of [type, text]
// pairs. Types: kw, bi (builtin), str, num, com, fn, cls, dec, key, op, var,
// tag, head, "" (plain). No DOM here, so it runs under node for the tests; the
// panel turns the pairs into spans (always as textContent).
//
// Not a parser: a scanner that knows comments, strings, numbers and word lists
// per language. Good enough to read agent code; never throws, never loses text
// (the pairs always join back to the input).

const PY_KW = new Set(("False None True and as assert async await break class continue def del elif else " +
    "except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield " +
    "match case").split(" "));
const PY_BI = new Set(("print len range int str float bool list dict set tuple open enumerate zip map filter sorted " +
    "sum min max abs round isinstance getattr setattr hasattr type super self cls Exception ValueError KeyError " +
    "TypeError OSError any all next iter reversed repr format input bytes bytearray object property staticmethod " +
    "classmethod").split(" "));
const JS_KW = new Set(("break case catch class const continue debugger default delete do else export extends " +
    "finally for function if import in instanceof let new of return static super switch this throw try typeof var " +
    "void while with yield async await from as null undefined true false interface type enum implements public " +
    "private protected readonly declare namespace abstract get set").split(" "));
const JS_BI = new Set(("console window document Math JSON Object Array String Number Boolean Promise Map Set Date " +
    "Error RegExp parseInt parseFloat require module exports process fetch setTimeout").split(" "));
const SH_KW = new Set(("if then else elif fi for while until do done case esac in function return exit export " +
    "local source set unset cd echo read").split(" "));
const JSON_LIT = new Set(["true", "false", "null"]);

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y;

function push(out, type, text) {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last[0] === type) last[1] += text; else out.push([type, text]);
}

/** The end index of a quoted string starting at i (quote char q), honouring
 *  backslashes. Unterminated strings end at the line's end (or the text's). */
function endQuoted(code, i, q, multiline) {
    let j = i + 1;
    while (j < code.length) {
        const c = code[j];
        if (c === "\\") { j += 2; continue; }
        if (c === q) return j + 1;
        if (c === "\n" && !multiline) return j;
        j++;
    }
    return code.length;
}

function match(re, code, i) { re.lastIndex = i; const m = re.exec(code); return m ? m[0] : ""; }

/** python / javascript family / shell / yaml / toml */
function scanC(code, out, lang) {
    const py = lang === "python", sh = lang === "shell";
    const hashComment = py || sh || lang === "yaml" || lang === "toml";
    const kw = py ? PY_KW : sh ? SH_KW : JS_KW;
    const bi = py ? PY_BI : sh ? new Set() : JS_BI;
    let prevWord = "", i = 0;
    while (i < code.length) {
        const c = code[i], n2 = code.substr(i, 2);
        if (hashComment && c === "#" && !(sh && (code[i - 1] === "$" || code[i - 1] === "{"))) {
            let j = code.indexOf("\n", i); if (j < 0) j = code.length;
            push(out, "com", code.slice(i, j)); i = j; continue;
        }
        if (!hashComment && n2 === "//") {
            let j = code.indexOf("\n", i); if (j < 0) j = code.length;
            push(out, "com", code.slice(i, j)); i = j; continue;
        }
        if (!hashComment && n2 === "/*") {
            let j = code.indexOf("*/", i + 2); j = j < 0 ? code.length : j + 2;
            push(out, "com", code.slice(i, j)); i = j; continue;
        }
        if (c === '"' || c === "'" || (c === "`" && !py && !sh)) {
            let j;
            if (py && code.startsWith(c.repeat(3), i)) {
                const close = code.indexOf(c.repeat(3), i + 3);
                j = close < 0 ? code.length : close + 3;
            } else j = endQuoted(code, i, c, c === "`");
            push(out, "str", code.slice(i, j)); i = j; prevWord = ""; continue;
        }
        if (py && /[rRbBuUfF]/.test(c) && !/[\w$]/.test(code[i - 1] || "")) {   // f"..", rb'..'
            const m = /^[rRbBuUfF]{1,2}(?=["'])/.exec(code.slice(i, i + 3));
            if (m) {
                const at = i + m[0].length, q = code[at];
                let j;
                if (code.startsWith(q.repeat(3), at)) {
                    const close = code.indexOf(q.repeat(3), at + 3);
                    j = close < 0 ? code.length : close + 3;
                } else j = endQuoted(code, at, q, false);
                push(out, "str", code.slice(i, j)); i = j; continue;
            }
        }
        if (sh && c === "$") {
            const m = /^\$(?:\{[^}\n]*\}|\(|[A-Za-z_]\w*|[0-9@#?*$!-])/.exec(code.slice(i, i + 80));
            if (m) { push(out, "var", m[0]); i += m[0].length; continue; }
        }
        if (py && c === "@" && /^\s*$/.test(code.slice(code.lastIndexOf("\n", i - 1) + 1, i))) {
            const w = match(/@[\w.]+/y, code, i);
            if (w) { push(out, "dec", w); i += w.length; continue; }
        }
        if ((/\d/.test(c) || (c === "." && /\d/.test(code[i + 1] || ""))) && !/[\w$]/.test(code[i - 1] || "")) {
            const w = match(NUM, code, i);
            if (w) { push(out, "num", w); i += w.length; continue; }
        }
        if (sh && c === "-" && /\s/.test(code[i - 1] || " ")) {
            const w = match(/--?[A-Za-z][\w-]*/y, code, i);
            if (w) { push(out, "bi", w); i += w.length; continue; }
        }
        if (/[A-Za-z_$]/.test(c)) {
            const w = match(IDENT, code, i);
            let type = "";
            if (kw.has(w)) type = "kw";
            else if (prevWord === "def" || prevWord === "function") type = "fn";
            else if (prevWord === "class" || prevWord === "interface") type = "cls";
            else if (bi.has(w)) type = "bi";
            else {
                let k = i + w.length;
                while (code[k] === " ") k++;
                if (code[k] === "(" && !sh) type = "fn";
                else if (/^[A-Z][A-Za-z0-9]*$/.test(w) && w.length > 1 && !/^[A-Z0-9_]+$/.test(w)) type = "cls";
            }
            push(out, type, w); i += w.length; prevWord = w; continue;
        }
        push(out, /\s/.test(c) ? "" : "op", c); i++;
        if (!/\s/.test(c)) prevWord = "";
    }
}

function scanJson(code, out) {
    let i = 0;
    while (i < code.length) {
        const c = code[i];
        if (c === '"') {
            const j = endQuoted(code, i, '"', false);
            let k = j; while (code[k] === " " || code[k] === "\t") k++;
            push(out, code[k] === ":" ? "key" : "str", code.slice(i, j)); i = j; continue;
        }
        if (c === "/" && code[i + 1] === "/") {
            let j = code.indexOf("\n", i); if (j < 0) j = code.length;
            push(out, "com", code.slice(i, j)); i = j; continue;
        }
        if (/[-\d]/.test(c)) {
            const w = match(/-?\d[\d.eE+-]*/y, code, i);
            if (w) { push(out, "num", w); i += w.length; continue; }
        }
        if (/[a-z]/.test(c)) {
            const w = match(/[a-z]+/y, code, i);
            push(out, JSON_LIT.has(w) ? "kw" : "", w); i += w.length; continue;
        }
        push(out, /[{}[\],:]/.test(c) ? "op" : "", c); i++;
    }
}

/** html: tags, attribute strings, comments */
function scanMarkup(code, out) {
    const re = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+|</g;
    let m;
    while ((m = re.exec(code))) {
        const t = m[0];
        if (t.startsWith("<!--")) push(out, "com", t);
        else if (/^<\/?[A-Za-z]/.test(t)) {
            t.split(/("[^"]*"|'[^']*')/).forEach((p, k) => push(out, k % 2 ? "str" : "tag", p));
        } else push(out, "", t);
    }
}

function scanCss(code, out) {
    const re = /\/\*[\s\S]*?\*\/|"[^"\n]*"|'[^'\n]*'|#[0-9a-fA-F]{3,8}\b|-?\d[\d.]*(?:px|em|rem|%|s|ms|vh|vw|deg)?|[\w-]+(?=\s*:)|[.#@][\w-]+|[\s\S]/g;
    let m;
    while ((m = re.exec(code))) {
        const t = m[0];
        if (t.startsWith("/*")) push(out, "com", t);
        else if (t[0] === '"' || t[0] === "'") push(out, "str", t);
        else if (/^#[0-9a-fA-F]{3,8}$/.test(t) || /^-?\d/.test(t)) push(out, "num", t);
        else if (/^[\w-]+$/.test(t)) push(out, "key", t);
        else if (/^[.#@]/.test(t) && t.length > 1) push(out, "cls", t);
        else push(out, /\s/.test(t) ? "" : "op", t);
    }
}

function scanMarkdown(code, out) {
    let fence = false;
    const lines = code.split("\n");
    lines.forEach((line, idx) => {
        const nl = idx < lines.length - 1 ? "\n" : "";
        if (/^\s*(```|~~~)/.test(line)) { fence = !fence; push(out, "str", line + nl); return; }
        if (fence) { push(out, "str", line + nl); return; }
        if (/^#{1,6}\s/.test(line)) { push(out, "head", line + nl); return; }
        const m = /^(\s*(?:[-*+]|\d+\.)\s)(.*)$/.exec(line);
        if (m) { push(out, "op", m[1]); inlineMd(m[2] + nl, out); return; }
        inlineMd(line + nl, out);
    });
}
function inlineMd(text, out) {
    const re = /`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]*\]\([^)\n]*\)|[^`*[]+|[`*[]/g;
    let m;
    while ((m = re.exec(text))) {
        const t = m[0];
        push(out, t[0] === "`" && t.length > 1 ? "str" : t.startsWith("**") ? "kw" : t[0] === "[" && t.length > 1 ? "fn" : "", t);
    }
}

const FAMILY = { python: "c", javascript: "c", typescript: "c", tsx: "c", jsx: "c", shell: "c",
                 yaml: "c", toml: "c", json: "json", html: "markup", css: "css", markdown: "md" };

/** Flat [type, text] tokens of the whole text. */
export function tokenize(code, language) {
    const out = [];
    const text = String(code == null ? "" : code);
    const lang = String(language || "text").toLowerCase();
    try {
        switch (FAMILY[lang]) {
            case "c": scanC(text, out, ["tsx", "jsx", "typescript"].includes(lang) ? "javascript" : lang); break;
            case "json": scanJson(text, out); break;
            case "markup": scanMarkup(text, out); break;
            case "css": scanCss(text, out); break;
            case "md": scanMarkdown(text, out); break;
            default: push(out, "", text);
        }
    } catch (e) {
        return [["", text]];
    }
    return out;
}

/** Tokens split into lines. */
export function highlight(code, language) {
    const lines = [[]];
    for (const [type, text] of tokenize(code, language)) {
        text.split("\n").forEach((part, k) => {
            if (k > 0) lines.push([]);
            if (part) lines[lines.length - 1].push([type, part]);
        });
    }
    return lines;
}

/** Best guess for untagged code. */
export function guessLanguage(code) {
    const t = String(code || "").trim();
    if (/^[{[][\s\S]*[}\]]$/.test(t) && /"\s*:/.test(t)) return "json";
    if (/^(def |class |import |from \w+ import |@\w+|if __name__|async def )/m.test(t) || /^\s*print\(/m.test(t)) return "python";
    if (/^(#!\/bin\/(ba)?sh|\$ |npm |pip |git |cd )/m.test(t)) return "shell";
    if (/\b(const|let|function|=>)\b/.test(t)) return "javascript";
    return "text";
}
