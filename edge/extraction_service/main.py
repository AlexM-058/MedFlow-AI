"""Serviciul MedGemma de extragere (FastAPI).

Contractul cerut de MedFlow-Backend (src/medgemma.ts):
  POST /extract
  Header:  Content-Type: image/jpeg | image/png | application/pdf
  Body:    octeții fișierului (nu JSON, nu base64)
  Răspuns: 200 + {"extracted_data": {...}}   sau   4xx/5xx + {"error": "..."}

Pornire (din acest folder):
  .venv\\Scripts\\python -m uvicorn main:app --host 127.0.0.1 --port 8090
"""

import logging
import time

from fastapi import Body, FastAPI, Header
from fastapi.responses import JSONResponse

import medgemma_client
import ocr
import time_budget
from dates import find_dates
from errors import ExtractionError
from extraction import extract_fields
from schemas import ExtractedData, Source
from text_source import read_document
from verification import verify_extraction

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("medgemma-extraction")
# httpx2 scrie un rând pentru fiecare apel la Ollama; păstrăm doar avertismentele lui.
logging.getLogger("httpx2").setLevel(logging.WARNING)

# Backend-ul acceptă maxim 10 MB; lăsăm puțină rezervă.
MAX_FILE_BYTES = 15 * 1024 * 1024

app = FastAPI(title="MedFlow MedGemma extraction")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "medflow-medgemma-extraction",
        "model": medgemma_client.MODEL,  # modelul care face extragerea (pasul 2)
        "ocr_engine": ocr.active_engine(),  # cine citește pozele și paginile scanate (pasul 1)
    }


def extract_document(data: bytes, content_type: str) -> ExtractedData:
    """Cei 3 pași, în ordine."""
    # Toată cererea are un buget de timp (time_budget.py). Termenul limită e transmis mai
    # departe fiecărui pas care apelează AI-ul; dacă se depășește, răspundem 504.
    deadline = time_budget.new_deadline()
    document = read_document(data, content_type, deadline)  # 1. textul documentului
    extraction = extract_fields(document.text, deadline)  # 2. MedGemma -> JSON
    verified, warnings = verify_extraction(extraction, document.text)  # 3. reguli fixe

    return ExtractedData(
        **verified.model_dump(),
        dates=find_dates(document.text),  # datele calendaristice: regex, fără AI
        warnings=document.warnings + warnings,
        source=Source(model=medgemma_client.MODEL, input_kind=document.input_kind, pages=document.pages),
    )


# `def` (nu `async def`): FastAPI rulează funcția într-un fir separat, așa că un document
# lent nu blochează serverul. Parametrul `file: bytes = Body(...)` primește body-ul brut.
@app.post("/extract")
def extract(
    file: bytes = Body(default=b"", media_type="application/octet-stream"),
    content_type: str = Header(default=""),
):
    # "image/png; charset=binary" -> "image/png"
    mime_type = content_type.split(";")[0].strip().lower()
    started = time.perf_counter()

    try:
        if len(file) == 0:
            raise ExtractionError(400, "Fișierul este gol")
        if len(file) > MAX_FILE_BYTES:
            raise ExtractionError(413, "Fișierul este prea mare")
        if mime_type not in ("image/jpeg", "image/png", "application/pdf"):
            raise ExtractionError(415, "Content-Type trebuie să fie image/jpeg, image/png sau application/pdf")

        result = extract_document(file, mime_type)
    except ExtractionError as error:
        logger.warning("extract %s -> %d %s", mime_type, error.status_code, error.message)
        return JSONResponse(status_code=error.status_code, content={"error": error.message})

    # În log NU scriem conținutul documentului (date medicale), doar statistici.
    logger.info(
        "extract %s -> 200 in %.1fs: %s, %d pagini, %d medicamente, %d diagnostice, "
        "%d analize, %d date, %d avertismente",
        mime_type, time.perf_counter() - started, result.source.input_kind, result.source.pages,
        len(result.medications), len(result.diagnoses), len(result.lab_results),
        len(result.dates), len(result.warnings),
    )
    return {"extracted_data": result.model_dump()}
