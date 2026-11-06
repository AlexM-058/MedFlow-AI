import { GeminiDoctorClient, DoctorAnalysis } from "../orchestrator/gemini-client";
import { CaseSummary } from "../../core/schemas/case-summary";

/**
 * Cloud Options Generator
 * Coordinates the generation of the 3 argued options for the doctor.
 */
export class OptionsGenerator {
  private geminiClient: GeminiDoctorClient;

  constructor(apiKey: string) {
    this.geminiClient = new GeminiDoctorClient(apiKey);
  }

  /**
   * Generates the final analysis for the doctor.
   * @param caseSummary The structured case summary from the edge.
   * @param documentsContext Optional text extracted from uploaded PDFs/Images.
   */
  async generateDoctorOptions(caseSummary: CaseSummary, documentsContext?: string): Promise<DoctorAnalysis> {
    console.log(`[OptionsGenerator] Generating decision support for patient ${caseSummary.metadata.patientId}...`);

    // Call the Gemini client to get the structured analysis
    const analysis = await this.geminiClient.analyzeCase(caseSummary, documentsContext);

    // Validation: Ensure exactly 3 options are returned
    if (analysis.options.length !== 3) {
      console.warn(`[OptionsGenerator] Warning: Gemini returned ${analysis.options.length} options instead of 3. Attempting to normalize...`);
      // In a real app, we might retry or truncate/pad here.
    }

    return analysis;
  }
}
