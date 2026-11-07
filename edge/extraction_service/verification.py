"""Pasul 3: verificăm cu reguli FIXE (fără AI) ce a extras MedGemma.

Răspunsul modelului e o dată nesigură. Două reguli:
  1. Orice valoare trebuie să apară în textul documentului. Altfel e inventată -> null.
  2. O doză trebuie să aibă număr + unitate („5 mg”). Altfel e în câmpul greșit -> null.

Fiecare valoare ștearsă primește un avertisment, ca medicul să știe ce să verifice.
Dacă lipsește „identitatea” unui element (numele medicamentului, numele analizei),
tot elementul e eliminat: o doză fără medicament nu ajută pe nimeni.
"""

import re
import unicodedata

from schemas import LabResult, Medication, ModelExtraction, Observation

# Număr (cu virgulă sau punct) + unitate de măsură. (?![a-z]) = după unitate nu urmează
# altă literă, ca „5 g” să fie doză, dar „5 gr...” nu.
DOSE_PATTERN = re.compile(
    r"\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|μg|g|ml|ui|u\.i\.|%|mmol|meq)(?![a-z])",
    re.IGNORECASE,
)


# Cum e marcat un diagnostic în documentele românești: „Diagnostic:”, „Diagnostice”, „Dg.”, „Diag.”
# \b = început/sfârșit de cuvânt, ca „dg” să nu se potrivească în mijlocul altui cuvânt.
DIAGNOSIS_LABEL = re.compile(r"\bdiagnostic|\bdiag\.|\bdg\b", re.IGNORECASE)


# Caractere care arată ca o liniuță. Textul scos din PDF-uri le folosește des în loc de „-”
# (ex. „12 \u00ad 16” cu soft hyphen U+00AD), iar modelul scrie de obicei „-” simplu.
DASHES = re.compile("[\u00ad\u2010\u2011\u2012\u2013\u2014\u2212]")


def normalize(text: str) -> str:
    """„Amlodipină 5 mg” -> „amlodipina5mg”.

    Litere mici, fără diacritice, fără spații, un singur fel de liniuță.
    Așa „5mg” și „5 mg” sunt la fel, iar „ș” cu virgulă și „\u015f” cu sedilă devin „s”.
    """
    # NFKD desparte „ă” în „a” + semnul de deasupra; apoi aruncăm semnele (combining).
    decomposed = unicodedata.normalize("NFKD", text.lower())
    without_marks = "".join(c for c in decomposed if not unicodedata.combining(c))
    one_dash = DASHES.sub("-", without_marks)
    return re.sub(r"\s+", "", one_dash)


def looks_like_dose(value: str) -> bool:
    return DOSE_PATTERN.search(value) is not None


# Datele de identificare NU sunt informații medicale și nu le extragem niciodată (confidențialitate, GDPR):
# nici dacă modelul le-ar scoate, nici dacă apar în document. Se verifică pe eticheta normalizată și pe valoare.
IDENTITY_LABEL_PREFIXES = (
    "nume", "prenume", "pacient", "adres", "domiciliu", "telefon", "email", "cnp", "serie", "legitimatie",
    "semnatur", "parafa", "localitate", "judet", "strada",
)
IDENTITY_LABELS_EXACT = {"medic", "medicul", "doctor", "doctorul", "dr", "medicprescriptor", "medictratant", "asigurat"}
IDENTIFIER_VALUE = re.compile(
    r"(?<!\d)[1-9]\d{12}(?!\d)"  # CNP: 13 cifre
    r"|[\w.+-]+@[\w-]+\.[\w.-]+"  # email
    r"|(?<![\d+])(?:\+40|0040|0)[\s.-]?[237](?:[\s.-]?\d){8}(?!\d)"  # telefon românesc
    r"|\bRO\d{2}\s?[A-Z]{4}(?:\s?[A-Z0-9]){16}",  # IBAN românesc
    re.IGNORECASE,
)


def looks_like_identity(label: str | None, value: str | None) -> bool:
    key = normalize(label or "")
    if key in IDENTITY_LABELS_EXACT or key.startswith(IDENTITY_LABEL_PREFIXES):
        return True
    return any(IDENTIFIER_VALUE.search(text) for text in (label, value) if text)


def verify_extraction(
    extraction: ModelExtraction, source_text: str
) -> tuple[ModelExtraction, list[str]]:
    """Întoarce (datele curățate, lista de avertismente)."""
    source = normalize(source_text)
    warnings: list[str] = []

    def clean(value: str | None) -> str | None:
        """Text gol sau doar spații -> None."""
        if value is None or value.strip() == "":
            return None
        return value.strip()

    def in_text(value: str | None) -> bool:
        return value is not None and normalize(value) in source

    def check(value: str | None, description: str) -> str | None:
        """Regula 1 pentru un câmp: îl păstrăm doar dacă apare în text."""
        value = clean(value)
        if value is None or in_text(value):
            return value
        warnings.append(f"{description}: «{value}» nu apare în document (valoare ștearsă).")
        return None

    # --- Medicamente ---
    medications: list[Medication] = []
    for item in extraction.medications:
        name = clean(item.name)
        if not in_text(name):
            if any(clean(v) for v in (item.name, item.dose, item.frequency, item.duration)):
                warnings.append(removed_item_warning("Medicament", name))
            continue

        dose = check(item.dose, f"Doza pentru {name}")
        if dose is not None and not looks_like_dose(dose):
            warnings.append(
                f"Doza pentru {name}: «{dose}» nu are număr + unitate, ex. „5 mg” (valoare ștearsă)."
            )
            dose = None

        medications.append(
            Medication(
                name=name,
                dose=dose,
                frequency=check(item.frequency, f"Frecvența pentru {name}"),
                duration=check(item.duration, f"Durata pentru {name}"),
            )
        )

    # --- Diagnostice ---
    # Fără câmp „Diagnostic” în document, orice „diagnostic” vine de la AI (ex. un simptom
    # transformat în diagnostic). AI-ul nu are voie să diagnosticheze -> le scoatem pe toate.
    has_diagnosis_field = DIAGNOSIS_LABEL.search(source_text) is not None
    diagnoses: list[str] = []
    for diagnosis in extraction.diagnoses:
        kept = check(diagnosis, "Diagnosticul")
        if kept is not None and not has_diagnosis_field:
            warnings.append(
                f"Diagnosticul: «{kept}» a fost scos: documentul nu are un câmp „Diagnostic”."
            )
            kept = None
        if kept is not None:
            diagnoses.append(kept)

    # --- Analize ---
    lab_results: list[LabResult] = []
    for item in extraction.lab_results:
        test = clean(item.test)
        if not in_text(test):
            if any(clean(v) for v in (item.test, item.value, item.unit, item.reference_range)):
                warnings.append(removed_item_warning("Analiză", test))
            continue
        lab_results.append(
            LabResult(
                test=test,
                value=check(item.value, f"Valoarea pentru {test}"),
                unit=check(item.unit, f"Unitatea pentru {test}"),
                reference_range=check(item.reference_range, f"Intervalul de referință pentru {test}"),
            )
        )

    # --- Alergii: textul trebuie să apară în document (regula 1), fără date de identificare ---
    allergies: list[str] = []
    for allergy in extraction.allergies:
        kept = check(allergy, "Alergia")
        if kept is not None and looks_like_identity(None, kept):
            warnings.append("Alergia: o valoare care seamănă cu un identificator a fost scoasă.")
            kept = None
        if kept is not None:
            allergies.append(kept)

    # --- Alte informații medicale: și eticheta, și valoarea trebuie să apară în document ---
    observations: list[Observation] = []
    for item in extraction.observations:
        label, value = clean(item.label), clean(item.value)
        if label is None or value is None:
            if label is not None or value is not None:
                warnings.append(f"Observație eliminată: lipsește {'valoarea' if value is None else 'eticheta'} pentru «{label or value}».")
            continue
        if looks_like_identity(label, value):
            warnings.append("Observație eliminată: pare o dată de identificare, care nu se extrage.")
            continue
        if not in_text(label) or not in_text(value):
            warnings.append(f"Observație eliminată: «{label}: {value}» nu apare în document.")
            continue
        observations.append(Observation(label=label, value=value))

    verified = ModelExtraction(
        medications=remove_duplicates(medications),
        diagnoses=remove_duplicates(diagnoses),
        lab_results=remove_duplicates(lab_results),
        allergies=remove_duplicates(allergies),
        observations=remove_duplicates(observations),
    )
    return verified, remove_duplicates(warnings)


def removed_item_warning(kind: str, name: str | None) -> str:
    if name is None:
        return f"{kind} eliminat(ă): lipsește numele."
    return f"{kind} eliminat(ă): numele «{name}» nu apare în document."


def remove_duplicates(items: list) -> list:
    """Păstrează ordinea; un element identic apare o singură dată.
    (Uneori modelul repetă același rând de mai multe ori.)"""
    result = []
    for item in items:
        if item not in result:
            result.append(item)
    return result
