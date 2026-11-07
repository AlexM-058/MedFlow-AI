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



# ---------------------------------------------------------------------------------------
# Motorul „easyocr”. Nu încărcăm EasyOCR real (lent, cere GPU): înlocuim cititorul cu unul
# fals, care ține minte ce imagine a primit și întoarce rânduri de text stabilite de noi.
# ---------------------------------------------------------------------------------------


def box(text, x, y, confidence=0.95, height=20, width=100):
    """O casetă EasyOCR: (colțuri, text, încredere 0-1), cu colțul stânga-sus în (x, y)."""
    corners = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]
    return corners, text, confidence


class FakeEasyOcrReader:
    def __init__(self, boxes):
        self.boxes = boxes
        self.calls: list[dict] = []

    def readtext(self, image, detail, paragraph):
        self.calls.append({"image": image, "detail": detail, "paragraph": paragraph})
        return self.boxes


def use_easyocr(monkeypatch, reader):
    monkeypatch.setenv("OCR_ENGINE", "easyocr")
    monkeypatch.setattr(ocr, "_easyocr_reader", lambda: reader)


def test_easyocr_engine_reads_image_and_joins_lines(monkeypatch, fake):
    reader = FakeEasyOcrReader([box("Hemoglobina 13,5 g/dL", 10, 10), box("(12 - 16)", 10, 50)])
    use_easyocr(monkeypatch, reader)
    png = make_png()

    assert ocr.image_to_text(png) == ("Hemoglobina 13,5 g/dL\n(12 - 16)", [])
    # detail=1: avem nevoie de scorul de încredere; paragraph=False: rândurile le formăm noi.
    assert reader.calls == [{"image": png, "detail": 1, "paragraph": False}]
    assert fake.calls == []  # MedGemma nu a fost folosit pentru OCR


def test_easyocr_keeps_table_row_together(monkeypatch):
    # Coloanele unui tabel (nume / valoare / unitate) vin ca casete separate, în ordine amestecată.
    boxes = [
        box("g/dL", 300, 12, width=40),
        box("Leucocite", 10, 52, width=90),
        box("Hemoglobina", 10, 10, width=100),
        box("13,5", 200, 10, width=40),
        box("6,2", 200, 50, width=40),
        box("mii/uL", 300, 52, width=50),
    ]
    use_easyocr(monkeypatch, FakeEasyOcrReader(boxes))
    text, warnings = ocr.image_to_text(make_png())
    assert text == "Hemoglobina 13,5 g/dL\nLeucocite 6,2 mii/uL"
    assert warnings == []


def test_easyocr_medium_confidence_keeps_text_and_warns(monkeypatch, fake):
    use_easyocr(monkeypatch, FakeEasyOcrReader([box(LONG_TEXT, 10, 10, confidence=0.68)]))
    text, warnings = ocr.image_to_text(make_png())
    assert text == LONG_TEXT
    assert any("verificați" in warning for warning in warnings)
    assert fake.calls == []


def test_easyocr_low_confidence_falls_back_to_medgemma(monkeypatch, fake):
    use_easyocr(monkeypatch, FakeEasyOcrReader([box("Hemoglobina 1?,5 g/dL (12 - 16)", 10, 10, confidence=0.3)]))
    png = make_png()
    text, warnings = ocr.image_to_text(png)
    assert text == LONG_TEXT  # transcrierea MedGemma
    assert any("încredere scăzută" in warning for warning in warnings)
    assert fake.calls[0]["image"] == png


def test_easyocr_without_text_falls_back_to_medgemma(monkeypatch, fake):
    use_easyocr(monkeypatch, FakeEasyOcrReader([]))
    text, warnings = ocr.image_to_text(make_png())
    assert text == LONG_TEXT
    assert len(warnings) == 1 and "prea puțin text" in warnings[0]


def test_easyocr_that_cannot_start_falls_back_to_medgemma(monkeypatch, fake):
    def broken_reader():
        raise ExtractionError(503, "EasyOCR nu a putut porni")

    monkeypatch.setenv("OCR_ENGINE", "easyocr")
    monkeypatch.setattr(ocr, "_easyocr_reader", broken_reader)
    text, warnings = ocr.image_to_text(make_png())
    assert text == LONG_TEXT
    assert any("nu e disponibil" in warning for warning in warnings)


def test_easyocr_crash_falls_back_to_medgemma(monkeypatch, fake):
    class CrashingReader:
        def readtext(self, *args, **kwargs):
            raise RuntimeError("CUDA out of memory")

    use_easyocr(monkeypatch, CrashingReader())
    text, warnings = ocr.image_to_text(make_png())
    assert text == LONG_TEXT
    assert any("OCR a eșuat" in warning for warning in warnings)


def test_local_engine_does_not_hide_a_timeout(monkeypatch, fake):
    # 504 (buget terminat) trebuie să ajungă la utilizator, nu să fie „acoperit” de MedGemma.
    def too_slow(image, deadline):
        raise ExtractionError(504, "prea lent")

    monkeypatch.setitem(ocr.ENGINES, "lent", too_slow)
    monkeypatch.setattr(ocr, "LOCAL_ENGINES", ocr.LOCAL_ENGINES | {"lent"})
    monkeypatch.setenv("OCR_ENGINE", "lent")
    with pytest.raises(ExtractionError) as error:
        ocr.image_to_text(make_png())
    assert error.value.status_code == 504
    assert fake.calls == []


def test_medgemma_engine_has_no_fallback(monkeypatch):
    def failing(*args, **kwargs):
        raise ExtractionError(503, "Ollama nu răspunde")

    monkeypatch.setattr(medgemma_client, "generate", failing)
    with pytest.raises(ExtractionError) as error:
        ocr.image_to_text(make_png())
    assert error.value.status_code == 503


# ---------------------------------------------------------------------------------------
# Motorul „tesseract”, cu un pytesseract fals (fără programul Tesseract instalat).
# ---------------------------------------------------------------------------------------


class FakeTesseract:
    Output = type("Output", (), {"DICT": "dict"})

    def __init__(self, words, confidence):
        self.words = words
        self.confidence = confidence
        self.calls: list[dict] = []

    def image_to_data(self, image, lang, output_type, config):
        self.calls.append({"size": image.size, "lang": lang, "config": config})
        count = len(self.words)
        return {
            "text": list(self.words),
            "conf": [self.confidence] * count,
            "block_num": [1] * count,
            "par_num": [1] * count,
            "line_num": [1 if index < count // 2 else 2 for index in range(count)],
        }


def use_tesseract(monkeypatch, words, confidence):
    tesseract = FakeTesseract(words, confidence)
    monkeypatch.setenv("OCR_ENGINE", "tesseract")
    monkeypatch.setattr(ocr, "_tesseract_ready", lambda: (tesseract, "ron+eng"))
    return tesseract


WORDS = ["Hemoglobina", "13,5", "g/dL", "(12", "-", "16)"]


def test_tesseract_reads_enhanced_image_and_keeps_lines(monkeypatch, fake):
    tesseract = use_tesseract(monkeypatch, WORDS, 92.0)
    text, warnings = ocr.image_to_text(make_png())
    assert text == "Hemoglobina 13,5 g/dL\n(12 - 16)"
    assert warnings == []
    assert tesseract.calls[0]["lang"] == "ron+eng"
    # Imaginea a trecut prin preprocess: cea mică (300 px) e mărită, dar nu cu mai mult de 3x.
    assert max(tesseract.calls[0]["size"]) == 900
    assert fake.calls == []


def test_tesseract_medium_confidence_warns(monkeypatch, fake):
    use_tesseract(monkeypatch, WORDS, 68.0)
    text, warnings = ocr.image_to_text(make_png())
    assert text.startswith("Hemoglobina")
    assert any("verificați" in warning for warning in warnings)
    assert fake.calls == []


def test_tesseract_low_confidence_falls_back_to_medgemma(monkeypatch, fake):
    use_tesseract(monkeypatch, WORDS, 30.0)
    png = make_png()
    text, warnings = ocr.image_to_text(png)
    assert text == LONG_TEXT
    assert any("încredere scăzută" in warning for warning in warnings)
    assert fake.calls[0]["image"] == png  # MedGemma primește imaginea originală


def test_missing_tesseract_falls_back_to_medgemma(monkeypatch, fake):
    def missing():
        raise ExtractionError(503, "Programul Tesseract nu e instalat pe acest calculator")

    monkeypatch.setenv("OCR_ENGINE", "tesseract")
    monkeypatch.setattr(ocr, "_tesseract_ready", missing)
    text, warnings = ocr.image_to_text(make_png())
    assert text == LONG_TEXT
    assert any("nu e disponibil" in warning for warning in warnings)


def test_tesseract_corrupt_image_is_422_not_a_fallback(monkeypatch, fake):
    use_tesseract(monkeypatch, WORDS, 92.0)
    with pytest.raises(ExtractionError) as error:
        ocr.image_to_text(b"\x89PNG\r\n\x1a\nnot really a png")
    assert error.value.status_code == 422
    assert fake.calls == []
