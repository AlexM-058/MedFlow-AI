"""Bugetul de timp al unei cereri POST /extract.

PROBLEMA: Backend-ul (MedFlow-Backend/src/medgemma.ts) ne așteaptă cel mult 120 s.
O cerere poate face până la 4 apeluri lente la AI (3 pagini scanate + extragerea),
fiecare de până la 45 s. 4 x 45 = 180 s > 120 s: Backend-ul ar renunța înaintea noastră,
iar noi am lucra degeaba mai departe.

SOLUȚIA: la începutul cererii calculăm un „termen limită” (deadline) = acum + buget.
Înainte de FIECARE apel la AI întrebăm „câte secunde mai avem?”:
  - dacă nu mai avem deloc -> ne oprim imediat cu 504 (fără să mai apelăm AI-ul);
  - altfel, apelul are voie să dureze cel mult cât a mai rămas.
Așa răspundem NOI cu 504 înainte ca Backend-ul să renunțe.

Exemplu cu bugetul implicit de 100 s:
  t=0    începe cererea                     -> deadline = 100
  t=0    pagina 1: mai avem 100 s -> timeout min(45, 100) = 45 s; durează 40 s
  t=40   pagina 2: mai avem  60 s -> timeout min(45,  60) = 45 s; durează 40 s
  t=80   pagina 3: mai avem  20 s -> timeout min(45,  20) = 20 s; dacă trece -> 504 la t=100
"""

import os
import time

from errors import ExtractionError

# Câte secunde are voie să dureze o cerere în total. Trebuie să fie MAI MIC decât
# TIMEOUT_MS din MedFlow-Backend/src/medgemma.ts (120 s), cu rezervă pentru trimiterea
# fișierului, randarea paginilor PDF și verificare.
TIME_BUDGET_SECONDS = float(os.environ.get("EXTRACTION_TIME_BUDGET_SECONDS", "100"))


def new_deadline() -> float:
    """Momentul (în secunde, pe ceasul `time.monotonic`) după care cererea trebuie oprită.

    `time.monotonic()` e un ceas care merge doar înainte (nu sare dacă cineva schimbă ora
    calculatorului). Valoarea lui nu e o oră din zi; contează doar diferențele.
    """
    return time.monotonic() + TIME_BUDGET_SECONDS


def check_time_left(deadline: float | None) -> None:
    """Aruncă ExtractionError 504 dacă bugetul cererii s-a terminat. None = fără buget."""
    if deadline is not None and deadline - time.monotonic() <= 0:
        raise ExtractionError(504, "Documentul durează prea mult de procesat (s-a depășit timpul maxim)")


def seconds_left(deadline: float | None, max_seconds: float) -> float:
    """Cât are voie să dureze următorul apel: minimul dintre `max_seconds` și ce a rămas.

    deadline = None înseamnă „fără buget” (ex. un apel direct din teste): întoarce `max_seconds`.
    Dacă bugetul s-a terminat, aruncă ExtractionError 504.
    """
    check_time_left(deadline)
    if deadline is None:
        return max_seconds
    return min(max_seconds, deadline - time.monotonic())
