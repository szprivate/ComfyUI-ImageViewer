"""viewer_code: the Agent code panel's store. Run: python -m unittest tests.test_viewer_code"""
import importlib.util
import os
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "viewer_code", os.path.join(os.path.dirname(__file__), "..", "viewer_code.py"))
vc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vc)


class StoreTests(unittest.TestCase):
    def test_newest_first_and_dedupe(self):
        s = vc.CodeStore()
        a, new_a = s.add({"code": "print(1)", "language": "py", "title": "a", "ts": 1})
        b, new_b = s.add({"code": "print(2)", "language": "python", "ts": 2})
        again, new_again = s.add({"code": "print(1)", "language": "python"})
        self.assertTrue(new_a and new_b)
        self.assertFalse(new_again)
        self.assertEqual(again["id"], a["id"])
        self.assertEqual([x["code"] for x in s.recent()], ["print(2)", "print(1)"])
        self.assertEqual(a["language"], "python")

    def test_rejects_empty_and_bad(self):
        s = vc.CodeStore()
        self.assertEqual(s.add({"code": "  \n"}), (None, False))
        self.assertEqual(s.add({"code": 5}), (None, False))
        self.assertEqual(s.add("x"), (None, False))

    def test_sessions_are_separate_and_cap(self):
        s = vc.CodeStore(cap=3)
        for i in range(5):
            s.add({"code": f"x={i}", "language": "python"})
        s.add({"code": "x=0", "language": "python", "session": "other"})
        self.assertEqual(len(s.recent()), 3)
        self.assertEqual(s.recent()[0]["code"], "x=4")
        self.assertEqual(len(s.recent("other")), 1)

    def test_long_code_is_cut_with_a_note(self):
        s = vc.CodeStore()
        snip, _ = s.add({"code": "a" * (vc.MAX_CODE_BYTES + 10)})
        self.assertEqual(len(snip["code"]), vc.MAX_CODE_BYTES)
        self.assertTrue(snip["note"])

    def test_language_from_title_when_missing(self):
        s = vc.CodeStore()
        snip, _ = s.add({"code": "{}", "title": "settings.json"})
        self.assertEqual(snip["language"], "json")

    def test_language_of(self):
        self.assertEqual(vc.language_of("PY"), "python")
        self.assertEqual(vc.language_of("a/b.tsx"), "tsx")
        self.assertEqual(vc.language_of("bash"), "shell")
        self.assertEqual(vc.language_of("weird"), "text")

    def test_read_text_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.py")
            with open(p, "w", encoding="utf-8") as f:
                f.write("x = 'é'\n")
            text, lang, cut = vc.read_text_file(p)
            self.assertEqual((text, lang, cut), ("x = 'é'\n", "python", False))
            b = os.path.join(d, "b.txt")
            with open(b, "wb") as f:
                f.write(b"ab\0cd")
            with self.assertRaises(ValueError):
                vc.read_text_file(b)


if __name__ == "__main__":
    unittest.main()
