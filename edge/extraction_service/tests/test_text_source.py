"""Pasul 1: din octeții fișierului obținem textul documentului."""

import pytest

import medgemma_client
from errors import ExtractionError
from helpers import FakeMedGemma, make_png, make_scanned_pdf, make_text_pdf
from text_source import MAX_PAGES, clean_text, read_document

LONG_TEXT = "Hemoglobina 13,5 g/dL (12 - 16)"


@pytest.fixture
def fake(monkeypatch):
    fake = FakeMedGemma(transcription=LONG_TEXT)
    monkeypatch.setattr(medgemma_client, "generate", fake)
    return fake


def test_image_is_transcribed_by_medgemma(fake):
    png = make_png()
    document = read_document(png, "image/png")
    assert document.text == LONG_TEXT
    assert document.input_kind == "image"
    assert document.pages == 1
    assert fake.calls[0]["image"] == png


def test_text_pdf_is_read_without_medgemma(fake):
    document = read_document(make_text_pdf(["Glicemie 92 mg/dL (70 - 110)"]), "application/pdf")
    assert "Glicemie 92 mg/dL" in document.text
    assert document.input_kind == "pdf_text"
    assert fake.calls == []


def test_scanned_pdf_page_is_rendered_and_transcribed(fake):
    document = read_document(make_scanned_pdf(pages=1), "application/pdf")
    assert document.text == LONG_TEXT
    assert document.input_kind == "pdf_scan"
    # MedGemma a primit pagina ca imagine PNG.
    assert fake.calls[0]["image"].startswith(b"\x89PNG")


def test_only_first_pages_are_read_with_warning(fake):
    pdf = make_text_pdf([f"Pagina {i} Glicemie 92 mg/dL" for i in range(1, MAX_PAGES + 3)])
    document = read_document(pdf, "application/pdf")
    assert document.pages == MAX_PAGES
    assert f"Pagina {MAX_PAGES} " in document.text
    assert f"Pagina {MAX_PAGES + 1} " not in document.text
    assert any(str(MAX_PAGES + 2) in w for w in document.warnings)


def test_jpeg_content_type_is_accepted(fake):
    import pymupdf

    page = pymupdf.open().new_page(width=200, height=80)
    page.insert_text((10, 40), "Reteta")
    jpg = page.get_pixmap(dpi=72).tobytes("jpg")
    assert read_document(jpg, "image/jpeg").input_kind == "image"


def test_bytes_that_are_not_jpg_png_or_pdf_are_rejected(fake):
    with pytest.raises(ExtractionError) as error:
        read_document(b"MZ\x90\x00 nu sunt o imagine", "image/png")
    assert error.value.status_code == 415


def test_declared_type_must_match_real_bytes(fake):
    with pytest.raises(ExtractionError) as error:
        read_document(make_png(), "application/pdf")
    assert error.value.status_code == 415


def test_broken_pdf_is_rejected(fake):
    with pytest.raises(ExtractionError) as error:
        read_document(b"%PDF-1.7 acesta nu e un PDF intreg", "application/pdf")
    assert error.value.status_code == 422


def test_document_without_text_is_rejected(monkeypatch):
    monkeypatch.setattr(medgemma_client, "generate", FakeMedGemma(transcription="  "))
    with pytest.raises(ExtractionError) as error:
        read_document(make_png(), "image/png")
    assert error.value.status_code == 422


def test_clean_text_replaces_invisible_pdf_characters():
    # Din PDF-uri: spațiu „non-breaking” (U+00A0) și soft hyphen (U+00AD) în loc de „ ” și „-”.
    assert clean_text("Hemoglobină\u00a013,5\u00a0g/dL\u00a012\u00a0\u00ad\u00a016") == "Hemoglobină 13,5 g/dL 12 - 16"


def test_clean_text_keeps_line_breaks():
    assert clean_text("Rp/\n1. Amlodipină") == "Rp/\n1. Amlodipină"
