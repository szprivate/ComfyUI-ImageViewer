"""The Dependencies tab's data: what a file was made from, and what was made from it.

Every output agentY makes records the files its graph loaded, and every input lists
what was made from it (agentY-core's ``agenty_core.utils.dependencies``). The viewer
has no agenty_core, so this is a thin relay, like atlas_render.py: it asks the agentY
host's ``/agentY/deps`` and hands the graph back, with each node marked ``viewable``
when the viewer may show that file (the same folders as /imageviewer/view_file).

No aiohttp or ComfyUI in here, so it can be tested on its own.
"""
from __future__ import annotations

import urllib.parse
import urllib.request

try:
    from . import atlas_render as _relay
except ImportError:  # loaded on its own (tests)
    import atlas_render as _relay  # type: ignore[no-redef]

RelayError = _relay.RelayError
ROUTE = "deps"
_MAX_DEPTH = 12


def _int(v, default: int, hi: int) -> int:
    try:
        return max(0, min(int(v), hi))
    except (TypeError, ValueError):
        return default


def fetch_graph(comfy_base: str, path: str, up=4, down=4, scan: bool = False, may_serve=None,
                timeout: float = 30.0) -> dict:
    """``{"root", "nodes", "edges", "truncated"}`` around *path*, from the agentY host.

    *may_serve*: a predicate on a path; nodes it rejects get ``viewable: false`` and no
    thumbnail is asked for them."""
    if not path:
        raise RelayError("send ?path=<file>", 400)
    base, token = _relay.host_endpoint(comfy_base)
    q = {"path": path, "up": _int(up, 4, _MAX_DEPTH), "down": _int(down, 4, _MAX_DEPTH)}
    if scan:
        q["scan"] = "1"
    url = base + f"/agentY/{ROUTE}?" + urllib.parse.urlencode(q)
    headers = {_relay.TOKEN_HEADER: token} if token else {}
    try:
        status, out = _relay._open(urllib.request.Request(url, headers=headers, method="GET"), timeout)  # noqa: SLF001
    except Exception:  # noqa: BLE001
        raise RelayError("the agentY host is not running (start it, then open the tab again)", 503)
    if status == 403:
        raise RelayError("the agentY host refused the viewer (its session token changed: reload the ComfyUI "
                         "page and try again)", 403)
    if status >= 400 or not isinstance(out, dict):
        msg = (out or {}).get("error") if isinstance(out, dict) else ""
        if status == 404 and not msg:
            msg = "the agentY host is too old for the Dependencies tab (update agentY and restart it)"
        raise RelayError(str(msg or f"the agentY host answered {status}"), status if status < 500 else 502)
    nodes = []
    for n in out.get("nodes") or []:
        if not isinstance(n, dict) or not n.get("id"):
            continue
        ok = bool(n.get("exists")) and (may_serve(n["id"]) if may_serve else True)
        nodes.append({**n, "viewable": ok})
    return {"root": out.get("root", ""), "nodes": nodes,
            "edges": [e for e in out.get("edges") or [] if isinstance(e, dict)],
            "truncated": bool(out.get("truncated"))}
