"""src/open_files.py: the soft open-file limit is raised, never above the hard one."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("open_files", os.path.join(HERE, "..", "src", "open_files.py"))
of = importlib.util.module_from_spec(spec)
spec.loader.exec_module(of)

try:
    import resource
except ImportError:
    resource = None


@unittest.skipIf(resource is None or os.name == "nt", "no RLIMIT_NOFILE here")
class OpenFiles(unittest.TestCase):
    def setUp(self):
        self.old = resource.getrlimit(resource.RLIMIT_NOFILE)

    def tearDown(self):
        resource.setrlimit(resource.RLIMIT_NOFILE, self.old)

    def test_a_low_soft_limit_is_raised(self):
        soft, hard = self.old
        if hard != resource.RLIM_INFINITY and hard < 300:
            self.skipTest("hard limit too low to test")
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, hard))
        got = of.raise_limit(1024)
        self.assertEqual(got, (256, 1024))
        self.assertEqual(resource.getrlimit(resource.RLIMIT_NOFILE), (1024, hard))

    def test_never_above_the_hard_limit_and_not_when_high_enough(self):
        # A stand-in resource module: a hard limit lowered for real cannot be raised again.
        import sys
        import types
        state = {"lim": (256, 600)}
        fake = types.SimpleNamespace(RLIMIT_NOFILE=7, RLIM_INFINITY=-1,
                                     getrlimit=lambda k: state["lim"],
                                     setrlimit=lambda k, v: state.__setitem__("lim", v))
        real = sys.modules.get("resource")
        sys.modules["resource"] = fake
        try:
            self.assertEqual(of.raise_limit(8192), (256, 600))
            self.assertEqual(state["lim"], (600, 600))
            self.assertIsNone(of.raise_limit(512))
        finally:
            sys.modules["resource"] = real

    def test_it_can_be_switched_off(self):
        os.environ["IMAGE_VIEWER_KEEP_FILE_LIMIT"] = "1"
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (256, self.old[1]))
            self.assertIsNone(of.raise_limit())
        finally:
            del os.environ["IMAGE_VIEWER_KEEP_FILE_LIMIT"]


if __name__ == "__main__":
    unittest.main()
