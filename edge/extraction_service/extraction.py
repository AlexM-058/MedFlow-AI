"""Pasul 2: din textul documentului, MedGemma scoate câmpurile medicale în JSON."""

from pydantic import ValidationError

import medgemma_client
from errors import ExtractionError
from schemas import ModelExtraction

# Schema JSON generată din clasa ModelExtraction. Ollama o impune modelului:
# răspunsul are MEREU toate câmpurile, chiar dacă sunt null sau liste goale.
EXTRACTION_SCHEMA = ModelExtraction.model_json_schema()

EXTRACTION_PROMPT = """Extrage informațiile din documentul medical de mai jos (limba română).

Reguli:
- Copiază fiecare valoare EXACT cum apare în text (aceleași cuvinte, cifre, virgule).
- Dacă o informație nu apare în text, pune null. NU inventa, NU deduce, NU completa.
- "medications": medicamentele din document (din rețetă sau din recomandări).
  - "dose" = cantitatea de substanță, cu unitate de măsură (mg, ml, UI...).
    NU pune aici numărul de comprimate și nici cât de des se iau.
  - "frequency" = cât de des sau când se ia medicamentul.
  - "duration" = cât timp se ia.
- "diagnoses": DOAR diagnosticele scrise explicit ca diagnostic în document
  (de obicei după cuvântul "Diagnostic"). Simptomele și motivul pentru care a venit
  pacientul NU sunt diagnostice: nu le pune aici. Nu pune un diagnostic dedus din medicamente.
- "lab_results": analizele de laborator: "test" (numele analizei), "value", "unit",
  "reference_range" (intervalul de referință / valorile normale).
- Dacă documentul nu are o categorie (ex. o rețetă nu are analize), lasă lista goală [].

DOCUMENT:
{document}"""


def extract_fields(document_text: str, deadline: float | None = None) -> ModelExtraction:
    """deadline = termenul limită al cererii (vezi time_budget.py); None = fără buget."""
    prompt = EXTRACTION_PROMPT.replace("{document}", document_text)
    raw, truncated = medgemma_client.generate(
        prompt, json_schema=EXTRACTION_SCHEMA, max_tokens=2048, deadline=deadline
    )
    if truncated:
        raise ExtractionError(502, "Răspunsul MedGemma a fost întrerupt înainte să se termine")
    try:
        return ModelExtraction.model_validate_json(raw)
    except ValidationError:
        raise ExtractionError(502, "MedGemma a întors un JSON care nu respectă schema")
