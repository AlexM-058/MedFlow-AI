"""Bugetul de timp: serviciul se oprește singur cu 504, înainte ca Backend-ul să renunțe."""

import time

import pytest
from fastapi.testclient import TestClient

import medgemma_client
import time_budget
from errors import ExtractionError
from helpers import FakeMedGemma, make_png, make_scanned_pdf, make_text_pdf
from main import app

client = TestClient(app)


class FakeResponse:
    status_code = 200

    def json(self):
        return {"response": "text", "done_reason": "stop"}


@pytest.fixture
def ollama_post(monkeypatch):
    """Înlocuiește httpx2.post (adică Ollama-ul real) și ține minte apelurile."""
    calls = []

    def post(url, json, timeout):
        calls.append({"url": url, "timeout": timeout})
        return FakeResponse()

    monkeypatch.setattr(medgemma_client.httpx2, "post", post)
    return calls


def test_no_deadline_means_normal_timeout():
    assert time_budget.seconds_left(None, 45) == 45


def test_timeout_is_capped_to_what_is_left():
    left = time_budget.seconds_left(time.monotonic() + 10, 45)
    assert 9 < left <= 10


def test_full_timeout_when_enough_time_is_left():
    assert time_budget.seconds_left(time.monotonic() + 100, 45) == 45


def test_expired_deadline_raises_504():
    with pytest.raises(ExtractionError) as error:
        time_budget.seconds_left(time.monotonic() - 1, 45)
    assert error.value.status_code == 504


def test_generate_with_expired_deadline_does_not_call_ollama(ollama_post):
    with pytest.raises(ExtractionError) as error:
        medgemma_client.generate("prompt", deadline=time.monotonic() - 1)
    assert error.value.status_code == 504
    assert ollama_post == []


def test_generate_timeout_is_capped_by_deadline(ollama_post):
    medgemma_client.generate("prompt", deadline=time.monotonic() + 10)
    assert ollama_post[0]["timeout"] <= 10


@pytest.mark.parametrize(
    "data, content_type",
    [
        (make_png(), "image/png"),  # se oprește înainte de OCR
        (make_scanned_pdf(pages=1), "application/pdf"),  # se oprește înainte de OCR pe pagină
        (make_text_pdf(["Glicemie 92 mg/dL (70 - 110)"]), "application/pdf"),  # înainte de extragere
    ],
)
def test_exhausted_budget_returns_504_without_calling_ollama(monkeypatch, ollama_post, data, content_type):
    monkeypatch.setattr(time_budget, "TIME_BUDGET_SECONDS", 0)
    response = client.post("/extract", content=data, headers={"Content-Type": content_type})
    assert response.status_code == 504
    assert "error" in response.json()
    assert ollama_post == []


def test_every_ai_call_gets_the_same_request_deadline(monkeypatch):
    fake = FakeMedGemma(
        transcription="Glicemie 92 mg/dL (70 - 110)",
        extraction={"medications": [], "diagnoses": [], "lab_results": []},
    )
    monkeypatch.setattr(medgemma_client, "generate", fake)

    response = client.post("/extract", content=make_png(), headers={"Content-Type": "image/png"})

    assert response.status_code == 200
    assert len(fake.calls) == 2  # transcriere + extragere
    deadlines = {call["deadline"] for call in fake.calls}
    assert len(deadlines) == 1 and None not in deadlines
