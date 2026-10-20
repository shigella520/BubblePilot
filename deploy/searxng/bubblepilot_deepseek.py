"""DeepSeek Search for SearXNG; no application-side query rewriting."""

import json
from pathlib import Path
from urllib.parse import urlsplit

from searx.network import raise_for_httperror

categories = ["general"]
paging = False
safesearch = False
time_range_support = False
api_key_file = "/run/secrets/deepseek_api_key"
result_count = 10
_api_key = None


def init(engine_settings):
    global _api_key
    if type(result_count) is not int or not 1 <= result_count <= 50:
        raise ValueError("DeepSeek result_count must be between 1 and 50")
    try:
        key = Path(api_key_file).read_text(encoding="utf-8").strip()
    except OSError:
        raise ValueError("DeepSeek key file is unavailable") from None
    if not key or any(character.isspace() for character in key):
        raise ValueError("DeepSeek key file is empty or invalid")
    _api_key = key


def request(query, params):
    if not isinstance(query, str) or not query.strip() or len(query) > 128:
        raise ValueError("DeepSeek query must contain 1 to 128 characters")
    if _api_key is None:
        raise ValueError("DeepSeek engine is not initialized")
    params["url"] = "https://api.deepseek.com/v1/tools/search"
    params["method"] = "POST"
    params["headers"].update({
        "Authorization": "Bearer " + _api_key,
        "Content-Type": "application/json",
    })
    params["data"] = json.dumps({
        "query": query,
        "count": result_count,
        "need_content": False,
    }, ensure_ascii=False).encode("utf-8")
    params["raise_for_httperror"] = False
    return params


def response(resp):
    raise_for_httperror(resp)
    try:
        payload = resp.json()
    except ValueError:
        raise ValueError("DeepSeek returned invalid JSON") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise ValueError("DeepSeek returned an invalid results envelope")
    results = []
    for item in payload["results"]:
        if not isinstance(item, dict):
            continue
        url, title = item.get("url"), item.get("title")
        if not isinstance(url, str) or not isinstance(title, str) or not title.strip():
            continue
        try:
            parsed = urlsplit(url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                continue
        except ValueError:
            continue
        content = next((item.get(field) for field in ("summary", "snippet")
                        if isinstance(item.get(field), str) and item[field].strip()), "")
        results.append({"url": url, "title": title, "content": content})
    return results
