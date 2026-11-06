# MedFlow AI

This repository contains the AI components of MedFlow:

- `edge/`: local extraction and minimization before any cloud request.
- `cloud/`: orchestration and summaries using minimized inputs.

Implementation language: TypeScript, except `edge/extraction_service/`.

`edge/extraction_service/` is the document extraction service used by MedFlow-Backend
(`POST /extract`): **Python + FastAPI** with MedGemma running locally in Ollama. It reads
prescriptions and lab results (JPG, PNG, PDF) and returns structured JSON without
inventing missing values. Setup, contract and tests: `edge/extraction_service/README.md`.

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v20+ recommended.
- **Ollama**: Installed and running on your machine.

### 2. Installation
```bash
npm install
```

### 3. Local AI Setup (Ollama)
To test the local models, pull the required weights:
```bash
ollama pull medgemma1.5:4b
ollama pull gemma4:e2b
```

### 4. Environment Configuration
Create a `.env` file in the root directory:
```env
GEMINI_API_KEY=your_google_gemini_api_key
EDGE_LLM_ENDPOINT=http://localhost:11434
EDGE_LLM_MODEL=medgemma1.5:4b
```

## 🧪 Testing the AI

### Running the Benchmark
To compare the performance (latency and TPS) of the local models on your hardware:
```bash
npx tsx scripts/benchmark-models.ts
```

### Running the AI cloud service (HTTP)
`cloud/server.ts` exposes the Doctor AI orchestrator over HTTP, so MedFlow-Backend calls it
instead of importing AI files (each repository builds and deploys on its own, e.g. on Azure).

```bash
npm run dev        # http://127.0.0.1:8091/health  (HOST/PORT from .env; needs GEMINI_API_KEY)
npm start          # same server without watch (node --import tsx cloud/server.ts)
npm run build      # type-check only (tsc, no output files)
```

Docker (e.g. Azure Container Apps), image with only `core/`, `cloud/` and production
dependencies (`tsx` runs the `.ts` files); `.dockerignore` keeps `.env` out of the image:

```bash
docker build -t medflow-ai .
docker run --rm --env-file .env -e HOST=0.0.0.0 -p 8091:8091 medflow-ai
```

| Method and path | Body | Success |
| --- | --- | --- |
| `GET /health` | none | `200` + `{"status":"ok","service":"medflow-ai-cloud"}` |
| `POST /analysis` | `{"caseId", "caseSummary": CaseSummary, "documentsContext"?, "patientResponse"?, "state": object \| null}` | `200` + `{"result": {"status": "FINAL" \| "CLARIFICATION_REQUIRED", "data"}, "state": object \| null}` |

- `state` is the value of `cases.doctor_orchestration_state` (Database migration 003). Backend
  sends the current value and saves the `state` it gets back. **The service has no database access.**
- Backend does authorization and the full `CaseSummary` validation before calling; the service only
  checks the basic shape. Errors are JSON `{"error": "..."}`: `400` invalid body or JSON, `413` body
  over 1 MB, `500` privacy scrubbing or Gemini failure.
- The service listens on `127.0.0.1` by default. On Azure it must be reachable only from Backend
  (internal ingress), never from the internet.

`DoctorOrchestrator` (`cloud/orchestration/doctor-orchestrator.ts`) does not talk to a
database itself. Its constructor takes an `OrchestrationStateStore` with two functions,
`load(sessionId)` and `save(state)`, and keeps nothing in memory between calls.
`cloud/server.ts` gives it a store that lives for one request: `load` returns the `state`
sent by MedFlow-Backend and `save` keeps the new state to send back. MedFlow-Backend no
longer imports AI files; it calls `POST /analysis` from its `POST /cases/{id}/analysis`
route and stores `state` in `cases.doctor_orchestration_state` (Database migration 003).

## 🛡️ Safety & Privacy
- **Privacy First**: All data is scrubbed via the `PrivacyGateway` before being sent to cloud LLMs.
- **Synthetic Data**: Use synthetic medical data only during development.
- **No Auto-Diagnosis**: AI must not independently diagnose or prescribe. Keep deterministic medical safety rules separate from generated text, and never silently discard symptom reports.
- **Credentials**: Never commit credentials, patient records, or identifiable medical information.

Document input/output contract changes and coordinate them with Backend before updating the version pinned by the MedFlow superproject.

