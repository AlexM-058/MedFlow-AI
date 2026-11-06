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

Variabile de mediu (toate opționale):

| Variabilă | Implicit | Ce face |
|---|---|---|
| `EDGE_LLM_ENDPOINT` | `http://localhost:11434` | adresa Ollama (același nume ca în `core/config/env.ts`) |
| `EDGE_LLM_MEDGEMMA` | `medgemma1.5:4b` | modelul MedGemma din Ollama (același nume ca în `core/config/env.ts`) |
| `OCR_ENGINE` | `medgemma` | cine citește textul din poze și din paginile PDF scanate (vezi „OCR” mai jos) |
| `EXTRACTION_TIME_BUDGET_SECONDS` | `100` | cât are voie să dureze o cerere în total; după aceea răspundem `504` |

`GET /health` → `{"status": "ok", "service": ..., "model": "medgemma1.5:4b", "ocr_engine": "medgemma"}`.

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
`503` Ollama sau modelul lipsește (sau `OCR_ENGINE` are o valoare necunoscută),
`504` MedGemma prea lent sau s-a terminat bugetul de timp al cererii.

Backend-ul trimite mai departe `422` cu mesajul nostru (ca utilizatorul să afle de ce
documentul nu a putut fi citit); celelalte erori devin `502`, iar dacă nu ne poate contacta
sau nu răspundem în 120 s, `503` / `504`.

## Cum funcționează

1. **Text** (`text_source.py`): poză → OCR (`ocr.py`) citește textul; PDF digital → PyMuPDF citește
   textul direct; PDF scanat → PyMuPDF face din pagină o imagine → OCR o citește. Maxim 3 pagini.
2. **Extragere** (`extraction.py`): textul → MedGemma, cu o schemă JSON impusă (`schemas.py`).
3. **Verificare** (`verification.py`, `dates.py`), reguli fixe, fără AI:
   - orice valoare trebuie să apară în text, altfel e ștearsă (cu avertisment);
   - o doză trebuie să aibă număr + unitate (`5 mg`), altfel e ștearsă;
   - fără câmp „Diagnostic” / „Dg.” în document, nu păstrăm diagnostice (AI-ul nu diagnostichează);
   - datele calendaristice se caută cu regex, nu cu AI.

### OCR (imagine → text)

Tot ce înseamnă „citește textul dintr-o imagine” e în `ocr.py`, în funcția
`image_to_text(imagine) -> (text, avertismente)`. `text_source.py` o apelează și nu știe
ce motor rulează în spate. Motorul se alege cu `OCR_ENGINE`; azi există doar `medgemma`.
O valoare necunoscută dă `503` doar pentru poze și PDF-uri scanate (PDF-urile cu text merg în continuare).

Ca să adaugi un motor nou: o funcție `<nume>_image_to_text(image, deadline)` în `ocr.py`,
o intrare în dicționarul `ENGINES`, apoi `OCR_ENGINE=<nume>`. Pașii exacți sunt în comentariul
de la începutul lui `ocr.py`.

### Bugetul de timp (`time_budget.py`)

O cerere poate face până la 4 apeluri la AI (3 pagini scanate + extragerea), fiecare de până la
45 s. La începutul cererii calculăm un termen limită (acum + `EXTRACTION_TIME_BUDGET_SECONDS`).
Înainte de fiecare apel OCR / MedGemma verificăm cât timp a mai rămas: dacă nu mai e deloc,
răspundem `504` fără să mai apelăm AI-ul; altfel, apelul are timeout-ul `min(45 s, ce a rămas)`.
Bugetul (100 s) trebuie să fie mai mic decât cât ne așteaptă Backend-ul (`TIMEOUT_MS` = 120 s în
`MedFlow-Backend/src/medgemma.ts`), ca noi să ne oprim primii.

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
