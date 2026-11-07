"""OCR = „imagine -> text”: citim textul dintr-o poză sau dintr-o pagină PDF scanată.

Restul serviciului NU știe cine face asta. `text_source.py` apelează doar
`image_to_text(imagine)` și primește înapoi (text, avertismente).
Cine citește efectiv imaginea („motorul” OCR) se alege din variabila de mediu `OCR_ENGINE`:

  OCR_ENGINE=medgemma   (implicit)  MedGemma, prin Ollama, transcrie textul din imagine
  OCR_ENGINE=easyocr                EasyOCR, rulează în acest proces, local, pe GPU
  OCR_ENGINE=tesseract              Tesseract (program instalat pe calculator), pe procesor

Motoarele LOCALE (easyocr, tesseract) măsoară cât de sigură e citirea (scor 0-100):
  - sub OCR_MIN_CONFIDENCE sau text prea scurt -> `OcrUnreliable`: folosim MedGemma, cu avertisment;
  - între OCR_MIN_CONFIDENCE și OCR_WARN_CONFIDENCE -> păstrăm textul, dar avertizăm să se verifice;
  - motorul nu pornește / se strică -> tot MedGemma, cu avertisment.
Nimic nu se aruncă în tăcere (regula 7 din AGENTS.md): orice abatere ajunge ca avertisment la medic.

------------------------------------------------------------------------------------------
CUM ADAUGI UN MOTOR OCR NOU (ex. „rapidocr”)
  1. Scrie în acest fișier o funcție cu ACEEAȘI formă ca `medgemma_image_to_text`:
         def rapidocr_image_to_text(image: bytes, deadline: float | None) -> tuple[str, list[str]]:
     - `image` = octeții unei imagini PNG sau JPG;
     - întoarce (textul citit, lista de avertismente pentru medic, în română);
     - dacă motorul face un apel lent (rețea, model), timeout-ul lui să fie cel mult
       `time_budget.seconds_left(deadline, <timeout-ul tău>)`;
     - dacă motorul nu e disponibil, aruncă `ExtractionError(503, "<mesaj în română>")`.
  2. Adaugă o intrare în dicționarul ENGINES de mai jos:  "rapidocr": rapidocr_image_to_text,
     Dacă motorul e local și dă scor de încredere: folosește `judge_reading(text, scor)` la final
     și adaugă numele în LOCAL_ENGINES (primești automat rezerva MedGemma).
  3. Pornește serviciul cu  OCR_ENGINE=rapidocr  și adaugă un test în tests/test_ocr.py.
  Nimic altceva nu trebuie schimbat (nici text_source.py, nici main.py).
------------------------------------------------------------------------------------------
"""

import io
import logging
import os
import threading

import medgemma_client
import preprocess
import time_budget
from errors import ExtractionError

logger = logging.getLogger("extraction_service.ocr")

DEFAULT_ENGINE = "medgemma"

# Sub acest scor mediu (0-100) nu avem încredere în citirea unui motor local: trecem la MedGemma.
OCR_MIN_CONFIDENCE = 60
# Între cele două praguri păstrăm textul OCR, dar avertizăm să se verifice fiecare valoare.
OCR_WARN_CONFIDENCE = 75
# Sub atâtea caractere citite, considerăm că motorul n-a găsit text real.
OCR_MIN_CHARS = 20


class OcrUnreliable(Exception):
    """Un motor local a citit imaginea, dar rezultatul nu e destul de sigur ca să-l folosim."""


def judge_reading(text: str, confidence: float) -> list[str]:
    """Decide dacă o citire locală e folosibilă. Întoarce avertismentele, sau aruncă OcrUnreliable.

    `confidence` e pe scara 0-100 (media pe cuvinte).
    """
    if len(text.strip()) < OCR_MIN_CHARS:
        raise OcrUnreliable("Citirea OCR a găsit prea puțin text; am folosit transcrierea MedGemma.")
    if confidence < OCR_MIN_CONFIDENCE:
        raise OcrUnreliable("Citirea OCR a avut încredere scăzută; am folosit transcrierea MedGemma.")
    if confidence < OCR_WARN_CONFIDENCE:
        return ["Textul a fost citit cu încredere scăzută: verificați fiecare valoare."]
    return []

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


def group_into_lines(boxes: list) -> tuple[str, float]:
    """Din rezultatul EasyOCR (casete cu text) face rânduri de text și un scor mediu 0-100.

    Fiecare element e (colțuri, text, încredere 0-1). Casetele cu centrul pe aproape aceeași
    înălțime sunt același rând; în rând, de la stânga la dreapta. Așa „Hemoglobina 13,5 g/dL”
    rămâne pe un singur rând, nu se amestecă numele analizei cu valoarea altui rând.
    Scorul e media pe caractere: un cuvânt lung contează mai mult decât unul de o literă.
    """
    items = []
    for corners, text, confidence in boxes:
        text = text.strip()
        if not text:
            continue
        ys = [point[1] for point in corners]
        xs = [point[0] for point in corners]
        items.append({
            "text": text,
            "conf": float(confidence),
            "x": min(xs),
            "y": (min(ys) + max(ys)) / 2,
            "h": max(ys) - min(ys),
        })
    if not items:
        return "", 0.0

    items.sort(key=lambda item: item["y"])
    heights = sorted(item["h"] for item in items)
    tolerance = max(heights[len(heights) // 2] * 0.5, 1.0)  # jumătate din înălțimea tipică a literei
    lines: list[list[dict]] = []
    for item in items:
        if lines and abs(item["y"] - lines[-1][-1]["y"]) <= tolerance:
            lines[-1].append(item)
        else:
            lines.append([item])

    text = "\n".join(" ".join(i["text"] for i in sorted(line, key=lambda i: i["x"])) for line in lines)
    total_chars = sum(len(item["text"]) for item in items)
    score = sum(item["conf"] * len(item["text"]) for item in items) / total_chars * 100
    return text, score


def easyocr_image_to_text(image: bytes, deadline: float | None) -> tuple[str, list[str]]:
    """Motorul „easyocr”: EasyOCR citește textul din imagine, local, pe GPU.

    Atenție la timp: EasyOCR rulează în procesul nostru și nu poate fi oprit la jumătate.
    `image_to_text` verifică bugetul ÎNAINTE de apel; dacă un apel durează prea mult,
    următorul pas (altă pagină sau extragerea) vede că bugetul s-a terminat și răspunde 504.
    """
    with _reader_lock:
        reader = _easyocr_reader()
        # detail=1 -> primim și poziția și scorul de încredere al fiecărei casete de text;
        # paragraph=False -> nu lăsăm EasyOCR să unească casetele în paragrafe (ar putea lipi
        # coloanele unui tabel de analize); rândurile le formăm noi, în `group_into_lines`.
        # EasyOCR primește direct octeții imaginii (PNG sau JPG).
        boxes = reader.readtext(image, detail=1, paragraph=False)
    text, confidence = group_into_lines(boxes)
    return text, judge_reading(text, confidence)


# ---------------------------------------------------------------------------------------
# Motorul „tesseract”: programul Tesseract, instalat pe calculator (pe procesor), prin
# pytesseract. Imaginea e pregătită întâi (contrast, claritate, mărime) de preprocess.py.
# ---------------------------------------------------------------------------------------

# Limbile Tesseract; datele `ron` și `eng` se instalează odată cu programul.
# Dacă lipsește `ron`, folosim ce există și avertizăm în jurnal.
TESSERACT_LANG = os.environ.get("TESSERACT_LANG", "ron+eng").strip()

_tesseract_lang: str | None = None


def _tesseract_ready():
    """Întoarce (pytesseract, limbile folosibile). Limbile se verifică o singură dată."""
    global _tesseract_lang
    try:
        import pytesseract
    except ImportError:
        raise ExtractionError(503, "pytesseract nu e instalat (pip install -r requirements.txt)")

    if _tesseract_lang is None:
        try:
            installed = set(pytesseract.get_languages(config=""))
        except Exception:
            raise ExtractionError(503, "Programul Tesseract nu e instalat pe acest calculator")
        wanted = [lang for lang in TESSERACT_LANG.split("+") if lang]
        usable = [lang for lang in wanted if lang in installed]
        if not usable:
            raise ExtractionError(503, f"Tesseract nu are limbile cerute ({TESSERACT_LANG})")
        if len(usable) < len(wanted):
            logger.warning("Tesseract nu are toate limbile cerute (%s); folosesc %s", TESSERACT_LANG, "+".join(usable))
        _tesseract_lang = "+".join(usable)
    return pytesseract, _tesseract_lang


def tesseract_image_to_text(image: bytes, deadline: float | None) -> tuple[str, list[str]]:
    """Motorul „tesseract”: Tesseract citește imaginea îmbunătățită, cu scor de încredere."""
    from PIL import Image

    tesseract, lang = _tesseract_ready()
    enhanced = preprocess.enhance_for_ocr(image)  # 422 dacă imaginea e deteriorată
    data = tesseract.image_to_data(
        Image.open(io.BytesIO(enhanced)), lang=lang, output_type=tesseract.Output.DICT, config="--psm 6"
    )
    lines: dict[tuple[int, int, int], list[str]] = {}
    confidences: list[float] = []
    for index, word in enumerate(data["text"]):
        word = word.strip()
        confidence = float(data["conf"][index])
        if not word or confidence < 0:  # -1 = element fără text
            continue
        confidences.append(confidence)
        key = (data["block_num"][index], data["par_num"][index], data["line_num"][index])
        lines.setdefault(key, []).append(word)
    text = "\n".join(" ".join(words) for words in lines.values())
    mean = sum(confidences) / len(confidences) if confidences else 0.0
    return text, judge_reading(text, mean)


# Numele din OCR_ENGINE -> funcția care face OCR. Un motor nou = o intrare nouă aici.
ENGINES = {
    "medgemma": medgemma_image_to_text,
    "easyocr": easyocr_image_to_text,
    "tesseract": tesseract_image_to_text,
}

# Motoarele locale: pot da rezultate nesigure sau pot lipsi, deci au rezervă MedGemma.
# (MedGemma însuși nu are rezervă: dacă el pică, cererea pică.)
LOCAL_ENGINES = {"easyocr", "tesseract"}


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
    if name not in LOCAL_ENGINES:
        return engine(image, deadline)

    try:
        return engine(image, deadline)
    except OcrUnreliable as unreliable:
        warning = str(unreliable)
    except ExtractionError as error:
        if error.status_code != 503:  # 422 (imagine deteriorată) și 504 (timp) ajung la utilizator
            raise
        logger.warning("Motorul OCR %s nu e disponibil (%s); folosesc MedGemma", name, error.message)
        warning = f"Motorul OCR „{name}” nu e disponibil; am folosit transcrierea MedGemma."
    except Exception:
        logger.exception("Motorul OCR %s a eșuat; folosesc MedGemma", name)
        warning = "Citirea OCR a eșuat; am folosit transcrierea MedGemma."

    # MedGemma primește imaginea ORIGINALĂ, nu pe cea îmbunătățită pentru OCR.
    text, medgemma_warnings = medgemma_image_to_text(image, deadline)
    return text, [warning, *medgemma_warnings]
