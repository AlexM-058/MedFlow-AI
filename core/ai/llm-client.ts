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
  // Aligned with Gemini's 'data_sharing' policies and Local LLM defaults.
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
  /**
   * Reusable function to call an LLM
   * @param prompt The text prompt to send to the AI.
   * @param options Configuration for the call.
   * @param provider 'gemini' | 'ollama' | 'openai' (extendable)
   */
  async callLLM(
    prompt: string,
    options: LLMRequestConfig = {},
    provider: 'gemini' | 'ollama' = 'gemini'
  ): Promise<LLMResponse> {
    const timeout = options.timeoutMs || 30000; // Default 30s
    const maxRetries = options.maxRetries || 3;

    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        // Wrap the provider call in a timeout promise
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

        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
    throw new Error("Unexpected LLMClient failure");
  }

  /**
   * Maps the high-level call to specific provider implementations
   */
  private async executeProviderCall(prompt: string, options: LLMRequestConfig, provider: string): Promise<LLMResponse> {
    if (provider === 'gemini') {
      return this.callGemini(prompt, options);
    } else if (provider === 'ollama') {
      return this.callOllama(prompt, options);
    }
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }

  private async callGemini(prompt: string, options: LLMRequestConfig): Promise<LLMResponse> {
    // In a real implementation, this would use the @google/generative-ai SDK
    // and pass the `storeData` option to the safety settings or API configuration.
    console.log(`[LLMClient] Calling Gemini API (storeData: ${options.storeData})`);

    // Mock implementation for the utility shell
    return {
      text: "Gemini response placeholder",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      rawResponse: {}
    };
  }

  private async callOllama(prompt: string, options: LLMRequestConfig): Promise<LLMResponse> {
    console.log(`[LLMClient] Calling Local Ollama at ${ENV.EDGE_LLM_ENDPOINT}`);

    // Mock implementation for the utility shell
    return {
      text: "Ollama response placeholder",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      rawResponse: {}
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
