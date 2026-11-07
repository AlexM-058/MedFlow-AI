# Local intake dossier context

`POST /intake` accepts optional `dossierContext` with string fields
`confirmedMedications`, `unverifiedClinical`, and `controlSummary` (maximum 2000
characters each). Unknown fields and invalid values are rejected. Older callers
may omit the object.

Backend loads only these summaries from the authenticated patient's
`medical_records`. Control questions and their summary must match the current
case ID. Clinical extraction and AI summaries are explicitly unverified; reviewed
medications can still be outdated. Oversized summaries are replaced with an
explicit unavailable marker, not silently truncated. Original records/messages
are unchanged.

Context is sent only to local Ollama. It is not an anonymized cloud payload and
must never be added to `/control-questions`. Gemma selects an allowed question
ID; the gateway returns the existing question text, never model-generated advice.
This change does not enable free-form chat or guarantee clinically optimal
question selection.

Rollout: restart the updated local gateway BEFORE deploying Backend, because
older gateways reject `dossierContext`. Then deploy Backend and Frontend.
No database migration is required. The final “Adaugă în dosar” action uses the
existing medication-review save API; original uploads are already stored, and
clinical findings are not newly confirmed by this action.

The model is selected by `AI/local/.env` (`LOCAL_AGENT_MODEL=gemma3:4b` for 4b).
Changing it requires restarting the gateway; `/ready` reports its actual model.
