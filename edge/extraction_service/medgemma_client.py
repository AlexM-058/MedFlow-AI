"""Singurul loc din serviciu care vorbește cu Ollama (unde rulează MedGemma local).

Folosim API-ul Ollama POST /api/generate:
  - `prompt`: instrucțiunea pentru model
  - `images`: imaginile, ca text base64 (pasul 1, transcrierea)
  - `format`: o schemă JSON pe care răspunsul TREBUIE s-o respecte (pasul 2, extragerea)
"""

import base64
import os

import httpx2

import time_budget
from errors import ExtractionError

# Aceleași nume de variabile ca în MedFlow-AI/core/config/env.ts.
OLLAMA_URL = os.environ.get("EDGE_LLM_ENDPOINT", "http://localhost:11434").rstrip("/")
MODEL = os.environ.get("EDGE_LLM_MEDGEMMA", "medgemma1.5:4b")

# Cât are voie să dureze UN apel la Ollama. În plus, apelul nu are voie să depășească
# bugetul total al cererii (vezi time_budget.py): se ia minimul dintre cele două.
TIMEOUT_SECONDS = 45

# Mărimea „memoriei de lucru” a modelului (prompt + document + răspuns), în tokeni.
# E aceeași la TOATE apelurile: dacă se schimbă între apeluri, Ollama reîncarcă modelul (~9 s).
CONTEXT_TOKENS = 8192


def generate(
    prompt: str,
    image: bytes | None = None,
    json_schema: dict | None = None,
    max_tokens: int = 1024,
    deadline: float | None = None,
) -> tuple[str, bool]:
    """Întoarce (textul răspunsului, a_fost_tăiat).

    a_fost_tăiat = True dacă modelul a atins limita `max_tokens` înainte să termine.
    deadline = termenul limită al cererii (time_budget.new_deadline()); None = fără buget.
    """
    # Verificăm bugetul ÎNAINTE să apelăm Ollama: dacă timpul s-a terminat, aruncă 504
    # și Ollama nu mai e apelat deloc. Altfel, timeout-ul e cel mult cât a mai rămas.
    timeout = time_budget.seconds_left(deadline, TIMEOUT_SECONDS)

    body: dict = {
        "model": MODEL,
        "prompt": prompt,
        "stream": False,  # vrem tot răspunsul odată, nu bucată cu bucată
        "options": {
            "temperature": 0,  # fără „creativitate”: același document -> același răspuns
            "num_ctx": CONTEXT_TOKENS,
            "num_predict": max_tokens,  # oprește modelul dacă intră într-o buclă
        },
    }
    if image is not None:
        body["images"] = [base64.b64encode(image).decode("ascii")]
    if json_schema is not None:
        body["format"] = json_schema

    try:
        response = httpx2.post(f"{OLLAMA_URL}/api/generate", json=body, timeout=timeout)
    except httpx2.TimeoutException:
        raise ExtractionError(504, "MedGemma nu a răspuns la timp")
    except httpx2.HTTPError:
        raise ExtractionError(503, f"Nu pot contacta Ollama la {OLLAMA_URL}. Rulează Ollama?")

    if response.status_code == 404:
        raise ExtractionError(503, f"Modelul {MODEL} nu e instalat în Ollama (ollama pull {MODEL})")
    if response.status_code != 200:
        raise ExtractionError(502, f"Ollama a răspuns cu HTTP {response.status_code}")

    data = response.json()
    return data.get("response", ""), data.get("done_reason") == "length"
