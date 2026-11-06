# MedFlow AI

This repository contains the AI components of MedFlow:

- `edge/`: local extraction and minimization before any cloud request.
- `cloud/`: orchestration and summaries using minimized inputs.

Implementation language: TypeScript.

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

### Running the AI Orchestrator
The system uses a stateful orchestrator to handle patient clarifications. To test the flow:
1. Ensure Ollama is running.
2. Run the application via the main entry point (as configured in your environment).

## 🛡️ Safety & Privacy
- **Privacy First**: All data is scrubbed via the `PrivacyGateway` before being sent to cloud LLMs.
- **Synthetic Data**: Use synthetic medical data only during development.
- **No Auto-Diagnosis**: AI must not independently diagnose or prescribe. Keep deterministic medical safety rules separate from generated text, and never silently discard symptom reports.
- **Credentials**: Never commit credentials, patient records, or identifiable medical information.

Document input/output contract changes and coordinate them with Backend before updating the version pinned by the MedFlow superproject.

