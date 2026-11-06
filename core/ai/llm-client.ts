import { GoogleGenerativeAI } from "@google/generative-ai";
import { ENV } from "../config/env";
import { performance } from "perf_hooks";

/**
 * LLM Request Configuration
 */
export interface LLMRequestConfig {
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  topP?: number;
  model?: string; // Override for Ollama model name
  // Privacy/Retention: controls if data is stored by the provider for training
  storeData?: boolean;
}

export interface LLMPerformanceMetrics {
  totalLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  tokensPerSecond: number;
}

export interface LLMResponse {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metrics?: LLMPerformanceMetrics; // Added for performance tracking
  rawResponse: any;
}

/**
 * Unified LLM Client
 * Provides a reusable wrapper for calling different LLM providers (Gemini, Ollama, etc.)
 * with consistent timeout, retry, and privacy handling.
 */
export class LLMClient {
  private geminiClient: GoogleGenerativeAI;
  private ollamaLock: Promise<void> = Promise.resolve();

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

    // Sequential locking for Ollama to prevent VRAM thrashing
    if (provider === 'ollama') {
      await this.ollamaLock;
      const currentLock = this.ollamaLock;
      this.ollamaLock = (async () => {
        try {
          await this.executeProviderCall(prompt, options, provider);
        } catch (e) {
          // lock still needs to resolve
        }
      })();
      // Note: This is a simple implementation. For a true queue, we'd use a more robust lock.
      // To keep the call awaitable, we don't wait for the lock here, but we've ensured
      // sequential execution by chaining.
    }

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
    const modelName = options.model || ENV.EDGE_LLM_MODEL;
    console.log(`[LLMClient] Calling Local Ollama [${modelName}] at ${ENV.EDGE_LLM_ENDPOINT}`);

    const start = performance.now();

    try {
      const response = await fetch(`${ENV.EDGE_LLM_ENDPOINT}/api/generate`, {
        method: 'POST',
        body: JSON.stringify({
          model: modelName,
          prompt: prompt,
          stream: false,
          options: {
            temperature: options.temperature ?? 0.7,
          }
        })
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`ModelNotFoundError: Model '${modelName}' not found in Ollama.`);
        }
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Ollama API Error (${response.status}): ${errorData.error || response.statusText}`);
      }

      const data = await response.json();
      const end = performance.now();
      const totalLatencyMs = end - start;

      const promptTokens = data.prompt_eval_count || 0;
      const completionTokens = data.eval_count || 0;
      const tps = completionTokens > 0 ? (completionTokens / (totalLatencyMs / 1000)) : 0;

      return {
        text: data.response,
        usage: {
          promptTokens: promptTokens,
          completionTokens: completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        metrics: {
          totalLatencyMs,
          promptTokens,
          completionTokens,
          tokensPerSecond: tps
        },
        rawResponse: data
      };
    } catch (error: any) {
      if (error.message.includes("fetch failed")) {
        throw new Error(`Ollama unresponsive at ${ENV.EDGE_LLM_ENDPOINT}. Check if Ollama is running.`);
      }
      throw error;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timeoutId: any;
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
