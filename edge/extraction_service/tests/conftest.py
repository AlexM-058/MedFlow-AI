"""Setări comune pentru toate testele (pytest citește singur acest fișier)."""

import pytest


@pytest.fixture(autouse=True)
def default_ocr_engine(monkeypatch):
    # Dacă pe calculatorul tău e setat OCR_ENGINE, testele ar folosi alt motor OCR.
    # Îl ștergem înainte de fiecare test, ca toate să pornească de la motorul implicit (medgemma).
    monkeypatch.delenv("OCR_ENGINE", raising=False)
