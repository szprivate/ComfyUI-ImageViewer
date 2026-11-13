"""Comp: expressions on a node's numbers - the page's js/imageViewer_compExpr.js in Python.

The two must agree number for number (tests/test_comp_parity.py renders comps with expressions in both). The
language is small and safe: numbers, the operators, a fixed set of names and functions, and other nodes'
numbers (``Blur1.size``, ``Transform1.translate.x``, ``'Erode/Dilate1'.size``). Nothing else is reachable.
JavaScript's arithmetic is kept: a division by 0 is an infinity (or NaN), a domain error NaN, ``round`` is
``floor(x + 0.5)``, ``%`` takes the dividend's sign. Imports only the standard library."""
import math
import re

EXPR_NAMES = ["frame", "time", "fps", "width", "height", "value", "pi", "e"]
COMPONENTS = {"x": 0, "y": 1, "z": 2, "w": 3, "r": 0, "g": 1, "b": 2, "a": 3, "0": 0, "1": 1, "2": 2, "3": 3}
NAN = float("nan")
INF = float("inf")


def _truthy(v):
    return v != 0 and v == v


def hash32(n):
    """A whole number's hash, 0 <= h < 2^32 (the page's ``hash32``)."""
    M = 0xFFFFFFFF
    x = int(n) % 4294967296
    x ^= x >> 16
    x = (x * 0x7FEB352D) & M
    x ^= x >> 15
    x = (x * 0x846CA68B) & M
    x ^= x >> 16
    return x


def _hash01(n):
    return hash32(n) / 4294967296


def _floor(x):
    if x != x or x in (INF, -INF):
        return x
    return float(math.floor(x))


def _noise1(x, seed=0.0):
    if x != x or x in (INF, -INF) or seed != seed or seed in (INF, -INF):
        return NAN
    i = _floor(x)
    f = x - i
    s = _floor(seed) * 7919
    a = _hash01(i + s) * 2 - 1
    b = _hash01(i + 1 + s) * 2 - 1
    u = f * f * (3 - 2 * f)
    return a + (b - a) * u


def _safe(fn):
    def call(*a):
        try:
            return float(fn(*a))
        except (ValueError, ZeroDivisionError):
            return NAN
        except OverflowError:
            return INF
    return call


def _log(x):
    if x != x or x < 0:
        return NAN
    return -INF if x == 0 else (INF if x == INF else math.log(x))


def _log10(x):
    if x != x or x < 0:
        return NAN
    return -INF if x == 0 else (INF if x == INF else math.log10(x))


def _sqrt(x):
    if x != x or x < 0:
        return NAN
    return INF if x == INF else math.sqrt(x)


def _exp(x):
    if x != x:
        return NAN
    if x == -INF:
        return 0.0
    try:
        return math.exp(x)
    except OverflowError:
        return INF


def _pow(a, b):
    """JavaScript's Math.pow."""
    if b != b:
        return NAN
    if b == 0:
        return 1.0
    if a != a:
        return NAN
    if abs(a) == 1 and b in (INF, -INF):
        return NAN
    try:
        r = math.pow(a, b)
    except ZeroDivisionError:   # 0 ** negative
        neg_odd = a == 0 and math.copysign(1, a) < 0 and float(b).is_integer() and int(b) % 2 == 1
        return -INF if neg_odd else INF
    except ValueError:          # negative ** fraction
        return NAN
    except OverflowError:
        neg = a < 0 and float(b).is_integer() and int(b) % 2 == 1
        return -INF if neg else INF
    return r


def _trig(fn, lo=None):
    def call(x):
        if x != x or x in (INF, -INF):
            return NAN
        if lo is not None and (x < -1 or x > 1):
            return NAN
        return fn(x)
    return call


def _atan(x):
    return NAN if x != x else math.atan(x)


def _atan2(y, x):
    return NAN if x != x or y != y else math.atan2(y, x)


def _ceil(x):
    if x != x or x in (INF, -INF):
        return x
    return float(math.ceil(x))


def _sign(x):
    return 1.0 if x > 0 else -1.0 if x < 0 else x


def _minmax(lt):
    def call(*a):
        m = a[0]
        for v in a[1:]:
            if (v < m if lt else v > m) or v != v:
                m = v
        return m
    return call


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def _smoothstep(e0, e1, x):
    t = _div(x - e0, e1 - e0)
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return t * t * (3 - 2 * t)


def _mod(a, b):
    return a - b * _floor(_div(a, b))


FNS = {
    "sin": (1, _trig(math.sin)), "cos": (1, _trig(math.cos)), "tan": (1, _trig(math.tan)),
    "asin": (1, _trig(math.asin, -1)), "acos": (1, _trig(math.acos, -1)), "atan": (1, _atan),
    "atan2": (2, _atan2), "sqrt": (1, _sqrt), "abs": (1, abs), "exp": (1, _exp), "log": (1, _log), "log10": (1, _log10),
    "pow": (2, _pow), "floor": (1, _floor), "ceil": (1, _ceil), "round": (1, lambda x: _floor(x + 0.5)),
    "fract": (1, lambda x: x - _floor(x)), "sign": (1, _sign),
    "min": (-1, _minmax(True)), "max": (-1, _minmax(False)),
    "clamp": (3, _clamp), "lerp": (3, lambda a, b, t: a + (b - a) * t), "mix": (3, lambda a, b, t: a + (b - a) * t),
    "smoothstep": (3, _smoothstep), "step": (2, lambda edge, x: 0.0 if x < edge else 1.0), "mod": (2, _mod),
    "degrees": (1, lambda r: r * 180 / math.pi), "radians": (1, lambda d: d * math.pi / 180),
    "if": (3, lambda c, a, b: a if _truthy(c) else b),
    "random": (1, lambda s: NAN if s != s or s in (INF, -INF) else _hash01(_floor(s))),
    "noise": (-1, _noise1),
}
EXPR_FUNCTIONS = list(FNS)


def _div(a, b):
    if b == 0:
        if a != a or a == 0:
            return NAN
        neg = (a < 0) != (math.copysign(1, b) < 0)
        return -INF if neg else INF
    try:
        return a / b
    except OverflowError:
        return INF


def _rem(a, b):
    if b == 0 or a != a or b != b or a in (INF, -INF):
        return NAN
    if b in (INF, -INF):
        return a
    return math.fmod(a, b)


def _num(a, op, b):
    try:
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
    except OverflowError:
        return INF
    return NAN


_BIN = {
    "+": lambda a, b: _num(a, "+", b), "-": lambda a, b: _num(a, "-", b), "*": lambda a, b: _num(a, "*", b),
    "/": _div, "%": _rem, "^": _pow,
    "<": lambda a, b: 1.0 if a < b else 0.0, "<=": lambda a, b: 1.0 if a <= b else 0.0,
    ">": lambda a, b: 1.0 if a > b else 0.0, ">=": lambda a, b: 1.0 if a >= b else 0.0,
    "==": lambda a, b: 1.0 if a == b else 0.0, "!=": lambda a, b: 1.0 if a != b else 0.0,
    "&&": lambda a, b: 1.0 if _truthy(a) and _truthy(b) else 0.0, "||": lambda a, b: 1.0 if _truthy(a) or _truthy(b) else 0.0,
}

_NUM = re.compile(r"(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_ID = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class ExprError(ValueError):
    pass


def _tokens(src):
    out, i, s = [], 0, str(src)
    while i < len(s):
        c = s[i]
        if c in " \t\n\r":
            i += 1
            continue
        after_name = bool(out) and out[-1][0] in ("i", "s")
        m = None if after_name and c == "." else _NUM.match(s, i)
        if m:
            out.append(("n", float(m.group(0))))
            i = m.end()
            continue
        m = _ID.match(s, i)
        if m:
            out.append(("i", m.group(0)))
            i = m.end()
            continue
        if c in "'\"":
            j = s.find(c, i + 1)
            if j < 0:
                raise ExprError("a name in quotes is not closed")
            out.append(("s", s[i + 1:j]))
            i = j + 1
            continue
        two = s[i:i + 2]
        if two in ("<=", ">=", "==", "!=", "&&", "||"):
            out.append(("o", two))
            i += 2
            continue
        if c in "+-*/%^<>!?:(),.":
            out.append(("o", c))
            i += 1
            continue
        raise ExprError(f'"{c}" is not part of an expression')
    return out


def parse_expr(src):
    """The expression as a tree (tuples); raises ExprError saying what is wrong."""
    tk = _tokens(src)
    pos = [0]

    def peek():
        return tk[pos[0]] if pos[0] < len(tk) else None

    def is_op(v):
        t = peek()
        return t is not None and t[0] == "o" and t[1] == v

    def want(v):
        if not is_op(v):
            raise ExprError(f'"{v}" expected')
        pos[0] += 1

    def ternary():
        c = or_()
        if is_op("?"):
            pos[0] += 1
            a = ternary()
            want(":")
            b = ternary()
            return ("t", c, a, b)
        return c

    def left(nxt, ops):
        def f():
            a = nxt()
            while peek() is not None and peek()[0] == "o" and peek()[1] in ops:
                op = peek()[1]
                pos[0] += 1
                a = ("b", op, a, nxt())
            return a
        return f

    def unary():
        if is_op("-") or is_op("+") or is_op("!"):
            op = peek()[1]
            pos[0] += 1
            return ("u", op, unary())
        return power()

    def power():
        a = postfix()
        if is_op("^"):
            pos[0] += 1
            return ("b", "^", a, unary())
        return a

    def members():
        m = []
        while is_op("."):
            pos[0] += 1
            t = peek()
            if t is None or t[0] not in ("i", "n"):
                raise ExprError('a name expected after "."')
            m.append(_js_num(t[1]) if t[0] == "n" else t[1])
            pos[0] += 1
        return m

    def ref(node_id):
        m = members()
        if not m:
            raise ExprError(f'"{node_id}" alone: name one of its numbers')
        if len(m) > 2:
            raise ExprError("a node, a number and at most a component")
        if len(m) == 2 and m[1] not in COMPONENTS:
            raise ExprError(f'"{m[1]}" is no component')
        return ("r", node_id, m[0], COMPONENTS[m[1]] if len(m) == 2 else None)

    def postfix():
        t = peek()
        if t is None:
            raise ExprError("the expression ends too soon")
        if t[0] == "n":
            pos[0] += 1
            return ("n", t[1])
        if t[0] == "s":
            pos[0] += 1
            return ref(t[1])
        if t[0] == "i":
            pos[0] += 1
            if is_op("("):
                pos[0] += 1
                args = []
                if not is_op(")"):
                    args.append(ternary())
                    while is_op(","):
                        pos[0] += 1
                        args.append(ternary())
                want(")")
                f = FNS.get(t[1])
                if not f:
                    raise ExprError(f'no function "{t[1]}"')
                if (len(args) != f[0]) if f[0] >= 0 else len(args) < 1:
                    raise ExprError(f"{t[1]} takes another number of numbers")
                if t[1] == "noise" and len(args) > 2:
                    raise ExprError("noise takes one or two numbers")
                return ("f", t[1], args)
            if is_op("."):
                return ref(t[1])
            if t[1] not in EXPR_NAMES:
                raise ExprError(f'no name "{t[1]}"')
            return ("v", t[1])
        if is_op("("):
            pos[0] += 1
            a = ternary()
            want(")")
            return a
        raise ExprError(f'"{t[1]}" in the wrong place')

    or_ = None
    mul = left(unary, ("*", "/", "%"))
    add = left(mul, ("+", "-"))
    cmp = left(add, ("<", "<=", ">", ">=", "==", "!="))
    and_ = left(cmp, ("&&",))
    or_ = left(and_, ("||",))
    if not tk:
        raise ExprError("empty")
    tree = ternary()
    if pos[0] < len(tk):
        raise ExprError(f'"{tk[pos[0]][1]}" in the wrong place')
    return tree


def _js_num(v):
    """A number token as JavaScript's String() spells it (a member like ``.0``)."""
    return str(int(v)) if float(v).is_integer() else repr(v)


_PARSED = {}


def _tree(src):
    src = str(src or "")
    if src in _PARSED:
        return _PARSED[src]
    try:
        t = parse_expr(src)
    except ExprError as e:
        t = ("err", str(e))
    except RecursionError:
        t = ("err", "too deep")
    if len(_PARSED) > 500:
        _PARSED.clear()
    _PARSED[src] = t
    return t


def check_expr(src):
    """What is wrong with an expression, or None."""
    t = _tree(src)
    return t[1] if t[0] == "err" else None


def expr_refs(src):
    """The node ids an expression reads."""
    out = []

    def walk(n):
        if n[0] == "r":
            if n[1] not in out:
                out.append(n[1])
        elif n[0] == "u":
            walk(n[2])
        elif n[0] == "b":
            walk(n[2])
            walk(n[3])
        elif n[0] == "t":
            walk(n[1])
            walk(n[2])
            walk(n[3])
        elif n[0] == "f":
            for a in n[2]:
                walk(a)
    t = _tree(src)
    if t[0] != "err":
        walk(t)
    return out


def eval_expr(src, variables, ref=None):
    """The expression's number; NaN when it is wrong or makes none. ``ref(node_id, param, comp)`` gives another
    node's number (NaN when there is none)."""
    t = _tree(src)
    if t[0] == "err":
        return NAN

    def ev(n):
        k = n[0]
        if k == "n":
            return n[1]
        if k == "v":
            if n[1] == "pi":
                return math.pi
            if n[1] == "e":
                return math.e
            v = variables.get(n[1])
            return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else NAN
        if k == "u":
            a = ev(n[2])
            return -a if n[1] == "-" else (0.0 if _truthy(a) else 1.0) if n[1] == "!" else a
        if k == "b":
            return _BIN[n[1]](ev(n[2]), ev(n[3]))
        if k == "t":
            return ev(n[2]) if _truthy(ev(n[1])) else ev(n[3])
        if k == "f":
            return FNS[n[1]][1](*[ev(a) for a in n[2]])
        if k == "r":
            if ref is None:
                return NAN
            v = ref(n[1], n[2], n[3])
            return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else NAN
        return NAN
    try:
        return float(ev(t))
    except (TypeError, ValueError, ZeroDivisionError, OverflowError, RecursionError):
        return NAN
