"""Preprocesarea imaginii și calea OCR (cu un motor fals, fără Tesseract)."""

import io

import pytest
from PIL import Image, ImageDraw, ImageStat

import medgemma_client
import ocr
import preprocess
from errors import ExtractionError
from helpers import FakeMedGemma
from text_source import read_document

OCR_TEXT = "Paracetamol 500 mg, 1 comprimat de 3 ori pe zi, 5 zile"


def make_png() -> bytes:
    """O imagine PNG simplă cu text (generată cu Pillow, fără PyMuPDF)."""
    image = Image.new("L", (300, 100), 255)
    ImageDraw.Draw(image).text((10, 40), "Reteta fictiva", fill=0)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def low_contrast_png() -> bytes:
    """O poză „spălată”: text gri pe fundal gri deschis, mică."""
    image = Image.new("L", (400, 120), 150)
    ImageDraw.Draw(image).text((10, 40), "Paracetamol 500 mg", fill=120)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_enhance_raises_contrast_and_size():
    original = low_contrast_png()
    enhanced = preprocess.enhance_for_ocr(original)
    before = Image.open(io.BytesIO(original))
    after = Image.open(io.BytesIO(enhanced))
    assert after.mode == "L"
    # O imagine mică e mărită, dar nu cu mai mult de 3x (peste, doar crește zgomotul).
    assert before.width < after.width <= before.width * 3
    assert ImageStat.Stat(after).stddev[0] > ImageStat.Stat(before).stddev[0]


def test_enhance_does_not_change_the_original_bytes():
    original = low_contrast_png()
    snapshot = bytes(original)
    preprocess.enhance_for_ocr(original)
    assert original == snapshot


def test_enhance_rejects_a_corrupt_image():
    with pytest.raises(ExtractionError) as error:
        preprocess.enhance_for_ocr(b"\x89PNG\r\n\x1a\nnot really a png")
    assert error.value.status_code == 422


class FakeOcr:
    def __init__(self, text=OCR_TEXT, confidence=90.0, fail=False):
        self.result = ocr.OcrResult(text=text, confidence=confidence)
        self.fail = fail
        self.calls = 0

    def read(self, png):
        self.calls += 1
        if self.fail:
            raise RuntimeError("tesseract crashed")
        return self.result


@pytest.fixture
def medgemma(monkeypatch):
    fake = FakeMedGemma(transcription="Text transcris de MedGemma, destul de lung")
    monkeypatch.setattr(medgemma_client, "generate", fake)
    return fake


def use_engine(monkeypatch, engine):
    monkeypatch.setattr(ocr, "get_engine", lambda: engine)


def test_confident_ocr_is_used_and_medgemma_is_not_called(monkeypatch, medgemma):
    engine = FakeOcr(confidence=92)
    use_engine(monkeypatch, engine)
    document = read_document(make_png(), "image/png")
    assert document.text == OCR_TEXT
    assert document.warnings == []
    assert engine.calls == 1
    assert medgemma.calls == []


def test_medium_confidence_keeps_ocr_text_but_warns(monkeypatch, medgemma):
    use_engine(monkeypatch, FakeOcr(confidence=68))
    document = read_document(make_png(), "image/png")
    assert document.text == OCR_TEXT
    assert any("verificați" in warning for warning in document.warnings)
    assert medgemma.calls == []


def test_low_confidence_falls_back_to_medgemma_with_a_warning(monkeypatch, medgemma):
    use_engine(monkeypatch, FakeOcr(confidence=30))
    png = make_png()
    document = read_document(png, "image/png")
    assert document.text.startswith("Text transcris de MedGemma")
    assert any("încredere scăzută" in warning for warning in document.warnings)
    assert medgemma.calls[0]["image"] == png  # MedGemma primește imaginea originală


def test_ocr_crash_falls_back_to_medgemma_with_a_warning(monkeypatch, medgemma):
    use_engine(monkeypatch, FakeOcr(fail=True))
    document = read_document(make_png(), "image/png")
    assert document.text.startswith("Text transcris de MedGemma")
    assert any("OCR a eșuat" in warning for warning in document.warnings)


def test_empty_ocr_text_falls_back(monkeypatch, medgemma):
    use_engine(monkeypatch, FakeOcr(text="  ", confidence=95))
    document = read_document(make_png(), "image/png")
    assert document.text.startswith("Text transcris de MedGemma")


def test_no_engine_keeps_the_old_behaviour(monkeypatch, medgemma):
    use_engine(monkeypatch, None)
    document = read_document(make_png(), "image/png")
    assert document.text.startswith("Text transcris de MedGemma")
    assert document.warnings == []
