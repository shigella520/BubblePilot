"""Offline contract tests; only synthetic queries and credentials."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock

network = types.ModuleType("searx.network")
network.raise_for_httperror = lambda response: response.raise_for_status()
sys.modules["searx"] = types.ModuleType("searx")
sys.modules["searx.network"] = network
spec = importlib.util.spec_from_file_location(
    "engine", Path(__file__).with_name("bubblepilot_deepseek.py"))
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class DeepSeekTests(unittest.TestCase):
    def setUp(self):
        engine._api_key = "synthetic-key"
        engine.result_count = 10

    def test_query_roundtrip(self):
        for query in ['普通查询', '"精确短语" site:example.com', 'C:\\sample',
                      'first\nsecond\tthird', '😀 菜单', 'a' * 128]:
            with self.subTest(query=query):
                result = engine.request(query, {"headers": {}})
                self.assertEqual(json.loads(result["data"]), {
                    "query": query, "count": 10, "need_content": False})
                self.assertEqual(result["method"], "POST")
                self.assertEqual(result["url"], "https://api.deepseek.com/v1/tools/search")
                self.assertEqual(result["headers"]["Authorization"], "Bearer synthetic-key")

    def test_invalid_query(self):
        for query in ['', '  ', 'a' * 129, None]:
            with self.assertRaises(ValueError):
                engine.request(query, {"headers": {}})

    def test_secret_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "key"
            engine.api_key_file = str(path)
            with self.assertRaisesRegex(ValueError, "unavailable"):
                engine.init({})
            path.write_text(" synthetic-key\n", encoding="utf-8")
            engine.init({})
            self.assertEqual(engine._api_key, "synthetic-key")
            path.write_text("", encoding="utf-8")
            with self.assertRaises(ValueError):
                engine.init({})

    def test_results_and_fallback(self):
        response = Mock()
        response.json.return_value = {"results": [
            {"url": "https://example.com/1", "title": "One", "summary": "Summary", "snippet": "Snippet"},
            {"url": "https://example.com/2", "title": "Two", "summary": None, "snippet": "Fallback"},
            {"url": "javascript:alert(1)", "title": "Invalid"},
            {"url": "https://example.com/3", "title": None}, None,
        ]}
        self.assertEqual([r["content"] for r in engine.response(response)], ["Summary", "Fallback"])
        response.json.return_value = {"results": []}
        self.assertEqual(engine.response(response), [])

    def test_errors_are_not_empty_success(self):
        response = Mock()
        for payload in [{}, {"results": None}, []]:
            response.json.return_value = payload
            with self.assertRaises(ValueError):
                engine.response(response)
        response.json.side_effect = ValueError("synthetic invalid payload")
        with self.assertRaisesRegex(ValueError, "invalid JSON"):
            engine.response(response)
        for status in [400, 401, 402, 429, 500, 503]:
            response.raise_for_status.side_effect = RuntimeError(str(status))
            with self.assertRaises(RuntimeError):
                engine.response(response)


if __name__ == "__main__":
    unittest.main()
