"""Clientul care vorbește cu Ollama: transformă problemele de rețea în coduri HTTP clare."""

import httpx2
import pytest

import medgemma_client
from errors import ExtractionError


class FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


def fake_post(result):
    """Înlocuiește httpx.post: întoarce `result` sau îl aruncă, dacă e o excepție."""
    calls = []

    def post(url, json, timeout):
        calls.append({"url": url, "json": json, "timeout": timeout})
        if isinstance(result, Exception):
            raise result
        return result

    post.calls = calls
    return post


def test_sends_prompt_image_and_schema_and_returns_text(monkeypatch):
    post = fake_post(FakeResponse(200, {"response": "text", "done_reason": "stop"}))
    monkeypatch.setattr(medgemma_client.httpx2, "post", post)

    text, truncated = medgemma_client.generate("prompt", image=b"abc", json_schema={"type": "object"})

    assert (text, truncated) == ("text", False)
    sent = post.calls[0]["json"]
    assert sent["prompt"] == "prompt"
    assert sent["images"] == ["YWJj"]  # „abc” în base64
    assert sent["format"] == {"type": "object"}
    assert sent["options"]["temperature"] == 0
    assert sent["stream"] is False


def test_reports_when_answer_was_cut_by_token_limit(monkeypatch):
    post = fake_post(FakeResponse(200, {"response": "foarte lung", "done_reason": "length"}))
    monkeypatch.setattr(medgemma_client.httpx2, "post", post)
    assert medgemma_client.generate("prompt") == ("foarte lung", True)


@pytest.mark.parametrize(
    "problem, expected_status",
    [
        (httpx2.ConnectError("refused"), 503),
        (httpx2.ReadTimeout("slow"), 504),
        (FakeResponse(404, {"error": "model not found"}), 503),
        (FakeResponse(500, {"error": "boom"}), 502),
    ],
)
def test_network_and_ollama_problems_become_clear_errors(monkeypatch, problem, expected_status):
    monkeypatch.setattr(medgemma_client.httpx2, "post", fake_post(problem))
    with pytest.raises(ExtractionError) as error:
        medgemma_client.generate("prompt")
    assert error.value.status_code == expected_status
