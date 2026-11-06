"""Endpoint-ul HTTP, cu toți cei 3 pași, dar cu un MedGemma fals."""

import pytest
from fastapi.testclient import TestClient

import medgemma_client
from errors import ExtractionError
from helpers import FakeMedGemma, make_png, make_text_pdf
from main import app

client = TestClient(app)

TRANSCRIPTION = """REȚETĂ MEDICALĂ (fictiv)
Data: 14.03.2025
Diagnostic: Hipertensiune arterială esențială
1. Amlodipin 5 mg - 1 cp/zi
2. Metformin - 2 cp/zi"""

MODEL_ANSWER = {
    "medications": [
        {"name": "Amlodipin", "dose": "5 mg", "frequency": "1 cp/zi", "duration": None},
        {"name": "Metformin", "dose": "2 cp/zi", "frequency": "2 cp/zi", "duration": None},
    ],
    "diagnoses": ["Hipertensiune arterială esențială"],
    "lab_results": [],
}


@pytest.fixture
def fake(monkeypatch):
    fake = FakeMedGemma(transcription=TRANSCRIPTION, extraction=MODEL_ANSWER)
    monkeypatch.setattr(medgemma_client, "generate", fake)
    return fake


def post_file(data: bytes, content_type: str):
    return client.post("/extract", content=data, headers={"Content-Type": content_type})


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_image_returns_verified_data_in_backend_contract_shape(fake):
    response = post_file(make_png(), "image/png")

    assert response.status_code == 200
    data = response.json()["extracted_data"]  # forma cerută de MedFlow-Backend/src/medgemma.ts
    assert data["medications"] == [
        {"name": "Amlodipin", "dose": "5 mg", "frequency": "1 cp/zi", "duration": None},
        {"name": "Metformin", "dose": None, "frequency": "2 cp/zi", "duration": None},
    ]
    assert data["diagnoses"] == ["Hipertensiune arterială esențială"]
    assert data["lab_results"] == []
    assert data["dates"] == [{"label": "Data", "value": "14.03.2025"}]
    assert len(data["warnings"]) == 1 and "2 cp/zi" in data["warnings"][0]
    assert data["source"] == {"model": medgemma_client.MODEL, "input_kind": "image", "pages": 1}


def test_transcribed_text_is_not_sent_back(fake):
    # Textul complet conține și numele pacientului: trimitem doar câmpurile medicale.
    response = post_file(make_png(), "image/png")
    assert "REȚETĂ MEDICALĂ" not in response.text


def test_text_pdf_goes_straight_to_extraction(fake):
    response = post_file(make_text_pdf([TRANSCRIPTION.replace("ă", "a").replace("ț", "t").replace("Ț", "T").replace("Ă", "A")]), "application/pdf")
    assert response.status_code == 200
    assert response.json()["extracted_data"]["source"]["input_kind"] == "pdf_text"
    assert len(fake.calls) == 1  # doar extragerea, fără transcriere


def test_content_type_with_parameters_is_accepted(fake):
    assert post_file(make_png(), "image/png; charset=binary").status_code == 200


def test_empty_body_is_rejected():
    response = post_file(b"", "image/png")
    assert response.status_code == 400
    assert "error" in response.json()


def test_unsupported_content_type_is_rejected():
    response = post_file(b"hello", "text/plain")
    assert response.status_code == 415
    assert "error" in response.json()


def test_ollama_down_becomes_503(monkeypatch):
    def down(*args, **kwargs):
        raise ExtractionError(503, "Ollama nu răspunde")

    monkeypatch.setattr(medgemma_client, "generate", down)
    response = post_file(make_png(), "image/png")
    assert response.status_code == 503
    assert response.json() == {"error": "Ollama nu răspunde"}


def test_model_returning_invalid_json_becomes_502(monkeypatch):
    monkeypatch.setattr(
        medgemma_client, "generate", FakeMedGemma(transcription=TRANSCRIPTION, extraction='{"medications": [')
    )
    response = post_file(make_png(), "image/png")
    assert response.status_code == 502
