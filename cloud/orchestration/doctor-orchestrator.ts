import { CaseSummary } from "../../core/schemas/case-summary";
import { privacyGateway } from "../orchestration/privacy-gateway";
import { llmClient } from "../../core/ai/llm-client";
import { PROMPT_TEMPLATES } from "../prompts/templates";

/**
 * Data structure for tracking AI interaction state across rounds.
 */
export interface OrchestrationState {
  sessionId: string;
  roundCount: number;
  lastAnalysis?: any; // Stores the last DoctorAnalysis result
}

/**
 * Result of the orchestration process.
 */
export interface OrchestrationResult {
  status: 'FINAL' | 'CLARIFICATION_REQUIRED';
  data: any; // DoctorAnalysis if FINAL, Clarification Question if REQUIRED
}

/**
 * Where the orchestrator keeps its state between API requests.
 *
 * The orchestrator does NOT know which database is used. Whoever creates it
 * (MedFlow-Backend) passes an object with these two functions. In the backend
 * they read/write the `cases.doctor_orchestration_state` column
 * (MedFlow-Database/migrations/003_doctor_orchestration_state.sql).
 */
export interface OrchestrationStateStore {
  /** Returns the saved state, or null if nothing was saved yet for this session. */
  load(sessionId: string): Promise<OrchestrationState | null>;
  /** Saves (overwrites) the full state of the session. */
  save(state: OrchestrationState): Promise<void>;
}

/**
 * DoctorOrchestrator coordinates the multi-round interaction between
 * the backend, Privacy Gateway, and the AI (Gemini).
 */
export class DoctorOrchestrator {
  private readonly MAX_ROUNDS = 2;
  private readonly stateStore: OrchestrationStateStore;

  constructor(stateStore: OrchestrationStateStore) {
    this.stateStore = stateStore;
  }

  /**
   * Processes a case summary and returns either a final analysis or a clarification request.
   *
   * @param caseSummary The patient data to analyze.
   * @param sessionId Unique identifier for the session to track rounds and privacy mapping.
   * @param documentsContext Optional medical documents context.
   * @param patientResponse Optional response from patient for follow-up rounds.
   */
  async processCase(
    caseSummary: CaseSummary,
    sessionId: string,
    documentsContext?: string,
    patientResponse?: string
  ): Promise<OrchestrationResult> {
    // 1. Retrieve/Initialize State (from the store passed to the constructor)
    const state = await this.getState(sessionId);

    // 2. Privacy Scrubbing (Input)
    // Fail-closed: If scrubbing fails, we do not proceed to the LLM.
    let scrubbedSummary;
    try {
      scrubbedSummary = await privacyGateway.scrubObject(caseSummary, sessionId);
    } catch (error) {
      console.error(`[DoctorOrchestrator] Privacy scrubbing failed: ${error}`);
      throw new Error("Security violation: Failed to scrub PHI/PII before AI processing.");
    }

    // 3. Prompt Selection & Templating
    const prompt = this.buildPrompt(state, scrubbedSummary, documentsContext, patientResponse);

    // 4. LLM Interaction
    // storeData: false ensures we request that the provider does not use this for training
    const rawResponse = await llmClient.callLLM(prompt, { storeData: false });

    let analysis;
    try {
      analysis = this.parseAnalysis(rawResponse.text);
    } catch (error) {
      console.error(`[DoctorOrchestrator] Failed to parse LLM JSON: ${error}`);
      throw new Error("AI response was malformed. Please try again.");
    }

    // 5. Logic Flow: Is information sufficient?
    const hasMissingInfo = analysis.missingInformation && analysis.missingInformation.length > 0;

    if (hasMissingInfo && state.roundCount < this.MAX_ROUNDS) {
      // Increment round and save state for next iteration
      await this.updateState(sessionId, {
        roundCount: state.roundCount + 1,
        lastAnalysis: analysis
      });

      const question = this.generateClarificationQuestion(analysis.missingInformation);
      return {
        status: 'CLARIFICATION_REQUIRED',
        data: question
      };
    }

    // 6. Final Response: Unscrub for Doctor view
    try {
      const finalAnalysis = await privacyGateway.unscrubObject(analysis, sessionId);
      return {
        status: 'FINAL',
        data: finalAnalysis
      };
    } catch (error) {
      console.error(`[DoctorOrchestrator] Privacy unscrubbing failed: ${error}`);
      throw new Error("Failed to restore patient identifiers for final analysis.");
    }
  }

  private buildPrompt(state: OrchestrationState, summary: any, docs?: string, response?: string): string {
    const lang: 'ro' | 'en' = summary.metadata?.language || 'en';

    // Initial round
    if (state.roundCount === 0 || !response) {
      return PROMPT_TEMPLATES.initialAnalysis[lang]
        .replace('{{caseSummary}}', JSON.stringify(summary, null, 2))
        .replace('{{documentsContext}}', docs || 'None provided');
    }

    // Clarification round
    return PROMPT_TEMPLATES.clarification[lang]
      .replace('{{previousAnalysis}}', JSON.stringify(state.lastAnalysis, null, 2))
      .replace('{{patientResponse}}', response);
  }

  private parseAnalysis(text: string): any {
    // Handle LLM responses that wrap JSON in markdown blocks (e.g., ```json ... ```)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in LLM response");
    }
    return JSON.parse(jsonMatch[0]);
  }

  private generateClarificationQuestion(missingInfo: string[]): string {
    // In a production system, this might be another LLM call to make the question more natural.
    // For MVP, we provide a structured request for the missing data.
    return `The AI requires more information to provide an accurate analysis. Please clarify the following: ${missingInfo.join('; ')}`;
  }

  /**
   * State Management
   * Delegates to the OrchestrationStateStore given in the constructor.
   */
  private async getState(sessionId: string): Promise<OrchestrationState> {
    const saved = await this.stateStore.load(sessionId);
    if (saved === null) {
      // First request for this session: nothing saved yet -> start at round 0.
      return { sessionId, roundCount: 0 };
    }
    return saved;
  }

  private async updateState(sessionId: string, updates: Partial<OrchestrationState>): Promise<void> {
    // Read the current state, overwrite only the fields from `updates`, save the whole object.
    const current = await this.getState(sessionId);
    const newState: OrchestrationState = { ...current, ...updates };
    await this.stateStore.save(newState);
  }
}
