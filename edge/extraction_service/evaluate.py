"""Testează serviciul REAL (MedGemma din Ollama) pe documentele fictive din fixtures/.

Pentru fiecare document <nume>.txt există:
  - fixtures/<nume>.expected.json   ce ar trebui să extragă serviciul
  - fixtures/generated/<nume>.pdf, <nume>_scan.pdf, <nume>.png, <nume>.jpg

Nu e un test pytest: e lent (un apel AI durează secunde) și modelul nu e 100% previzibil.
Îl rulăm manual după ce schimbăm prompturile sau modelul.

Rulare (din folderul extraction_service, cu Ollama pornit):
  .venv\\Scripts\\python evaluate.py              toate documentele
  .venv\\Scripts\\python evaluate.py reteta       doar cele care conțin „reteta” în nume
"""

import json
import pathlib
import sys
import time

from errors import ExtractionError
from main import extract_document
from verification import normalize

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
FORMATS = [
    ("pdf", ".pdf", "application/pdf"),
    ("scan", "_scan.pdf", "application/pdf"),
    ("png", ".png", "image/png"),
    ("jpg", ".jpg", "image/jpeg"),
]


def same(a: str | None, b: str | None) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return normalize(a) == normalize(b)


def overlaps(a: str | None, b: str | None) -> bool:
    """„Hipertensiune arterială esențială” se potrivește cu „Hipertensiune arterială esențială (I10)”."""
    if a is None or b is None:
        return a is None and b is None
    a, b = normalize(a), normalize(b)
    return a in b or b in a


def find(items: list[dict], key: str, wanted: str) -> dict | None:
    for item in items:
        if overlaps(item[key], wanted):
            return item
    return None


def compare(expected: dict, got: dict) -> list[tuple[bool, str]]:
    """O listă de verificări (a_trecut, descriere)."""
    checks: list[tuple[bool, str]] = []

    for exp in expected["medications"]:
        med = find(got["medications"], "name", exp["name"])
        checks.append((med is not None, f"medicament {exp['name']}"))
        if med is None:
            continue
        checks.append((same(med["dose"], exp["dose"]), f"doza {exp['name']}: așteptat {exp['dose']!r}, primit {med['dose']!r}"))
        checks.append((overlaps(med["frequency"], exp["frequency"]), f"frecvența {exp['name']}: așteptat {exp['frequency']!r}, primit {med['frequency']!r}"))
    for med in got["medications"]:
        if find(expected["medications"], "name", med["name"]) is None:
            checks.append((False, f"medicament în plus: {med['name']!r}"))

    for diagnosis in expected["diagnoses"]:
        checks.append((any(overlaps(d, diagnosis) for d in got["diagnoses"]), f"diagnostic {diagnosis}"))
    for diagnosis in got["diagnoses"]:
        if not any(overlaps(diagnosis, d) for d in expected["diagnoses"]):
            checks.append((False, f"diagnostic în plus: {diagnosis!r}"))

    for exp in expected["lab_results"]:
        lab = find(got["lab_results"], "test", exp["test"])
        checks.append((lab is not None, f"analiza {exp['test']}"))
        if lab is None:
            continue
        checks.append((same(lab["value"], exp["value"]), f"valoarea {exp['test']}: așteptat {exp['value']!r}, primit {lab['value']!r}"))
        checks.append((same(lab["unit"], exp["unit"]), f"unitatea {exp['test']}: așteptat {exp['unit']!r}, primit {lab['unit']!r}"))
    for lab in got["lab_results"]:
        if find(expected["lab_results"], "test", lab["test"]) is None:
            checks.append((False, f"analiză în plus: {lab['test']!r}"))

    got_dates = [d["value"] for d in got["dates"]]
    for date in expected["dates"]:
        checks.append((any(same(d, date) for d in got_dates), f"data {date}"))
    for date in got_dates:
        if not any(same(date, d) for d in expected["dates"]):
            checks.append((False, f"dată în plus: {date!r}"))
    return checks


def invented_values(got: dict, original_text: str) -> list[str]:
    """Valori care NU apar în documentul ORIGINAL (.txt). Pentru poze, verificarea din
    serviciu compară cu transcrierea făcută de MedGemma; aici comparăm cu originalul,
    deci prindem și greșelile de transcriere."""
    source = normalize(original_text)
    values: list[str] = []
    for med in got["medications"]:
        values += [med["name"], med["dose"], med["frequency"], med["duration"]]
    values += got["diagnoses"]
    for lab in got["lab_results"]:
        values += [lab["test"], lab["value"], lab["unit"], lab["reference_range"]]
    for date in got["dates"]:
        values += [date["label"], date["value"]]
    return [v for v in values if v is not None and normalize(v) not in source]


def main() -> None:
    name_filter = sys.argv[1] if len(sys.argv) > 1 else ""
    totals: dict[str, list[int]] = {}  # format -> [verificări trecute, total, valori inventate, secunde]

    for txt_file in sorted(FIXTURES.glob("*.txt")):
        name = txt_file.stem
        if name_filter not in name:
            continue
        expected = json.loads((FIXTURES / f"{name}.expected.json").read_text(encoding="utf-8"))
        original_text = txt_file.read_text(encoding="utf-8")

        for format_name, suffix, mime_type in FORMATS:
            data = (FIXTURES / "generated" / f"{name}{suffix}").read_bytes()
            started = time.perf_counter()
            try:
                got = extract_document(data, mime_type).model_dump()
            except ExtractionError as error:
                print(f"\n{name} [{format_name}] EROARE {error.status_code}: {error.message}")
                continue
            seconds = time.perf_counter() - started

            checks = compare(expected, got)
            passed = sum(ok for ok, _ in checks)
            invented = invented_values(got, original_text)
            total = totals.setdefault(format_name, [0, 0, 0, 0])
            total[0] += passed
            total[1] += len(checks)
            total[2] += len(invented)
            total[3] += round(seconds)

            print(f"\n{name} [{format_name}] {passed}/{len(checks)} corecte, "
                  f"{len(invented)} inventate, {len(got['warnings'])} avertismente, {seconds:.1f}s")
            for ok, description in checks:
                if not ok:
                    print(f"   ✗ {description}")
            for value in invented:
                print(f"   ! NU apare în document: {value!r}")
            for warning in got["warnings"]:
                print(f"   ~ {warning}")

    print("\nREZUMAT pe format:")
    for format_name, (passed, total, invented, seconds) in totals.items():
        print(f"  {format_name:5} {passed}/{total} verificări corecte, {invented} valori inventate, {seconds}s în total")


if __name__ == "__main__":
    main()
