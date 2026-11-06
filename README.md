# MedFlow AI

This repository contains the AI components of MedFlow:

- `edge/`: local extraction and minimization before any cloud request.
- `cloud/`: orchestration and summaries using minimized inputs.

Implementation language: TypeScript. No runtime or dependencies are configured yet.
Use synthetic medical data during development. Never commit credentials, patient
records, or identifiable medical information.

AI must not independently diagnose or prescribe. Keep deterministic medical safety
rules separate from generated text, and never silently discard symptom reports.

Document input/output contract changes and coordinate them with Backend before
updating the version pinned by the MedFlow superproject.
