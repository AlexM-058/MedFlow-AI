"""Citirea textului tipărit dintr-o imagine (OCR clasic), cu scor de încredere.

Motorul e opțional: dacă Tesseract nu e instalat, `get_engine()` întoarce None și
serviciul folosește transcrierea MedGemma, ca înainte. Motorul stă în spatele interfeței
`OcrEngine`, ca schimbarea lui (de ex. cu RapidOCR) să nu atingă restul codului.

Variabile de mediu:
  EDGE_OCR=off          dezactivează OCR-ul (rămâne doar MedGemma)
  EDGE_OCR_LANG=ron+eng limbile Tesseract (implicit ron+eng; dacă lipsește `ron`, folosește eng)
"""

import io
import logging
import os
from dataclasses import dataclass
from typing import Protocol

logger = logging.getLogger("extraction_service.ocr")

DEFAULT_LANG = "ron+eng"


@dataclass
class OcrResult:
    text: str
    # Media încrederii pe cuvinte, 0-100. 0 dacă nu s-a găsit niciun cuvânt.
    confidence: float


class OcrEngine(Protocol):
    def read(self, png: bytes) -> OcrResult: ...


class TesseractEngine:
    def __init__(self, pytesseract_module, lang: str):
        self._tesseract = pytesseract_module
        self._lang = lang

    def read(self, png: bytes) -> OcrResult:
        from PIL import Image

        image = Image.open(io.BytesIO(png))
        data = self._tesseract.image_to_data(
            image, lang=self._lang, output_type=self._tesseract.Output.DICT, config="--psm 6"
        )
        words: list[str] = []
        confidences: list[float] = []
        lines: dict[tuple[int, int, int], list[str]] = {}
        for index, word in enumerate(data["text"]):
            word = word.strip()
            confidence = float(data["conf"][index])
            if not word or confidence < 0:  # -1 = element fără text
                continue
            words.append(word)
            confidences.append(confidence)
            key = (data["block_num"][index], data["par_num"][index], data["line_num"][index])
            lines.setdefault(key, []).append(word)
        text = "\n".join(" ".join(line) for line in lines.values())
        mean = sum(confidences) / len(confidences) if confidences else 0.0
        return OcrResult(text=text, confidence=mean)


_engine: OcrEngine | None = None
_detected = False


def get_engine() -> OcrEngine | None:
    """Motorul OCR disponibil sau None. Detectat o singură dată."""
    global _engine, _detected
    if _detected:
        return _engine
    _detected = True
    if os.environ.get("EDGE_OCR", "").strip().lower() == "off":
        logger.info("OCR dezactivat prin EDGE_OCR=off")
        return None
    try:
        import pytesseract

        installed = set(pytesseract.get_languages(config=""))
    except Exception:
        logger.info("Tesseract nu este disponibil: citirea imaginilor rămâne la MedGemma")
        return None

    wanted = os.environ.get("EDGE_OCR_LANG", DEFAULT_LANG)
    usable = [lang for lang in wanted.split("+") if lang in installed]
    if not usable:
        logger.warning("Tesseract nu are limbile %s: OCR dezactivat", wanted)
        return None
    if len(usable) < len(wanted.split("+")):
        logger.warning("Tesseract nu are toate limbile cerute (%s); folosesc %s", wanted, "+".join(usable))
    _engine = TesseractEngine(pytesseract, "+".join(usable))
    return _engine
