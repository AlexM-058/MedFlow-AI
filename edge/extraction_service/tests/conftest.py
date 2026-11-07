"""Testele existente nu depind de un motor OCR instalat pe mașina dezvoltatorului."""

import pytest

import ocr


@pytest.fixture(autouse=True)
def no_ocr_engine_by_default(monkeypatch):
    monkeypatch.setattr(ocr, "get_engine", lambda: None)
