import { GEMINI_MODEL, llmClient, type LLMRequestConfig } from "../../core/ai/llm-client";
import { ENV } from "../../core/config/env";
import type { CaseSummary } from "../../core/schemas/case-summary";
import { detectRedFlags } from "../../edge/safety/redflags";
import { privacyGateway } from "../orchestration/privacy-gateway";
import { CASE_SUMMARY_PROMPT } from "../prompts/case-summary";

/**
 * Case Summary Builder
 * Builds a CaseSummary from the case conversation (the rows of case_messages),
 * so the doctor does not have to write the summary by hand before asking for an analysis.
 *
 * Steps:
 *   1. Scrub every message with privacyGateway (fail-closed: if scrubbing fails, no LLM call).
 *   2. Ask the LLM to fill the descriptive fields (chief complaint, onset, ...).
 *   3. Validate the LLM JSON by hand and fill safe defaults ("Nespecificat" / []).
 *   4. Set the fields the LLM must NOT decide:
 *        redFlagsDetected -> deterministic rules (edge/safety/redflags.ts)
 *        rawTranscript    -> the scrubbed conversation
 *        metadata         -> given patientId + language, timestamp = now
 *
 * The summary only describes what was said. It is not a diagnosis.
 */

export type MessageRole = "patient" | "doctor" | "ai" | "system";

/** One row of case_messages, as Backend sends it. */
export interface ConversationMessage {
  sender_role: MessageRole;
  content: string;
  created_at: string;
}

export interface CaseSummaryRequest {
  caseId: string;     // used as the privacy session id
  patientId: string;  // copied into metadata.patientId (Backend checks it is the case's patient)
  language: "ro" | "en";
  messages: ConversationMessage[];
}

export interface CaseSummaryResult {
  caseSummary: CaseSummary;
  model: string;      // the LLM that wrote the descriptive fields
}

/**
 * WHICH LLM BUILDS THE SUMMARY - the one switch for the team.
 *   "gemini" = cloud model (GEMINI_MODEL), the default today.
 *   "ollama" = local model through Ollama; the model name comes from EDGE_LLM_MEDGEMMA in .env
 *              (MedGemma). Change the value below to "ollama" to try it.
 * The scrubbing in step 1 runs for both providers.
 */
export type SummaryProvider = "gemini" | "ollama";
export const DEFAULT_SUMMARY_PROVIDER: SummaryProvider = "gemini";

// Labels used in the transcript. They come from this table, never from the message text.
const ROLE_LABELS = {
  ro: { patient: "Pacient", doctor: "Medic", ai: "AI", system: "Sistem" },
  en: { patient: "Patient", doctor: "Doctor", ai: "AI", system: "System" },
};

// Text written when the conversation does not contain a field.
const NOT_SPECIFIED = { ro: "Nespecificat", en: "Not specified" };

export async function buildCaseSummary(
  request: CaseSummaryRequest,
  provider: SummaryProvider = DEFAULT_SUMMARY_PROVIDER
): Promise<CaseSummaryResult> {
  const { caseId, patientId, language, messages } = request;

  // 1. Privacy scrubbing (fail-closed). Each line = "[date] Role: text", scrubbed as a whole,
  //    so nothing from the message (or its date) reaches the LLM without passing the gateway.
  const scrubbedLines: string[] = [];
  try {
    for (const message of messages) {
      const label = ROLE_LABELS[language][message.sender_role];
      const line = `[${message.created_at}] ${label}: ${message.content}`;
      scrubbedLines.push(await privacyGateway.scrub(line, caseId));
    }
  } catch (error) {
    console.error(`[CaseSummaryBuilder] Privacy scrubbing failed: ${error}`);
    throw new Error("Security violation: Failed to scrub PHI/PII before AI processing.");
  }
  const scrubbedTranscript = scrubbedLines.join("\n");

  // 2. LLM call. split/join instead of replace(): a "$" in the text cannot change the result.
  const prompt = CASE_SUMMARY_PROMPT[language].split("{{transcript}}").join(scrubbedTranscript);
  const options: LLMRequestConfig = { storeData: false };
  let model = GEMINI_MODEL;
  if (provider === "ollama") {
    options.model = ENV.EDGE_LLM_MEDGEMMA;
    model = ENV.EDGE_LLM_MEDGEMMA;
  }
  const rawResponse = await llmClient.callLLM(prompt, options, provider);

  // 3. Parse + validate the LLM answer.
  let fields: Record<string, unknown>;
  try {
    fields = parseJsonObject(rawResponse.text);
  } catch (error) {
    console.error(`[CaseSummaryBuilder] Failed to parse LLM JSON: ${error}`);
    throw new Error("AI case summary was malformed. Please try again.");
  }
  const fallback = NOT_SPECIFIED[language];

  // 4. Red flags: deterministic rules, NOT the LLM. We check the ORIGINAL patient messages
  //    (this runs on our server, nothing is sent anywhere). Both rule sets are checked,
  //    because a patient can write in either language: missing an emergency is worse
  //    than a false alarm the doctor can dismiss.
  let redFlagsDetected = false;
  for (const message of messages) {
    if (message.sender_role !== "patient") {
      continue;
    }
    if (detectRedFlags(message.content, "ro").isEmergency || detectRedFlags(message.content, "en").isEmergency) {
      redFlagsDetected = true;
    }
  }

  const caseSummary: CaseSummary = {
    chiefComplaint: textOrDefault(fields.chiefComplaint, fallback),
    onset: textOrDefault(fields.onset, fallback),
    duration: textOrDefault(fields.duration, fallback),
    pattern: textOrDefault(fields.pattern, fallback),
    severity: severityFrom(fields.severity),
    associatedSymptoms: textList(fields.associatedSymptoms),
    currentMedications: textList(fields.currentMedications),
    allergiesConditions: textList(fields.allergiesConditions),
    redFlagsDetected,
    rawTranscript: scrubbedTranscript,
    metadata: {
      timestamp: new Date().toISOString(),
      patientId,
      language,
    },
  };

  return { caseSummary, model };
}

/** Takes the first {...} from the LLM text (it may wrap the JSON in ```json blocks). */
function parseJsonObject(text: string): Record<string, unknown> {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON object found in LLM response");
  }
  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM response is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** A non-empty text, or the default ("Nespecificat") when the LLM gave nothing usable. */
function textOrDefault(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return fallback;
}

/** A list of texts. Numbers are kept as text; empty items and non-text items are skipped. */
function textList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "number") {
      result.push(String(item));
    } else if (typeof item === "string" && item.trim() !== "") {
      result.push(item.trim());
    }
  }
  return result;
}

/** Severity 0-10. A number (or a text like "7") is clamped to 0-10; anything else becomes 0. */
function severityFrom(value: unknown): number {
  const severity = typeof value === "string" ? Number(value) : value;
  if (typeof severity !== "number" || !Number.isFinite(severity)) {
    return 0;
  }
  return Math.min(10, Math.max(0, severity));
}
