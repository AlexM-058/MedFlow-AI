"""Regulile fixe (fără AI) care verifică ce a extras MedGemma."""

from schemas import LabResult, Medication, ModelExtraction
from verification import looks_like_dose, verify_extraction

RETETA = """REȚETĂ MEDICALĂ (fictiv)
Data: 14.03.2025
Diagnostic: Hipertensiune arterială esențială
Rp/
1. Amlodipin 5 mg - 1 cp/zi, dimineața
2. Metformin - 2 cp/zi, timp de 30 de zile"""


def extraction(medications=(), diagnoses=(), lab_results=()):
    return ModelExtraction(
        medications=list(medications), diagnoses=list(diagnoses), lab_results=list(lab_results)
    )


def med(name, dose=None, frequency=None, duration=None):
    return Medication(name=name, dose=dose, frequency=frequency, duration=duration)


# --- Medicamente ---------------------------------------------------------------


def test_correct_medication_is_kept_unchanged():
    result, warnings = verify_extraction(
        extraction(medications=[med("Amlodipin", "5 mg", "1 cp/zi")]), RETETA
    )
    assert result.medications == [med("Amlodipin", "5 mg", "1 cp/zi")]
    assert warnings == []


def test_value_from_text_in_dose_field_without_unit_becomes_null():
    # Greșeala reală a lui MedGemma din test: frecvența pusă și la doză.
    result, warnings = verify_extraction(
        extraction(medications=[med("Metformin", "2 cp/zi", "2 cp/zi")]), RETETA
    )
    assert result.medications == [med("Metformin", None, "2 cp/zi")]
    assert len(warnings) == 1
    assert "2 cp/zi" in warnings[0]


def test_invented_dose_becomes_null():
    result, warnings = verify_extraction(
        extraction(medications=[med("Metformin", "1000 mg")]), RETETA
    )
    assert result.medications == [med("Metformin", None)]
    assert "1000 mg" in warnings[0]


def test_medication_whose_name_is_not_in_text_is_removed():
    result, warnings = verify_extraction(
        extraction(medications=[med("Paracetamol", "500 mg")]), RETETA
    )
    assert result.medications == []
    assert "Paracetamol" in warnings[0]


def test_medication_without_name_is_removed():
    result, warnings = verify_extraction(
        extraction(medications=[med(None, "5 mg")]), RETETA
    )
    assert result.medications == []
    assert len(warnings) == 1


def test_completely_empty_medication_is_removed_silently():
    result, warnings = verify_extraction(extraction(medications=[med(None)]), RETETA)
    assert result.medications == []
    assert warnings == []


def test_every_secondary_field_is_checked_against_text():
    result, warnings = verify_extraction(
        extraction(medications=[med("Metformin", None, "3 cp/zi", "30 de zile")]), RETETA
    )
    assert result.medications == [med("Metformin", None, None, "30 de zile")]
    assert "3 cp/zi" in warnings[0]


def test_empty_string_becomes_null_without_warning():
    result, warnings = verify_extraction(
        extraction(medications=[med("Amlodipin", "", " ")]), RETETA
    )
    assert result.medications == [med("Amlodipin", None, None)]
    assert warnings == []


def test_duplicate_medications_are_kept_once():
    same = med("Amlodipin", "5 mg", "1 cp/zi")
    result, _ = verify_extraction(extraction(medications=[same, same, same]), RETETA)
    assert result.medications == [same]


# --- Compararea cu textul --------------------------------------------------------


def test_comparison_ignores_case_spaces_and_diacritics():
    text = "AMLODIPINĂ 5mg"
    result, warnings = verify_extraction(
        extraction(medications=[med("amlodipina", "5 mg")]), text
    )
    assert result.medications == [med("amlodipina", "5 mg")]
    assert warnings == []


def test_both_romanian_s_variants_are_the_same_letter():
    # „ș” cu virgulă (U+0219) și „\u015f” cu sedilă (U+015F) arată la fel, dar sunt caractere diferite.
    text = "Diagnostic: Insuficiență cardiacă, șoc"
    result, warnings = verify_extraction(
        extraction(diagnoses=["Insuficien\u0163ă cardiacă, \u015foc"]), text
    )
    assert len(result.diagnoses) == 1
    assert warnings == []


def test_all_kinds_of_dashes_are_the_same_dash():
    # Textul scos din PDF poate avea „soft hyphen” (U+00AD) sau „\u2013” (en dash) în loc de „-”.
    for dash in ["\u00ad", "\u2013", "\u2212", "\u2010"]:
        text = f"Hemoglobină 13,5 g/dL 12 {dash} 16"
        result, warnings = verify_extraction(
            extraction(lab_results=[LabResult(test="Hemoglobină", value="13,5", unit="g/dL", reference_range="12 - 16")]),
            text,
        )
        assert result.lab_results[0].reference_range == "12 - 16", repr(dash)
        assert warnings == []


def test_model_correcting_a_word_loses_the_value():
    # Prețul regulii stricte: textul are „Amlodipin”, modelul scrie „Amlodipină”.
    result, warnings = verify_extraction(
        extraction(medications=[med("Amlodipină", "5 mg")]), RETETA
    )
    assert result.medications == []
    assert "Amlodipină" in warnings[0]


# --- Diagnostice, analize, date ---------------------------------------------------


def test_diagnosis_not_in_text_is_removed():
    result, warnings = verify_extraction(
        extraction(diagnoses=["Hipertensiune arterială esențială", "Diabet zaharat tip 2"]),
        RETETA,
    )
    assert result.diagnoses == ["Hipertensiune arterială esențială"]
    assert "Diabet zaharat tip 2" in warnings[0]


def test_diagnoses_are_removed_when_document_has_no_diagnosis_field():
    # Un simptom („dureri lombare”) nu e diagnostic. Dacă documentul nu scrie nicăieri
    # „Diagnostic” sau „Dg.”, AI-ul nu are voie să pună diagnostice.
    text = "Pacientul se prezintă pentru dureri lombare.\nRecomandări: Ibuprofen, la nevoie"
    result, warnings = verify_extraction(extraction(diagnoses=["dureri lombare"]), text)
    assert result.diagnoses == []
    assert "dureri lombare" in warnings[0]


def test_short_diagnosis_label_is_recognized():
    result, warnings = verify_extraction(extraction(diagnoses=["Faringită acută"]), "Dg.: Faringită acută")
    assert result.diagnoses == ["Faringită acută"]
    assert warnings == []


def test_lab_result_fields_are_checked_one_by_one():
    text = "Hemoglobină 13,5 g/dL (12 - 16)"
    result, warnings = verify_extraction(
        extraction(lab_results=[LabResult(test="Hemoglobină", value="13.5", unit="g/dL", reference_range="12 - 16")]),
        text,
    )
    # „13.5” (cu punct) nu apare în text, unde scrie „13,5” (cu virgulă).
    assert result.lab_results == [
        LabResult(test="Hemoglobină", value=None, unit="g/dL", reference_range="12 - 16")
    ]
    assert "13.5" in warnings[0]


def test_lab_result_whose_test_name_is_not_in_text_is_removed():
    result, warnings = verify_extraction(
        extraction(lab_results=[LabResult(test="Glicemie", value="92", unit="mg/dL", reference_range=None)]),
        "Hemoglobină 13,5 g/dL",
    )
    assert result.lab_results == []
    assert "Glicemie" in warnings[0]


# --- Ce arată ca o doză -----------------------------------------------------------


def test_looks_like_dose():
    for dose in ["5 mg", "500mg", "1000 UI", "10 ml", "0,5 mg", "2,5 g", "1 %", "20 mcg", "5 mg/ml"]:
        assert looks_like_dose(dose), dose
    for not_dose in ["2 cp/zi", "1 cp", "dimineața", "mg", "o fiolă", "1 plic"]:
        assert not looks_like_dose(not_dose), not_dose
