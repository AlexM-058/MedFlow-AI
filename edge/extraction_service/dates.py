"""Datele calendaristice din document, găsite cu reguli fixe (regex), FĂRĂ AI.

De ce nu le cere lui MedGemma? Testele pe documente reale au arătat că modelul le
omite la întâmplare (o diferență invizibilă de spații în text era de ajuns).
O dată are o formă clară, deci o regulă fixă e mai sigură: ce găsim e copiat din text,
nu poate fi inventat.
"""

import re

from schemas import DocumentDate

DAY = r"(?:0?[1-9]|[12]\d|3[01])"  # 1-31
MONTH = r"(?:0?[1-9]|1[0-2])"  # 1-12
MONTH_NAMES = (
    "ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|"
    "septembrie|octombrie|noiembrie|decembrie"
)

DATE_PATTERN = re.compile(
    r"(?<![\d.,/-])"  # nu începe în mijlocul altui număr (ex. „32.13.2025”)
    r"(?:"
    rf"{DAY}([./-]){MONTH}\1\d{{4}}"  # 14.03.2025  14/03/2025  14-03-2025 (același separator)
    rf"|\d{{4}}-{MONTH}-{DAY}"  # 2025-03-14
    rf"|{DAY}\s+(?:{MONTH_NAMES})\s+\d{{4}}"  # 14 martie 2025
    r")"
    r"(?!\d)",  # nu continuă cu alte cifre
    re.IGNORECASE,
)


def find_dates(text: str) -> list[DocumentDate]:
    dates: list[DocumentDate] = []
    for match in DATE_PATTERN.finditer(text):
        # Eticheta = ce scrie pe același rând, înaintea datei („Data recoltării: ...”).
        line_start = text.rfind("\n", 0, match.start()) + 1
        label = text[line_start : match.start()].strip().rstrip(":-").strip()
        date = DocumentDate(label=label or None, value=match.group(0))
        if date not in dates:
            dates.append(date)
    return dates
