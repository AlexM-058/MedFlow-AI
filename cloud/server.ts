import express from "express";
import { GEMINI_MODEL } from "../core/ai/llm-client";
import { validateEnv } from "../core/config/env";
import {
  DoctorOrchestrator,
  type OrchestrationState,
  type OrchestrationStateStore,
} from "./orchestration/doctor-orchestrator";

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
