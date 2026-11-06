"""Pasul 1: din octeții fișierului obținem TEXTUL documentului.

  JPG / PNG          -> MedGemma transcrie textul din imagine
  PDF cu text        -> PyMuPDF citește textul direct din fișier (fără AI)
  PDF scanat         -> PyMuPDF face din pagină o imagine PNG -> MedGemma o transcrie
"""

from dataclasses import dataclass, field
from typing import Literal

import pymupdf

import medgemma_client
from errors import ExtractionError

# Câte pagini citim. O pagină scanată costă ~4 s de transcriere; Backend-ul așteaptă 60 s.
MAX_PAGES = 3

# Sub atâtea caractere, o pagină PDF e considerată „fără text” (scanată).
MIN_TEXT_CHARS = 20

# Cât text trimitem mai departe la extragere (~2700 tokeni), ca să încapă în CONTEXT_TOKENS
# împreună cu instrucțiunile și cu răspunsul.
MAX_TEXT_CHARS = 8000

TRANSCRIBE_PROMPT = (
    "Transcrie EXACT tot textul din imagine, rând cu rând, în limba în care este scris. "
    "Nu adăuga nimic, nu corecta greșelile, nu traduce, nu explica. "
    "Scrie doar textul din imagine."
)

# Primii octeți ai fiecărui format („magic bytes”), la fel ca în MedFlow-Backend/src/fileType.ts.
SIGNATURES = {
    "image/jpeg": b"\xff\xd8\xff",
    "image/png": b"\x89PNG\r\n\x1a\n",
    "application/pdf": b"%PDF-",
}


@dataclass
class DocumentText:
    text: str
    input_kind: Literal["image", "pdf_text", "pdf_scan"]
    pages: int
    warnings: list[str] = field(default_factory=list)


def detect_type(data: bytes) -> str | None:
    for mime_type, signature in SIGNATURES.items():
        if data.startswith(signature):
            return mime_type
    return None


def read_document(data: bytes, content_type: str) -> DocumentText:
    real_type = detect_type(data)
    if real_type is None:
        raise ExtractionError(415, "Fișierul nu este un JPG, PNG sau PDF valid")
    if real_type != content_type:
        raise ExtractionError(415, f"Content-Type este {content_type}, dar fișierul este {real_type}")

    if real_type == "application/pdf":
        document = read_pdf(data)
    else:
        text, warnings = transcribe_image(data)
        document = DocumentText(text=text, input_kind="image", pages=1, warnings=warnings)

    document.text = clean_text(document.text).strip()
    if len(document.text) < MIN_TEXT_CHARS:
        raise ExtractionError(422, "Nu am găsit text în document")
    if len(document.text) > MAX_TEXT_CHARS:
        document.text = document.text[:MAX_TEXT_CHARS]
        document.warnings.append("Documentul e foarte lung: am citit doar prima parte.")
    return document


def clean_text(text: str) -> str:
    """Înlocuiește caracterele „invizibile” din PDF-uri cu cele obișnuite.

    Textul scos din PDF are des spațiu non-breaking (U+00A0) în loc de spațiu și
    soft hyphen (U+00AD) în loc de „-”. Pe ecran arată la fel, dar pentru model nu sunt.
    """
    return text.replace("\u00a0", " ").replace("\u00ad", "-")


def transcribe_image(image: bytes) -> tuple[str, list[str]]:
    text, truncated = medgemma_client.generate(TRANSCRIBE_PROMPT, image=image, max_tokens=2048)
    warnings = []
    if truncated:
        warnings.append("Transcrierea imaginii a fost întreruptă: o parte din text poate lipsi.")
    return text, warnings


def read_pdf(data: bytes) -> DocumentText:
    try:
        pdf = pymupdf.open(stream=data, filetype="pdf")
    except Exception:
        raise ExtractionError(422, "PDF-ul este deteriorat și nu poate fi citit")
    if pdf.needs_pass:
        raise ExtractionError(422, "PDF-ul este protejat cu parolă")
    if pdf.page_count == 0:
        raise ExtractionError(422, "PDF-ul nu are pagini")

    pages_to_read = min(pdf.page_count, MAX_PAGES)
    texts: list[str] = []
    warnings: list[str] = []
    any_scanned = False

    for page_number in range(pages_to_read):
        page = pdf[page_number]
        page_text = page.get_text().strip()
        if len(page_text) >= MIN_TEXT_CHARS:
            texts.append(page_text)
        else:
            # Pagina nu are text: e o poză. O transformăm în PNG și o dăm lui MedGemma.
            any_scanned = True
            png = page.get_pixmap(dpi=150).tobytes("png")
            page_text, page_warnings = transcribe_image(png)
            texts.append(page_text)
            warnings.extend(page_warnings)

    if pdf.page_count > MAX_PAGES:
        warnings.append(f"Am citit doar primele {MAX_PAGES} pagini din {pdf.page_count}.")

    return DocumentText(
        text="\n\n".join(texts),
        input_kind="pdf_scan" if any_scanned else "pdf_text",
        pages=pages_to_read,
        warnings=warnings,
    )
