"""The Comp space's tool library: groups kept as *.comp.json tools per OS user (src/comp_tools.py).

    python -m unittest discover -s tests -p test_comp_tools.py
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
import comp_tools  # noqa: E402

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError:  # pragma: no cover
    web = None

FORMAT = {"width": 64, "height": 32, "fps": 24, "frames": 10}


def tool(name="Soft glow", **meta):
    group = {"id": "Group1", "type": "group", "x": 120, "y": 300, "inputs": ["Read1"], "nodes": [
        {"id": "Input1", "type": "group_input", "index": 0, "inputs": []},
        {"id": "Blur1", "type": "blur", "size": 4, "inputs": ["Input1"], "expr": {"size": "frame * 2"}},
        {"id": "GroupOutput1", "type": "group_output", "inputs": ["Blur1"]}]}
    return {"comp": 1, "format": FORMAT, "nodes": [group], "output": None, "tool": dict({"name": name}, **meta)}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_a_tool_is_kept_listed_read_and_deleted(self):
        s = comp_tools.save_tool(tool(note="for faces"), self.dir)
        self.assertEqual((s["name"], s["note"], s["inputs"], s["nodes"]), ("Soft glow", "for faces", 1, 3))
        self.assertEqual(os.listdir(self.dir), ["soft glow.comp.json"])
        got = comp_tools.get_tool("SOFT GLOW", self.dir)
        g = got["nodes"][0]
        self.assertEqual((g["x"], g["y"], g["inputs"], g["name"]), (0, 0, [None], "Soft glow"))   # nothing of the comp it came from
        self.assertEqual(g["nodes"][1]["expr"], {"size": "frame * 2"})
        # The same name in another case writes over it; another name is a second tool, listed by name.
        comp_tools.save_tool(tool("soft Glow"), self.dir)
        comp_tools.save_tool(tool("Edge"), self.dir)
        self.assertEqual([t["name"] for t in comp_tools.list_tools(self.dir)], ["Edge", "soft Glow"])
        self.assertTrue(comp_tools.delete_tool("edge", self.dir))
        self.assertFalse(comp_tools.delete_tool("edge", self.dir))
        with self.assertRaises(FileNotFoundError):
            comp_tools.get_tool("edge", self.dir)

    def test_names_cannot_leave_the_folder_and_what_is_no_tool_is_refused(self):
        for evil in ["../../etc/passwd", "..\\..\\win.ini", "a/b", "\x00x", "  ", "...."]:
            name = comp_tools.file_name(evil)
            self.assertNotIn("/", name)
            self.assertNotIn("\\", name)
            self.assertFalse(name.startswith("."))
            self.assertTrue(name.endswith(".comp.json"))
        self.assertEqual(comp_tools.file_name("CON"), "_con.comp.json")
        two = tool()
        two["nodes"].append(dict(two["nodes"][0], id="Group2"))
        for bad in [None, "x", {"nodes": []}, tool(""), dict(tool(), nodes=[{"id": "B", "type": "blur", "inputs": []}]), two]:
            with self.assertRaises(ValueError):
                comp_tools.save_tool(bad, self.dir)
        self.assertEqual(os.listdir(self.dir), [])
        # A file in the folder that is no tool is left out of the list.
        with open(os.path.join(self.dir, "junk.comp.json"), "w") as fh:
            fh.write("{not json")
        self.assertEqual(comp_tools.list_tools(self.dir), [])


@unittest.skipIf(web is None, "aiohttp is not installed")
class RouteTests(unittest.TestCase):
    def test_the_route_lists_saves_gets_deletes_and_refuses_other_sites(self):
        folder = tempfile.mkdtemp()
        os.environ["IMAGE_VIEWER_COMP_TOOLS"] = folder

        class Access:
            @staticmethod
            def same_origin(request):
                if (request.headers.get("Content-Type") or "").split(";")[0] != "application/json":
                    return False, "Refused: the request must be sent as application/json."
                return True, ""

        async def run():
            app = web.Application()
            comp_tools.register(lambda m, p, h: app.router.add_route(m, p, h), web=web, path_access=Access)
            async with TestClient(TestServer(app)) as c:
                post = lambda body: c.post("/imageviewer/comp_tools", json=body)
                r = await post({"op": "list"})
                self.assertEqual((await r.json())["tools"], [])
                r = await post({"op": "save", "tool": tool()})
                self.assertEqual(r.status, 200)
                self.assertEqual((await r.json())["tool"]["name"], "Soft glow")
                r = await post({"op": "get", "name": "Soft glow"})
                self.assertEqual((await r.json())["tool"]["nodes"][0]["type"], "group")
                r = await post({"op": "get", "name": "nothing"})
                self.assertEqual(r.status, 404)
                r = await post({"op": "save", "tool": {"tool": {"name": "x"}, "nodes": []}})
                self.assertEqual(r.status, 400)
                r = await post({"op": "nonsense"})
                self.assertEqual(r.status, 400)
                r = await c.post("/api/imageviewer/comp_tools", data=json.dumps({"op": "list"}), headers={"Content-Type": "text/plain"})
                self.assertEqual(r.status, 403)
                r = await post({"op": "delete", "name": "Soft glow"})
                self.assertTrue((await r.json())["ok"])
                self.assertEqual(os.listdir(folder), [])

        try:
            asyncio.run(run())
        finally:
            os.environ.pop("IMAGE_VIEWER_COMP_TOOLS", None)


if __name__ == "__main__":
    unittest.main()
