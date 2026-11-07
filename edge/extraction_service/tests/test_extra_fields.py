"""Alergii și alte informații medicale (observații): verificate în text, fără date de identificare."""

from schemas import ModelExtraction, Observation
from verification import looks_like_identity, verify_extraction

SCRISOARE = """SCRISOARE MEDICALĂ (fictiv)
Pacient: Ionescu Maria, CNP 2850101223344, tel 0722 123 456
Alergic la penicilină.
Tensiune arterială: 130/80 mmHg
Puls: 72 bătăi/min
Recomandări: repaus 3 zile, hidratare
Interventie chirurgicala: apendicectomie în 2015"""


def run(allergies=(), observations=()):
    extraction = ModelExtraction(
        medications=[], diagnoses=[], lab_results=[],
        allergies=list(allergies), observations=[Observation(label=l, value=v) for l, v in observations],
    )
    verified, warnings = verify_extraction(extraction, SCRISOARE)
    return verified, warnings


def test_vital_signs_symptoms_and_recommendations_are_kept_when_they_are_in_the_text():
    verified, warnings = run(observations=[
        ("Tensiune arterială", "130/80 mmHg"),
        ("Puls", "72 bătăi/min"),
        ("Recomandări", "repaus 3 zile, hidratare"),
    ])
    assert [(o.label, o.value) for o in verified.observations] == [
        ("Tensiune arterială", "130/80 mmHg"), ("Puls", "72 bătăi/min"), ("Recomandări", "repaus 3 zile, hidratare"),
    ]
    assert warnings == []


def test_an_invented_observation_is_removed_with_a_warning():
    verified, warnings = run(observations=[("Temperatură", "38,5 °C"), ("Puls", "72 bătăi/min")])
    assert [o.label for o in verified.observations] == ["Puls"]
    assert any("Temperatură" in warning and "nu apare" in warning for warning in warnings)


def test_a_real_label_with_a_made_up_value_is_removed():
    verified, warnings = run(observations=[("Puls", "110 bătăi/min")])
    assert verified.observations == []
    assert warnings


def test_an_observation_missing_its_label_or_value_is_removed():
    verified, warnings = run(observations=[("Puls", None), (None, "130/80 mmHg")])
    assert verified.observations == []
    assert len(warnings) == 2


def test_identity_data_is_never_extracted_even_if_it_is_in_the_text():
    verified, warnings = run(observations=[
        ("Pacient", "Ionescu Maria"),  # label is an identity label
        ("Nume", "Ionescu Maria"),
        ("CNP", "2850101223344"),
        ("Contact", "tel 0722 123 456"),  # value looks like a phone number
        ("Puls", "72 bătăi/min"),
    ])
    assert [o.label for o in verified.observations] == ["Puls"]
    # identical warnings are merged into one, so the doctor is not shown the same line four times
    assert any("identificare" in w for w in warnings)
    assert "Ionescu" not in str(verified.model_dump())
    assert "2850101223344" not in str(verified.model_dump())


def test_allergies_must_be_in_the_text_and_cannot_be_identifiers():
    verified, warnings = run(allergies=["penicilină", "latex", "2850101223344"])
    assert verified.allergies == ["penicilină"]  # latex is invented; the CNP is not an allergy
    assert any("latex" in warning for warning in warnings)
    assert any("identificator" in warning for warning in warnings)


def test_a_medicine_called_medicatie_is_not_mistaken_for_the_doctor():
    assert not looks_like_identity("Medicație", "paracetamol")
    assert not looks_like_identity("Recomandări", "repaus")
    assert looks_like_identity("Medic", "Dr. Popescu")
    assert looks_like_identity("Numele pacientului", "x")
    assert looks_like_identity("Altceva", "contact@example.com")


def test_duplicates_are_removed():
    verified, _ = run(allergies=["penicilină", "penicilină"], observations=[("Puls", "72 bătăi/min"), ("Puls", "72 bătăi/min")])
    assert verified.allergies == ["penicilină"] and len(verified.observations) == 1


def test_a_response_without_the_new_fields_is_still_valid():
    parsed = ModelExtraction.model_validate_json('{"medications": [], "diagnoses": [], "lab_results": []}')
    assert parsed.allergies == [] and parsed.observations == []
