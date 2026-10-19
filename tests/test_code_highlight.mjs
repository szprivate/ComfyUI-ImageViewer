// node --test tests/test_code_highlight.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { highlight, tokenize, guessLanguage } from "../js/bEpicViewer_codeHighlight.js";

const join = (lines) => lines.map((l) => l.map((t) => t[1]).join("")).join("\n");
const types = (code, lang) => Object.fromEntries(tokenize(code, lang).map(([t, s]) => [s, t]));

test("tokens always join back to the input", () => {
    const samples = {
        python: 'import os\n@dec\ndef f(x, y=1):\n    """doc\n    more"""\n    return f"a{x}" + \'b\'  # c\n',
        javascript: 'const a = `x\ny`; /* c\n d */ function g() { return 1.5e3 } // end',
        json: '{"a": [1, 2.5, true, null], "b": "x\\"y"}',
        shell: 'echo "$HOME" --flag ${X} # note\nif [ -f a ]; then ls; fi',
        markdown: "# T\n- item `code`\n```py\nx=1\n```\ntext **b** [l](u)",
        html: '<div class="a">x</div><!-- c -->',
        css: "a.b { color: #fff; margin: 0 4px } /* c */",
        text: "plain\ntext",
    };
    for (const [lang, code] of Object.entries(samples)) assert.equal(join(highlight(code, lang)), code, lang);
});

test("python classes", () => {
    const t = types("def run(n):\n    return len(n) + 1  # done", "python");
    assert.equal(t["def"], "kw"); assert.equal(t["run"], "fn"); assert.equal(t["len"], "bi");
    assert.equal(t["1"], "num"); assert.equal(t["# done"], "com");
});

test("python triple strings, f-strings and decorators", () => {
    const t = types('@app.route\nx = f"hi {a}"\ny = """a\nb"""', "python");
    assert.equal(t["@app.route"], "dec");
    assert.equal(t['f"hi {a}"'], "str");
    assert.equal(t['"""a\nb"""'], "str");
});

test("a '#' inside a string is not a comment", () => {
    const toks = tokenize('s = "a # b"  # real', "python");
    assert.deepEqual(toks.filter(([t]) => t === "com").map(([, s]) => s), ["# real"]);
});

test("json keys vs values", () => {
    const t = types('{"k": "v", "n": 3, "b": true}', "json");
    assert.equal(t['"k"'], "key"); assert.equal(t['"v"'], "str");
    assert.equal(t["3"], "num"); assert.equal(t["true"], "kw");
});

test("lines split on newlines inside tokens", () => {
    const l = highlight('"""a\nb"""\nx', "python");
    assert.equal(l.length, 3); assert.equal(l[1][0][0], "str");
});

test("never throws on odd input", () => {
    for (const lang of ["python", "json", "html", "css", "markdown", "shell", "nope"]) {
        assert.doesNotThrow(() => highlight("\"unterminated\n'x ` /* <a ```", lang));
    }
    assert.deepEqual(highlight("", "python"), [[]]);
});

test("guessLanguage", () => {
    assert.equal(guessLanguage("def a():\n  pass"), "python");
    assert.equal(guessLanguage('{"a": 1}'), "json");
    assert.equal(guessLanguage("const a = 1"), "javascript");
});
