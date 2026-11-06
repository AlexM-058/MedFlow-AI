import { GoogleGenerativeAI } from "@google/generative-ai";
import { ENV } from "../config/env";

/**
 * LLM Request Configuration
 */
export interface LLMRequestConfig {
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  topP?: number;
  // Privacy/Retention: controls if data is stored by the provider for training
  storeData?: boolean;
}

export interface LLMResponse {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  rawResponse: any;
}

/**
 * Unified LLM Client
 * Provides a reusable wrapper for calling different LLM providers (Gemini, Ollama, etc.)
 * with consistent timeout, retry, and privacy handling.
 */
export class LLMClient {
  private geminiClient: GoogleGenerativeAI;

  constructor() {
    this.geminiClient = new GoogleGenerativeAI(ENV.GEMINI_API_KEY || "");
  }

  /**
   * Reusable function to call an LLM
   * @param prompt The text prompt to send to the AI.
   * @param options Configuration for the call.
   * @param provider 'gemini' | 'ollama' (extendable)
   */
  async callLLM(
    prompt: string,
    options: LLMRequestConfig = {},
    provider: 'gemini' | 'ollama' = 'gemini'
  ): Promise<LLMResponse> {
    const timeout = options.timeoutMs || 30000;
    const maxRetries = options.maxRetries || 3;

    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await this.withTimeout(
          this.executeProviderCall(prompt, options, provider),
          timeout
        );
      } catch (error: any) {
        attempt++;
        console.warn(`[LLMClient] Attempt ${attempt} failed: ${error.message}`);

        if (attempt >= maxRetries) {
          throw new Error(`LLM call failed after ${maxRetries} attempts. Last error: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
    throw new Error("Unexpected LLMClient failure");
  }

  private async executeProviderCall(prompt: string, options: LLMRequestConfig, provider: string): Promise<LLMResponse> {
    if (provider === 'gemini') {
      return this.callGemini(prompt, options);
    } else if (provider === 'ollama') {
      return this.callOllama(prompt, options);
    }
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }

  private async callGemini(prompt: string, options: LLMRequestConfig): Promise<LLMResponse> {
    console.log(`[LLMClient] Calling Gemini 3 Flash (storeData: ${options.storeData})`);

    const model = this.geminiClient.getGenerativeModel({
      model: "gemini-3-flash-preview",
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        topP: options.topP ?? 0.95,
      }
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    return {
      text: text,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0
      },
      rawResponse: response
    };
  }

  private async callOllama(prompt: string, options: LLMRequestConfig): Promise<LLMResponse> {
    console.log(`[LLMClient] Calling Local Ollama at ${ENV.EDGE_LLM_ENDPOINT}`);

    const response = await fetch(`${ENV.EDGE_LLM_ENDPOINT}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({
        model: ENV.EDGE_LLM_MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.7,
        }
      })
    });

    const data = await response.json();

    return {
      text: data.response,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
      },
      rawResponse: data
    };
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`LLM call timed out after ${ms}ms`));
      }, ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId!);
    });
  }
}

export const llmClient = new LLMClient();
