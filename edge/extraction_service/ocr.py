"""OCR = „imagine -> text”: citim textul dintr-o poză sau dintr-o pagină PDF scanată.

Restul serviciului NU știe cine face asta. `text_source.py` apelează doar
`image_to_text(imagine)` și primește înapoi (text, avertismente).
Cine citește efectiv imaginea („motorul” OCR) se alege din variabila de mediu `OCR_ENGINE`:

  OCR_ENGINE=medgemma   (implicit)  MedGemma, prin Ollama, transcrie textul din imagine
  OCR_ENGINE=easyocr                EasyOCR, rulează în acest proces, local, pe GPU

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
import threading

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


# ---------------------------------------------------------------------------------------
# Motorul „easyocr”: EasyOCR rulează AICI, în procesul serviciului, pe GPU-ul local.
# Nu e un server separat (ca Ollama), deci nu facem cereri HTTP: apelăm direct biblioteca.
# ---------------------------------------------------------------------------------------

# Limbile documentelor: română + engleză (aceleași ca în restul proiectului).
EASYOCR_LANGUAGES = ["ro", "en"]
# "true" = rulăm pe GPU. Dacă nu există GPU (CUDA), EasyOCR trece singur pe procesor (mai lent).
EASYOCR_GPU = os.environ.get("EASYOCR_GPU", "true").strip().lower() == "true"
# Folderul cu fișierele modelului. Gol = folderul implicit EasyOCR (~/.EasyOCR/model).
# La PRIMA pornire EasyOCR descarcă modelele de pe internet (doar modelele, nu documente);
# după aceea merge complet offline.
EASYOCR_MODEL_DIR = os.environ.get("EASYOCR_MODEL_DIR") or None

# „Cititorul” EasyOCR încarcă modelele în memoria GPU-ului: durează câteva secunde.
# Îl creăm O SINGURĂ DATĂ, la prima imagine, și îl refolosim la toate cererile următoare.
_reader = None
# Un singur GPU -> o singură imagine odată. Lacătul face ca două cereri simultane să aștepte
# una după alta, în loc să folosească GPU-ul în același timp (ar putea rămâne fără memorie).
_reader_lock = threading.Lock()


def _easyocr_reader():
    """Întoarce cititorul EasyOCR, creându-l la primul apel."""
    global _reader
    if _reader is None:
        try:
            # Importăm aici, nu sus în fișier: cine folosește OCR_ENGINE=medgemma nu are nevoie
            # de EasyOCR instalat (și nici testele).
            import easyocr
        except ImportError:
            raise ExtractionError(503, "EasyOCR nu e instalat (pip install -r requirements.txt)")
        try:
            _reader = easyocr.Reader(
                EASYOCR_LANGUAGES, gpu=EASYOCR_GPU, model_storage_directory=EASYOCR_MODEL_DIR
            )
        except Exception:
            # Ex. modelele lipsesc și nu există internet, sau GPU-ul nu poate fi folosit.
            raise ExtractionError(503, "EasyOCR nu a putut porni (modelele lipsesc sau GPU indisponibil)")
    return _reader


def easyocr_image_to_text(image: bytes, deadline: float | None) -> tuple[str, list[str]]:
    """Motorul „easyocr”: EasyOCR citește textul din imagine, local, pe GPU.

    Atenție la timp: EasyOCR rulează în procesul nostru și nu poate fi oprit la jumătate.
    `image_to_text` verifică bugetul ÎNAINTE de apel; dacă un apel durează prea mult,
    următorul pas (altă pagină sau extragerea) vede că bugetul s-a terminat și răspunde 504.
    """
    with _reader_lock:
        reader = _easyocr_reader()
        # detail=0  -> primim doar textele (fără coordonate și scor de încredere);
        # paragraph=True -> EasyOCR unește cuvintele apropiate în rânduri / paragrafe.
        # EasyOCR primește direct octeții imaginii (PNG sau JPG).
        lines = reader.readtext(image, detail=0, paragraph=True)
    return "\n".join(lines), []


# Numele din OCR_ENGINE -> funcția care face OCR. Un motor nou = o intrare nouă aici.
ENGINES = {
    "medgemma": medgemma_image_to_text,
    "easyocr": easyocr_image_to_text,
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
