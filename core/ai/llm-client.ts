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
  numCtx?: number; // Ollama context window (smaller = less VRAM)
  keepAlive?: string; // Ollama keep_alive, e.g. "10m"
  // Privacy/Retention: controls if data is stored by the provider for training
  storeData?: boolean;
}

export interface LLMPerformanceMetrics {
  totalLatencyMs: number;
  loadDurationMs: number; // model load time (cold start)
  promptTokens: number;
  completionTokens: number;
  tokensPerSecond: number; // pure generation speed (excludes load + prompt eval)
}

export interface LLMResponse {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  metrics?: LLMPerformanceMetrics;
  rawResponse: any;
}

type Provider = "gemini" | "ollama";

/**
 * Unified LLM Client
 * Reusable wrapper for calling different LLM providers (Gemini, Ollama)
 * with consistent timeout, retry, and cancellation handling.
 */
export class LLMClient {
  private geminiClient: GoogleGenerativeAI;
  private ollamaLock: Promise<void> = Promise.resolve();

  constructor() {
    this.geminiClient = new GoogleGenerativeAI(ENV.GEMINI_API_KEY || "");
  }

  /**
   * Reusable function to call an LLM
   */
  async callLLM(
    prompt: string,
    options: LLMRequestConfig = {},
    provider: Provider = "gemini"
  ): Promise<LLMResponse> {
    // Local models need far more time, especially on cold start with 4GB VRAM
    const timeout = options.timeoutMs ?? (provider === "ollama" ? 180000 : 30000);
    // Retrying a timed-out local call only wastes GPU time and ruins benchmarks
    const maxRetries = options.maxRetries ?? (provider === "ollama" ? 1 : 3);

    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        if (provider === "ollama") {
          // Sequential execution. The timeout starts when the request actually
          // begins running (inside the lock), not when it is queued.
          const run = this.ollamaLock.then(() =>
            this.withTimeout(
              (signal) => this.callOllama(prompt, options, signal),
              timeout
            )
          );
          // Lock is released on success, failure OR timeout (the fetch is aborted)
          this.ollamaLock = run.then(
            () => {},
            () => {}
          );
          return await run;
        }

        return await this.withTimeout(
          () => this.callGemini(prompt, options),
          timeout
        );
      } catch (error: any) {
        attempt++;
        console.warn(`[LLMClient] Attempt ${attempt} failed: ${error.message}`);

        const fatal =
          error.message.includes("ModelNotFoundError") ||
          error.message.includes("Unsupported LLM provider");

        if (fatal || attempt >= maxRetries) {
          throw new Error(
            `LLM call failed after ${attempt} attempt(s). Last error: ${error.message}`
          );
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt) * 1000)
        );
      }
    }
    throw new Error("Unexpected LLMClient failure");
  }

  /**
   * Warm-up: loads the model into VRAM so the first benchmark run
   * doesn't include model load time.
   */
  async warmUp(options: LLMRequestConfig = {}): Promise<void> {
    console.log("[LLMClient] Warming up Ollama model...");
    await this.callLLM(
      "hi",
      { ...options, timeoutMs: options.timeoutMs ?? 300000, maxRetries: 1 },
      "ollama"
    );
    console.log("[LLMClient] Warm-up done.");
  }

  private async callGemini(
    prompt: string,
    options: LLMRequestConfig
  ): Promise<LLMResponse> {
    console.log(`[LLMClient] Calling Gemini 3 Flash (storeData: ${options.storeData})`);

    const model = this.geminiClient.getGenerativeModel({
      model: "gemini-3-flash-preview",
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        topP: options.topP ?? 0.95,
      },
    });

    const start = performance.now();
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    const totalLatencyMs = performance.now() - start;

    const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: response.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens,
      },
      metrics: {
        totalLatencyMs,
        loadDurationMs: 0,
        promptTokens,
        completionTokens,
        tokensPerSecond:
          completionTokens > 0 ? completionTokens / (totalLatencyMs / 1000) : 0,
      },
      rawResponse: response,
    };
  }

  private async callOllama(
    prompt: string,
    options: LLMRequestConfig,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const modelName = options.model || ENV.EDGE_LLM_MODEL;
    console.log(`[LLMClient] Calling Local Ollama [${modelName}] at ${ENV.EDGE_LLM_ENDPOINT}`);

    const start = performance.now();

    try {
      const response = await fetch(`${ENV.EDGE_LLM_ENDPOINT}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal, // aborting cancels the request, and Ollama stops generating
        body: JSON.stringify({
          model: modelName,
          prompt,
          stream: false,
          keep_alive: options.keepAlive ?? "10m", // keep model loaded between runs
          options: {
            temperature: options.temperature ?? 0.7,
            top_p: options.topP ?? 0.95,
            num_ctx: options.numCtx ?? 2048, // smaller KV cache = less VRAM
          },
        }),
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`ModelNotFoundError: Model '${modelName}' not found in Ollama.`);
        }
        const errorData: any = await response.json().catch(() => ({}));
        throw new Error(
          `Ollama API Error (${response.status}): ${errorData.error || response.statusText}`
        );
      }

      const data: any = await response.json();
      const totalLatencyMs = performance.now() - start;

      const promptTokens = data.prompt_eval_count || 0;
      const completionTokens = data.eval_count || 0;

      // Ollama reports durations in nanoseconds. Use pure generation time
      // so model load and prompt processing don't skew tokens/s.
      const tokensPerSecond = data.eval_duration
        ? completionTokens / (data.eval_duration / 1e9)
        : completionTokens > 0
        ? completionTokens / (totalLatencyMs / 1000)
        : 0;

      return {
        text: data.response,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        metrics: {
          totalLatencyMs,
          loadDurationMs: (data.load_duration || 0) / 1e6,
          promptTokens,
          completionTokens,
          tokensPerSecond,
        },
        rawResponse: data,
      };
    } catch (error: any) {
      if (error.name === "AbortError") throw error; // handled by withTimeout
      if (
        error.message?.includes("fetch failed") ||
        error.cause?.code === "ECONNREFUSED"
      ) {
        throw new Error(
          `Ollama unresponsive at ${ENV.EDGE_LLM_ENDPOINT}. Check if Ollama is running.`
        );
      }
      throw error;
    }
  }

  /**
   * Runs fn with an AbortSignal. On timeout the signal is aborted (cancelling
   * the underlying fetch) and the returned promise rejects immediately.
   */
  private async withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    ms: number
  ): Promise<T> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`LLM call timed out after ${ms}ms`));
      }, ms);
    });

    try {
      return await Promise.race([fn(controller.signal), timeoutPromise]);
    } catch (e: any) {
      if (controller.signal.aborted) {
        throw new Error(`LLM call timed out after ${ms}ms`);
      }
      throw e;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

export const llmClient = new LLMClient();