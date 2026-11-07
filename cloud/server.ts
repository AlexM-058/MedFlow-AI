import express from "express";
import { GEMINI_MODEL, llmClient } from "../core/ai/llm-client";
import { validateEnv } from "../core/config/env";
import { assertAnonymousSummary } from "../edge/anonymization/summary";
import {
  buildControlQuestionsPrompt,
  parseControlQuestions,
  payloadHash,
} from "./orchestration/control-questions";
import {
  DoctorOrchestrator,
  type OrchestrationState,
  type OrchestrationStateStore,
} from "./orchestration/doctor-orchestrator";
import { buildCaseSummary } from "./summarizer/case-summary-builder";

/**
 * HTTP service for the cloud part of MedFlow-AI (Doctor AI orchestration).
 * MedFlow-Backend calls it over HTTP instead of importing the orchestrator,
 * so the two repositories no longer need to see each other's files.
 *
 * Contract:
 *   GET  /health   -> 200 {"status":"ok","service":"medflow-ai-cloud"}
 *   POST /analysis
 *     body: { caseId, caseSummary, documentsContext?, patientResponse?, state }
 *           state = current value of cases.doctor_orchestration_state (object or null)
 *     200:  { result: { status: "FINAL" | "CLARIFICATION_REQUIRED", data }, state, model }
 *           state = the value Backend must save back in cases.doctor_orchestration_state
 *           model = the LLM that produced the result (Backend stores it in ai_analyses.model_name)
 *     400:  { error }   invalid body
 *     500:  { error }   privacy scrubbing or LLM (Gemini) failure
 *   POST /case-summary
 *     body: { caseId, patientId, language: "ro" | "en",
 *             messages: [{ sender_role: "patient"|"doctor"|"ai"|"system", content, created_at }] }
 *           messages = the case_messages of the case, in chronological order (at least one)
 *     200:  { caseSummary: CaseSummary, model }
 *           built by cloud/summarizer/case-summary-builder.ts (scrubbed, red flags by fixed rules)
 *     400:  { error }   invalid body
 *     500:  { error }   privacy scrubbing or LLM failure
 *
 * This service has NO database access. Backend reads the state, sends it here and
 * saves the state it gets back. Backend also does all authorization and the full
 * CaseSummary validation before calling; this service only checks the basic shape.
 */

validateEnv(); // stop at startup if GEMINI_API_KEY is missing

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "medflow-ai-cloud" });
});

app.post("/analysis", async (request, response) => {
  const body = request.body ?? {};
  const bodyError = findBodyError(body);
  if (bodyError) {
    response.status(400).json({ error: bodyError });
    return;
  }

  // A store that lives only for this request:
  //  - load() returns the state Backend sent us
  //  - save() remembers the new state, so we can send it back to Backend
  let state: OrchestrationState | null = body.state ?? null;
  const requestStore: OrchestrationStateStore = {
    async load() {
      return state;
    },
    async save(newState) {
      state = newState;
    },
  };

  try {
    const orchestrator = new DoctorOrchestrator(requestStore);
    const result = await orchestrator.processCase(
      body.caseSummary,
      body.caseId,
      body.documentsContext,
      body.patientResponse
    );
    response.json({ result, state, model: GEMINI_MODEL });
  } catch (error) {
    console.error(`[AI server] Analysis failed: ${error instanceof Error ? error.message : error}`);
    response.status(500).json({ error: "AI analysis failed" });
  }
});

app.post("/case-summary", async (request, response) => {
  const body = request.body ?? {};
  const bodyError = findCaseSummaryBodyError(body);
  if (bodyError) {
    response.status(400).json({ error: bodyError });
    return;
  }

  try {
    const result = await buildCaseSummary({
      caseId: body.caseId,
      patientId: body.patientId,
      language: body.language,
      messages: body.messages,
    });
    response.json({ caseSummary: result.caseSummary, model: result.model });
  } catch (error) {
    console.error(`[AI server] Case summary failed: ${error instanceof Error ? error.message : error}`);
    response.status(500).json({ error: "AI case summary failed" });
  }
});

/**
 * POST /control-questions   body: { caseId, summary }   (the ONLY way the cloud learns about a patient)
 *   summary = AnonymizedPatientSummary (edge/anonymization): closed vocabulary terms, age band, lab levels.
 *   200: { summary, questions: [{id, text, answerType}], rejectedQuestionCount, payloadHash, model }
 *   400: the body is not exactly an anonymized summary (anything else is refused, never "cleaned")
 *   500: the model failed or nothing usable passed the fixed safety checks
 * The model's text is checked with fixed rules (orchestration/control-questions.ts), not trusted.
 */
app.post("/control-questions", async (request, response) => {
  const body = request.body ?? {};
  if (typeof body.caseId !== "string" || body.caseId === "" || Object.keys(body).some((key) => key !== "caseId" && key !== "summary")) {
    response.status(400).json({ error: "body must be exactly { caseId, summary }" });
    return;
  }
  let summary;
  try {
    summary = assertAnonymousSummary(body.summary);
  } catch {
    response.status(400).json({ error: "summary is not an anonymized patient summary" });
    return;
  }
  try {
    const raw = await llmClient.callLLM(buildControlQuestionsPrompt(summary), { storeData: false });
    const result = parseControlQuestions(raw.text, summary);
    response.json({ ...result, payloadHash: payloadHash(summary), model: GEMINI_MODEL });
  } catch (error) {
    console.error(`[AI server] Control questions failed: ${error instanceof Error ? error.message : error}`);
    response.status(500).json({ error: "AI control questions failed" });
  }
});

// express.json() throws on invalid JSON or on a body over the limit: answer with JSON, not HTML.
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof SyntaxError) {
    response.status(400).json({ error: "Request body is not valid JSON" });
    return;
  }
  if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
    response.status(413).json({ error: "Request body is too large" });
    return;
  }
  console.error(error instanceof Error ? error.message : error);
  response.status(500).json({ error: "Internal server error" });
});

/** Basic shape check. Returns an error message, or null if the body looks right. */
function findBodyError(body: any): string | null {
  if (typeof body.caseId !== "string" || body.caseId === "") {
    return "caseId must be a non-empty string";
  }
  if (typeof body.caseSummary !== "object" || body.caseSummary === null) {
    return "caseSummary must be an object";
  }
  if (body.documentsContext !== undefined && typeof body.documentsContext !== "string") {
    return "documentsContext must be a string";
  }
  if (body.patientResponse !== undefined && typeof body.patientResponse !== "string") {
    return "patientResponse must be a string";
  }
  if (body.state !== undefined && body.state !== null && typeof body.state !== "object") {
    return "state must be an object or null";
  }
  return null;
}

const MESSAGE_ROLES = ["patient", "doctor", "ai", "system"];

/** Shape check for POST /case-summary. Returns an error message, or null if the body looks right. */
function findCaseSummaryBodyError(body: any): string | null {
  if (typeof body.caseId !== "string" || body.caseId === "") {
    return "caseId must be a non-empty string";
  }
  if (typeof body.patientId !== "string" || body.patientId === "") {
    return "patientId must be a non-empty string";
  }
  if (body.language !== "ro" && body.language !== "en") {
    return 'language must be "ro" or "en"';
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return "messages must be a non-empty array";
  }
  for (let index = 0; index < body.messages.length; index++) {
    const message = body.messages[index];
    if (typeof message !== "object" || message === null) {
      return `messages[${index}] must be an object`;
    }
    if (!MESSAGE_ROLES.includes(message.sender_role)) {
      return `messages[${index}].sender_role must be one of: ${MESSAGE_ROLES.join(", ")}`;
    }
    if (typeof message.content !== "string") {
      return `messages[${index}].content must be a string`;
    }
    if (typeof message.created_at !== "string") {
      return `messages[${index}].created_at must be a string`;
    }
  }
  return null;
}

// HOST/PORT come from the environment, so moving to Azure is configuration, not code:
// locally 127.0.0.1:8091; in an Azure container HOST=0.0.0.0 and the port it is given.
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8091);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be between 1 and 65535.");
}

app.listen(port, host, () => {
  console.log(`MedFlow AI cloud: http://${host}:${port}/health`);
});
