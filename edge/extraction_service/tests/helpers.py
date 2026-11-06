"""Unelte pentru teste: fișiere generate pe loc și un MedGemma fals."""

import json

import pymupdf


def make_png(text: str = "Reteta fictiva") -> bytes:
    """O imagine PNG cu un text pe ea (ca o poză făcută documentului)."""
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=100)
    page.insert_text((10, 50), text)
    return page.get_pixmap(dpi=72).tobytes("png")


def make_text_pdf(page_texts: list[str]) -> bytes:
    """Un PDF „digital”: textul e salvat ca text în fișier."""
    doc = pymupdf.open()
    for text in page_texts:
        page = doc.new_page()
        page.insert_text((72, 72), text)
    return doc.tobytes()


def make_scanned_pdf(pages: int = 1) -> bytes:
    """Un PDF „scanat”: fiecare pagină conține doar o imagine, fără text."""
    doc = pymupdf.open()
    for _ in range(pages):
        page = doc.new_page()
        page.insert_image(pymupdf.Rect(72, 72, 372, 172), stream=make_png())
    return doc.tobytes()


class FakeMedGemma:
    """Înlocuiește medgemma_client.generate în teste: răspunde instant, fără Ollama.

    - apel cu json_schema (pasul 2, extragerea) -> întoarce `extraction`
    - apel fără json_schema (pasul 1, transcrierea) -> întoarce `transcription`
    Ține minte apelurile, ca testele să verifice ce s-a cerut.
    """

    def __init__(self, transcription: str = "", extraction: dict | str | None = None):
        self.transcription = transcription
        self.extraction = extraction if extraction is not None else {
            "medications": [], "diagnoses": [], "lab_results": []
        }
        self.calls: list[dict] = []

    def __call__(self, prompt, image=None, json_schema=None, max_tokens=1024, deadline=None):
        self.calls.append({"prompt": prompt, "image": image, "json_schema": json_schema, "deadline": deadline})
        if json_schema is not None:
            raw = self.extraction if isinstance(self.extraction, str) else json.dumps(self.extraction)
            return raw, False
        return self.transcription, False
