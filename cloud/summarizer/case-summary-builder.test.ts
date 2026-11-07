// Tests for case-summary normalization. All conversation data is synthetic.
// Run: npx tsx --test cloud/summarizer/case-summary-builder.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmClient } from "../../core/ai/llm-client";
import { buildCaseSummary } from "./case-summary-builder";

test("duration does not reuse a continuous/intermittent pattern when onset states a time span", async () => {
  const originalCallLLM = llmClient.callLLM;
  llmClient.callLLM = async () => ({
    text: JSON.stringify({
      chiefComplaint: "Durere de cap",
      onset: "De câteva zile",
      duration: "Continuu",
      pattern: "Intermitent",
      severity: 0,
      associatedSymptoms: ["Fără febră (negată explicit)"],
      currentMedications: [],
      allergiesConditions: [],
    }),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    rawResponse: null,
  });

  try {
    const result = await buildCaseSummary({
      caseId: "synthetic-case",
      patientId: "synthetic-patient",
      language: "ro",
      messages: [{
        sender_role: "patient",
        content: "De câteva zile mă doare capul, durerea vine și pleacă și nu am febră.",
        created_at: "2026-11-07T10:00:00Z",
      }],
    }, "ollama");

    assert.equal(result.caseSummary.duration, "De câteva zile");
    assert.equal(result.caseSummary.pattern, "Intermitent");
    assert.deepEqual(result.caseSummary.associatedSymptoms, ["Fără febră (negată explicit)"]);
  } finally {
    llmClient.callLLM = originalCallLLM;
  }
});

test("duration does not accept a time span hallucinated as a substring of the transcript", async () => {
  const originalCallLLM = llmClient.callLLM;
  llmClient.callLLM = async () => ({
    text: JSON.stringify({
      chiefComplaint: "Headache",
      onset: "2 days",
      duration: "Intermittent",
      pattern: "Intermittent",
      severity: 0,
      associatedSymptoms: [],
      currentMedications: [],
      allergiesConditions: [],
    }),
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    rawResponse: null,
  });

  try {
    const result = await buildCaseSummary({
      caseId: "synthetic-case",
      patientId: "synthetic-patient",
      language: "en",
      messages: [{
        sender_role: "patient",
        content: "My headache started 12 days ago and comes and goes.",
        created_at: "2026-11-07T10:00:00Z",
      }],
    }, "ollama");

    assert.equal(result.caseSummary.duration, "Not specified");
    assert.equal(result.caseSummary.pattern, "Intermittent");
  } finally {
    llmClient.callLLM = originalCallLLM;
  }
});
