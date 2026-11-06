"""OCR (imagine -> text): alegerea motorului din OCR_ENGINE și drumul imaginilor prin ocr.py."""

import pytest
from fastapi.testclient import TestClient

import medgemma_client
import ocr
from errors import ExtractionError
from helpers import FakeMedGemma, make_png, make_scanned_pdf, make_text_pdf
from main import app
from text_source import read_document

LONG_TEXT = "Hemoglobina 13,5 g/dL (12 - 16)"


@pytest.fixture
def fake(monkeypatch):
    fake = FakeMedGemma(transcription=LONG_TEXT)
    monkeypatch.setattr(medgemma_client, "generate", fake)
    return fake


def test_default_engine_is_medgemma(monkeypatch, fake):
    monkeypatch.delenv("OCR_ENGINE", raising=False)
    assert ocr.active_engine() == "medgemma"

    png = make_png()
    text, warnings = ocr.image_to_text(png)

    assert (text, warnings) == (LONG_TEXT, [])
    # MedGemma a primit imaginea și promptul de transcriere, fără schemă JSON.
    assert fake.calls[0]["image"] == png
    assert fake.calls[0]["prompt"] == ocr.TRANSCRIBE_PROMPT
    assert fake.calls[0]["json_schema"] is None


def test_engine_name_ignores_case_and_spaces(monkeypatch):
    monkeypatch.setenv("OCR_ENGINE", "  MedGemma ")
    assert ocr.active_engine() == "medgemma"


def test_unknown_engine_fails_with_503_without_calling_any_model(monkeypatch, fake):
    monkeypatch.setenv("OCR_ENGINE", "nu-exista")
    with pytest.raises(ExtractionError) as error:
        ocr.image_to_text(make_png())
    assert error.value.status_code == 503
    assert "nu-exista" in error.value.message
    assert fake.calls == []


def test_unknown_engine_does_not_block_text_pdfs(monkeypatch, fake):
    # Un PDF digital nu are nevoie de OCR, deci merge chiar dacă OCR_ENGINE e greșit.
    monkeypatch.setenv("OCR_ENGINE", "nu-exista")
    document = read_document(make_text_pdf(["Glicemie 92 mg/dL (70 - 110)"]), "application/pdf")
    assert document.input_kind == "pdf_text"


def test_medgemma_cut_transcription_adds_warning(monkeypatch):
    monkeypatch.setattr(medgemma_client, "generate", lambda *args, **kwargs: (LONG_TEXT, True))
    text, warnings = ocr.image_to_text(make_png())
    assert text == LONG_TEXT
    assert len(warnings) == 1 and "întreruptă" in warnings[0]


def test_new_engine_needs_only_a_function_and_an_entry(monkeypatch, fake):
    # Exact pașii din comentariul din ocr.py: o funcție + o intrare în ENGINES + OCR_ENGINE.
    def other_engine(image, deadline):
        return "text de la alt motor OCR", ["avertisment de test"]

    monkeypatch.setitem(ocr.ENGINES, "alt-motor", other_engine)
    monkeypatch.setenv("OCR_ENGINE", "alt-motor")

    assert ocr.image_to_text(make_png()) == ("text de la alt motor OCR", ["avertisment de test"])
    assert fake.calls == []  # MedGemma nu a fost folosit


class FakeOcr:
    """Înlocuiește ocr.image_to_text: ține minte ce imagini a primit."""

    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, image, deadline=None):
        self.calls.append({"image": image, "deadline": deadline})
        return LONG_TEXT, ["avertisment OCR"]


def test_image_goes_through_ocr_image_to_text(monkeypatch):
    fake_ocr = FakeOcr()
    monkeypatch.setattr(ocr, "image_to_text", fake_ocr)
    png = make_png()

    document = read_document(png, "image/png", deadline=123.0)

    assert fake_ocr.calls == [{"image": png, "deadline": 123.0}]
    assert document.text == LONG_TEXT
    assert document.input_kind == "image"
    assert document.warnings == ["avertisment OCR"]


def test_scanned_pdf_pages_go_through_ocr_image_to_text(monkeypatch):
    fake_ocr = FakeOcr()
    monkeypatch.setattr(ocr, "image_to_text", fake_ocr)

    document = read_document(make_scanned_pdf(pages=2), "application/pdf")

    assert len(fake_ocr.calls) == 2  # o dată pentru fiecare pagină scanată
    assert all(call["image"].startswith(b"\x89PNG") for call in fake_ocr.calls)
    assert document.input_kind == "pdf_scan"
    assert document.warnings == ["avertisment OCR", "avertisment OCR"]


def test_health_reports_active_ocr_engine(monkeypatch):
    client = TestClient(app)
    monkeypatch.delenv("OCR_ENGINE", raising=False)
    assert client.get("/health").json()["ocr_engine"] == "medgemma"
    monkeypatch.setenv("OCR_ENGINE", "alt-motor")
    assert client.get("/health").json()["ocr_engine"] == "alt-motor"
