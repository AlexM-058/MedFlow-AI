"""Forma datelor extrase dintr-un document medical.

Toate valorile sunt TEXT (str), copiate exact cum apar în document.
De ce text și nu număr? Pentru că documentele românești scriu „13,5” (cu virgulă),
„< 200” sau „negativ”. Dacă le transformăm în numere, schimbăm ce scrie în document.

`None` (în JSON: null) = informația nu apare în document. Nu o ghicim.
"""

from typing import Literal

from pydantic import BaseModel


class Medication(BaseModel):
    name: str | None  # ex. "Amlodipină"
    dose: str | None  # cantitatea de substanță, ex. "5 mg"
    frequency: str | None  # cât de des, ex. "1 cp/zi"
    duration: str | None  # cât timp, ex. "7 zile"


class LabResult(BaseModel):
    test: str | None  # ex. "Hemoglobină"
    value: str | None  # ex. "13,5"
    unit: str | None  # ex. "g/dL"
    reference_range: str | None  # ex. "12 - 16"


class Observation(BaseModel):
    """O altă informație medicală din document: semn vital, simptom, procedură, recomandare, antecedent.
    Nu medicament, diagnostic sau analiză (acelea au câmpurile lor) și NICIODATĂ date de identificare."""

    label: str | None  # ex. "Tensiune arterială"
    value: str | None  # ex. "130/80 mmHg"


class DocumentDate(BaseModel):
    label: str | None  # ex. "Data recoltării"
    value: str | None  # ex. "14.03.2025"


class ModelExtraction(BaseModel):
    """Ce îi cerem lui MedGemma. Schema JSON a acestei clase e impusă modelului,
    deci răspunsul lui are mereu listele cerute (eventual goale).
    Datele calendaristice NU i le cerem: le găsim cu reguli fixe (dates.py)."""

    medications: list[Medication]
    diagnoses: list[str]
    lab_results: list[LabResult]
    # Au valoare implicită [] ca să rămână valid și un răspuns fără ele (versiuni mai vechi, teste).
    allergies: list[str] = []
    observations: list[Observation] = []


class Source(BaseModel):
    """De unde vin datele: util medicului ca să știe cât să aibă încredere în ele."""

    model: str  # ex. "medgemma1.5:4b"
    input_kind: Literal["image", "pdf_text", "pdf_scan"]
    pages: int  # câte pagini am citit


class ExtractedData(ModelExtraction):
    """Ce trimitem înapoi Backend-ului în `extracted_data`:
    datele VERIFICATE + datele calendaristice + avertismentele + sursa."""

    dates: list[DocumentDate]
    warnings: list[str]
    source: Source
