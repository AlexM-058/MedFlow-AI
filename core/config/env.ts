import dotenv from 'dotenv';

dotenv.config();

/**
 * Environment Configuration
 * Centralized utility to access environment variables with basic validation.
 */
export const ENV = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  EDGE_LLM_ENDPOINT: process.env.EDGE_LLM_ENDPOINT || 'http://localhost:11434',
  EDGE_LLM_MODEL: process.env.EDGE_LLM_MODEL || 'llama3',
  EDGE_LLM_MEDGEMMA: process.env.EDGE_LLM_MEDGEMMA || 'medgemma1.5:4b',
  EDGE_LLM_GEMMA: process.env.EDGE_LLM_GEMMA || 'gemma4:e2b',
};

/**
 * Validates that all required environment variables are present.
 * Should be called during application startup.
 */
export function validateEnv() {
  const missing = [];
  if (!ENV.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. Please check your .env file.`);
  }
}
