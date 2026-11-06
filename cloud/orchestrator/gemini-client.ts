import { GoogleGenerativeAI } from "@google/generative-ai";
import { DOCTOR_AI_PROMPT } from "../prompts/doctor-support";
import { CaseSummary } from "../../core/schemas/case-summary";
import { ENV } from "../../core/config/env";

export interface DoctorOption {
  option: string;
  reasoning: string;
  confidence: string;
  confirmationPath: string;
}

export interface DoctorAnalysis {
  options: DoctorOption[];
  missingInformation: string[];
  contradictions: string[];
}

export class GeminiDoctorClient {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor(apiKey?: string) {
    const finalApiKey = apiKey || ENV.GEMINI_API_KEY;
    if (!finalApiKey) {
      throw new Error("Gemini API Key is required. Provide it in the constructor or set GEMINI_API_KEY in .env");
    }
    this.genAI = new GoogleGenerativeAI(finalApiKey);
    this.model = this.genAI.getGenerativeModel({
      model: "gemini-1.5-pro",
      generationConfig: {
        responseMimeType: "application/json",
      }
    });
  }

  /**
   * Analyzes a case summary and generates 3 argued options for the doctor.
   */
  async analyzeCase(caseSummary: CaseSummary, documentsContext?: string): Promise<DoctorAnalysis> {
    const lang = caseSummary.metadata.language;
    const systemPrompt = DOCTOR_AI_PROMPT[lang];

    const prompt = `
      ${systemPrompt}

      PATIENT CASE SUMMARY:
      ${JSON.stringify(caseSummary, null, 2)}

      ADDITIONAL DOCUMENTS CONTEXT:
      ${documentsContext || "No additional documents provided."}

      Return the analysis in the following JSON format:
      {
        "options": [
          { "option": "...", "reasoning": "...", "confidence": "...", "confirmationPath": "..." },
          { "option": "...", "reasoning": "...", "confidence": "...", "confirmationPath": "..." },
          { "option": "...", "reasoning": "...", "confidence": "...", "confirmationPath": "..." }
        ],
        "missingInformation": ["..."],
        "contradictions": ["..."]
      }
    `;

    try {
      const result = await this.model.generateContent(prompt);
      const response = result.response;
      const text = response.text();
      return JSON.parse(text) as DoctorAnalysis;
    } catch (error) {
      console.error("Gemini API Error:", error);
      throw new Error("Failed to generate doctor analysis using Gemini API");
    }
  }
}
