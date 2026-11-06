import { llmClient } from "../core/ai/llm-client";
import { ENV } from "../core/config/env";
import { execSync } from "child_process";

/**
 * Benchmarking Utility for Ollama Models
 * Tests MedGemma and Gemma sequentially and measures performance.
 */
async function benchmark() {
  const models = [
    { name: ENV.EDGE_LLM_MEDGEMMA, label: "MedGemma 4B" },
    { name: ENV.EDGE_LLM_GEMMA, label: "Gemma 4 E2B" },
  ];

  const prompts = [
    "Analyze the following symptoms: persistent cough, night sweats, and weight loss. What are the top 3 differential diagnoses?",
    "Explain the mechanism of action of ACE inhibitors in treating hypertension.",
    "A 45-year-old male presents with acute chest pain and shortness of breath. What are the immediate priority steps in the ER?",
    "Compare and contrast Type 1 and Type 2 Diabetes Mellitus in terms of pathophysiology.",
    "What are the key diagnostic criteria for Systemic Lupus Erythematosus (SLE)?",
  ];

  const results = [];

  console.log("🚀 Starting Ollama Model Benchmark...");
  console.log(`Testing on: ${ENV.EDGE_LLM_ENDPOINT}\n`);

  for (const model of models) {
    console.log(`\n--- Testing Model: ${model.label} (${model.name}) ---`);

    // Verify initial VRAM state
    try {
      console.log("Current Ollama state:");
      console.log(execSync("ollama ps").toString());
    } catch (e) {
      console.warn("Could not run 'ollama ps'");
    }

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      console.log(`Prompt ${i + 1}/${prompts.length}...`);

      try {
        const start = Date.now();
        const response = await llmClient.callLLM(prompt, { model: model.name }, 'ollama');
        const end = Date.now();

        results.push({
          model: model.label,
          prompt: i + 1,
          latency: response.metrics?.totalLatencyMs || (end - start),
          tps: response.metrics?.tokensPerSecond || 0,
          completionTokens: response.usage.completionTokens,
        });
      } catch (error: any) {
        console.error(`❌ Error with ${model.label} on prompt ${i + 1}: ${error.message}`);
        results.push({
          model: model.label,
          prompt: i + 1,
          latency: null,
          tps: 0,
          completionTokens: 0,
          error: error.message,
        });
      }
    }

    // Verify VRAM state after model run
    try {
      console.log("\nPost-run Ollama state:");
      console.log(execSync("ollama ps").toString());
    } catch (e) {
      console.warn("Could not run 'ollama ps'");
    }
  }

  console.log("\n\n=== Final Benchmark Results ===");
  console.table(results);

  // Summary analysis
  const summary = models.map(m => {
    const modelResults = results.filter(r => r.model === m.label && r.latency !== null);
    const avgLatency = modelResults.reduce((acc, r) => acc + r.latency, 0) / modelResults.length;
    const avgTps = modelResults.reduce((acc, r) => acc + r.tps, 0) / modelResults.length;
    return {
      Model: m.label,
      "Avg Latency (ms)": avgLatency.toFixed(2),
      "Avg TPS": avgTps.toFixed(2),
    };
  });

  console.log("\n=== Model Summary Comparison ===");
  console.table(summary);
}

benchmark().catch(console.error);
