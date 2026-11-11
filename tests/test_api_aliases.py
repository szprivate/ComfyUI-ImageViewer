"""Every viewer route the page calls through ComfyUI's ``api.fetchApi`` must also be served under /api.

``fetchApi`` puts ``/api`` in front of the path, so the browser asks for ``/api/imageviewer/<x>``; a route
registered only as ``/imageviewer/<x>`` answers aiohttp's bare 404 (the Dependencies tab did, for every file).
The harness stubs ``fetchApi`` without the prefix, so the browser tests cannot see this: it is checked here,
on the sources.
"""
import glob
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class ApiAliasTest(unittest.TestCase):
    def test_every_fetchapi_route_has_an_api_twin(self):
        served = set()
        for py in glob.glob(os.path.join(ROOT, "src", "*.py")):
            served.update(re.findall(r'"(/api/imageviewer/[^"?]+)"', _read(py)))
        # paint_routes adds "/api/imageviewer/paint/" + name for each of its routes
        paint = _read(os.path.join(ROOT, "src", "paint_routes.py"))
        self.assertIn('"/api/imageviewer/paint/" + name', paint)
        # comp_routes adds every route under both prefixes, in one loop
        comp = _read(os.path.join(ROOT, "src", "comp_routes.py"))
        self.assertIn('for prefix in ("/imageviewer", "/api/imageviewer"):', comp)
        served.update("/api/imageviewer/" + n for n in re.findall(r'f"\{prefix\}/([^"?]+)"', comp))
        # clip_vfx_routes adds each (method, path, handler) under both prefixes, by concatenation
        vfx = _read(os.path.join(ROOT, "src", "clip_vfx_routes.py"))
        self.assertIn('add(method, "/api/imageviewer/" + path, h)', vfx)
        served.update("/api/imageviewer/" + n for n in re.findall(r'\("(?:GET|POST)", "([^"]+)", h_', vfx))
        missing = []
        for js in glob.glob(os.path.join(ROOT, "js", "*.js")):
            for m in re.finditer(r'fetchApi\(\s*[`"\'](/imageviewer/[^`"\'?$]+)', _read(js)):
                path = m.group(1)
                if path.startswith("/imageviewer/paint/"):
                    continue
                if "/api" + path not in served:
                    missing.append(f"{path} ({os.path.basename(js)})")
        self.assertEqual(missing, [], "routes the page calls with fetchApi but not served under /api")


if __name__ == "__main__":
    unittest.main()
