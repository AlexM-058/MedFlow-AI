"""OCR = „imagine -> text”: citim textul dintr-o poză sau dintr-o pagină PDF scanată.

Restul serviciului NU știe cine face asta. `text_source.py` apelează doar
`image_to_text(imagine)` și primește înapoi (text, avertismente).
Cine citește efectiv imaginea („motorul” OCR) se alege din variabila de mediu `OCR_ENGINE`:

  OCR_ENGINE=medgemma   (implicit)  MedGemma, prin Ollama, transcrie textul din imagine

Astăzi există un singur motor. Echipa va adăuga mai târziu un motor OCR dedicat;
mutarea s-a făcut ca atunci să schimbăm DOAR acest fișier.

------------------------------------------------------------------------------------------
CUM ADAUGI UN MOTOR OCR NOU (ex. „tesseract”)
  1. Scrie în acest fișier o funcție cu ACEEAȘI formă ca `medgemma_image_to_text`:
         def tesseract_image_to_text(image: bytes, deadline: float | None) -> tuple[str, list[str]]:
     - `image` = octeții unei imagini PNG sau JPG;
     - întoarce (textul citit, lista de avertismente pentru medic, în română);
     - dacă motorul face un apel lent (rețea, model), timeout-ul lui să fie cel mult
       `time_budget.seconds_left(deadline, <timeout-ul tău>)`;
     - dacă motorul nu e disponibil, aruncă `ExtractionError(503, "<mesaj în română>")`.
  2. Adaugă o intrare în dicționarul ENGINES de mai jos:  "tesseract": tesseract_image_to_text,
  3. Pornește serviciul cu  OCR_ENGINE=tesseract  și adaugă un test în tests/test_ocr.py.
  Nimic altceva nu trebuie schimbat (nici text_source.py, nici main.py).
------------------------------------------------------------------------------------------
"""

import os

import medgemma_client
import time_budget
from errors import ExtractionError

DEFAULT_ENGINE = "medgemma"

TRANSCRIBE_PROMPT = (
    "Transcrie EXACT tot textul din imagine, rând cu rând, în limba în care este scris. "
    "Nu adăuga nimic, nu corecta greșelile, nu traduce, nu explica. "
    "Scrie doar textul din imagine."
)


def medgemma_image_to_text(image: bytes, deadline: float | None) -> tuple[str, list[str]]:
    """Motorul „medgemma”: MedGemma (prin Ollama) primește imaginea și scrie textul din ea."""
    text, truncated = medgemma_client.generate(
        TRANSCRIBE_PROMPT, image=image, max_tokens=2048, deadline=deadline
    )
    warnings = []
    if truncated:
        warnings.append("Transcrierea imaginii a fost întreruptă: o parte din text poate lipsi.")
    return text, warnings


# Numele din OCR_ENGINE -> funcția care face OCR. Un motor nou = o intrare nouă aici.
ENGINES = {
    "medgemma": medgemma_image_to_text,
}


def active_engine() -> str:
    """Numele motorului ales, ex. "medgemma".

    Citim variabila de mediu la fiecare apel (nu o singură dată, la pornire), ca testele
    s-o poată schimba ușor și ca GET /health să arate mereu valoarea folosită de fapt.
    """
    return os.environ.get("OCR_ENGINE", DEFAULT_ENGINE).strip().lower()


def image_to_text(image: bytes, deadline: float | None = None) -> tuple[str, list[str]]:
    """Întoarce (textul din imagine, avertismente), folosind motorul din OCR_ENGINE."""
    name = active_engine()
    engine = ENGINES.get(name)
    if engine is None:
        # Nume greșit în configurare. Nu oprim tot serviciul: PDF-urile cu text nu au nevoie
        # de OCR și merg în continuare. Doar pozele și paginile scanate primesc 503.
        known = ", ".join(ENGINES)
        raise ExtractionError(503, f"Motorul OCR „{name}” nu există (OCR_ENGINE). Valori posibile: {known}")

    # Verificăm bugetul de timp înainte de OCR, oricare ar fi motorul (504 dacă s-a terminat).
    time_budget.check_time_left(deadline)
    return engine(image, deadline)
