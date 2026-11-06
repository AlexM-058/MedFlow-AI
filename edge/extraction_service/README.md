# Serviciul MedGemma de extragere (Python + FastAPI)

Citește un document medical (rețetă, buletin de analize, scrisoare) și întoarce un JSON
cu medicamente, doze, diagnostice, analize și date calendaristice. Ce nu apare în document
rămâne `null` / listă goală: serviciul **nu inventează valori**.

MedFlow-Backend (TypeScript) îl apelează la `POST /cases/{id}/documents`
(vezi `MedFlow-Backend/src/medgemma.ts`). Fișierul brut nu e salvat nicăieri.

## Pornire

Ai nevoie de Python 3.10+ și de [Ollama](https://ollama.com) cu modelul MedGemma:

```sh
ollama pull medgemma1.5:4b
```

Din acest folder (`MedFlow-AI/edge/extraction_service`):

```sh
py -3.13 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn main:app --host 127.0.0.1 --port 8090
```

În `MedFlow-Backend/.env`: `MEDGEMMA_URL=http://127.0.0.1:8090`.
Oprește mock-ul (`scripts/mock-medgemma.ts`) dacă rulează: folosește același port.

Variabile de mediu (opționale): `EDGE_LLM_ENDPOINT` (implicit `http://localhost:11434`),
`EDGE_LLM_MEDGEMMA` (implicit `medgemma1.5:4b`), aceleași nume ca în `core/config/env.ts`.

## Contract

`POST /extract`, `Content-Type: image/jpeg | image/png | application/pdf`, body = octeții fișierului.

`200`:

```json
{
  "extracted_data": {
    "medications": [{"name": "Amlodipină", "dose": "5 mg", "frequency": "1 cp/zi", "duration": null}],
    "diagnoses": ["Hipertensiune arterială esențială (I10)"],
    "lab_results": [{"test": "Hemoglobină", "value": "13,5", "unit": "g/dL", "reference_range": "12 - 16"}],
    "dates": [{"label": "Data", "value": "14.03.2025"}],
    "warnings": ["Doza pentru Metformin: «2 cp/zi» nu are număr + unitate, ex. „5 mg” (valoare ștearsă)."],
    "source": {"model": "medgemma1.5:4b", "input_kind": "image", "pages": 1}
  }
}
```

- Toate valorile sunt **text copiat din document** (ex. `"13,5"` cu virgulă), nu numere.
- `warnings`: ce a șters verificarea sau ce n-a putut fi citit. Medicul trebuie să le vadă.
- `source.input_kind`: `image` (poză), `pdf_text` (PDF digital), `pdf_scan` (PDF scanat).
  La `image` și `pdf_scan` textul e citit de AI din imagine, deci poate avea greșeli de citire.

Erori: `{"error": "..."}` cu `400` fișier gol, `413` prea mare, `415` nu e JPG/PNG/PDF,
`422` PDF deteriorat / protejat / fără text, `502` MedGemma a răspuns greșit,
`503` Ollama sau modelul lipsește, `504` MedGemma prea lent. Backend-ul le transformă pe toate în `502/503/504`.

## Cum funcționează

1. **Text** (`text_source.py`): poză → MedGemma transcrie textul; PDF digital → PyMuPDF citește
   textul direct; PDF scanat → PyMuPDF face din pagină o imagine → MedGemma o transcrie. Maxim 3 pagini.
2. **Extragere** (`extraction.py`): textul → MedGemma, cu o schemă JSON impusă (`schemas.py`).
3. **Verificare** (`verification.py`, `dates.py`), reguli fixe, fără AI:
   - orice valoare trebuie să apară în text, altfel e ștearsă (cu avertisment);
   - o doză trebuie să aibă număr + unitate (`5 mg`), altfel e ștearsă;
   - fără câmp „Diagnostic” / „Dg.” în document, nu păstrăm diagnostice (AI-ul nu diagnostichează);
   - datele calendaristice se caută cu regex, nu cu AI.

## Teste

```sh
.venv\Scripts\python -m pytest                 # rapide, fără Ollama (MedGemma fals)
.venv\Scripts\python evaluate.py               # lente, MedGemma real pe documentele din fixtures/
.venv\Scripts\python fixtures\make_fixtures.py # regenerează PDF/PNG/JPG din fixtures/*.txt
```

Documentele din `fixtures/` sunt **fictive**. Rezultat `evaluate.py` (06.11.2026, `medgemma1.5:4b`):
250/253 verificări corecte, 4–17 s pe document. Singura valoare greșită: o literă transcrisă
greșit dintr-un PDF scanat („Hipertenesiune”). Regula „apare în text” compară cu transcrierea,
deci nu poate prinde greșelile de citire din imagini.
