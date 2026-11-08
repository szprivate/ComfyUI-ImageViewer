"""The viewer's dependency reader (src/deps_graph.py) against agentY-core's (agenty_core.utils.dependencies),
on the same files: the same graph, and the same records written beside them. Skipped where agentY-core is not
importable (ComfyUI's interpreter); run it with agentY's: python -m unittest tests.test_deps_parity"""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import deps_fixture as fx  # noqa: E402
from test_deps_graph import dg, pw  # noqa: E402

try:
    from agenty_core.utils import dependencies as core
    from agenty_core.utils import provenance as core_pv
except Exception:  # noqa: BLE001
    core = None


def _steps(mod, files, rts, send):
    """The same visits on either side; every answer, in order."""
    out = [mod.graph(files["render"]), mod.graph(files["plate"]), mod.graph(files["depth"], up=1, down=1)]
    if send is not None:
        out.append(mod.graph(files["render"]))
    out.append(mod.reindex(rts["output"]))
    fx.write_png(files["plate"], shade=99)       # re-graded plate: what was made from it is out of date
    mod._fp_cache.clear()
    out.append(mod.graph(files["plate"]))
    return out


@unittest.skipIf(core is None, "needs agenty_core (agentY's interpreter)")
class DepsParityTests(unittest.TestCase):
    def side(self, mod, write_send):
        root = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        rts, files = fx.build(root)
        mod.set_roots(rts)
        self.addCleanup(mod.set_roots, None)
        mod._unknown.clear()
        mod._fp_cache.clear()
        send = os.path.join(rts["output"], "send_00001_.png")
        fx.write_png(send, shade=40)
        write_send(send)
        answers = _steps(mod, files, rts, send)
        return [fx.tidy(a, root) if isinstance(a, dict) else a for a in answers], fx.records(root)

    def test_same_graph_and_same_records(self):
        mine = self.side(dg, lambda p: pw.annotate([p], "3", fx.SEND_GRAPH, {"workflow": None}))
        theirs = self.side(core, lambda p: core_pv.write(p, fx.SEND_GRAPH, output_node="3"))
        self.assertEqual(json.dumps(mine[0], indent=1, sort_keys=True), json.dumps(theirs[0], indent=1, sort_keys=True))
        self.assertEqual(json.dumps(mine[1], indent=1, sort_keys=True), json.dumps(theirs[1], indent=1, sort_keys=True))
        self.assertGreater(len(mine[1]), 3, "records were written")


if __name__ == "__main__":
    unittest.main()
