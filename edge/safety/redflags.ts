/**
 * Red Flag Detector
 * Deterministic rule layer to intercept emergency symptoms
 * and trigger immediate warnings, bypassing the LLM.
 */

export interface RedFlagResult {
  isEmergency: boolean;
  message: string;
}

const RED_FLAGS_RO = [
  { pattern: /durere în piept|tensiune în piept/i, message: "ATENȚIE: Simptomele raportate pot indica o urgență medicală. Vă rugăm să contactați imediat serviciul de urgență 112." },
  { pattern: /dificultate de respirație|nu pot respira/i, message: "ATENȚIE: Simptomele raportate pot indica o urgență medicală. Vă rugăm să contactați imediat serviciul de urgență 112." },
  { pattern: /semne de accident vascular cerebral|paralizie facială|vorbire neclară/i, message: "ATENȚIE: Simptomele raportate pot indica o urgență medicală. Vă rugăm să contactați imediat serviciul de urgență 112." },
  { pattern: /idei suicidare|vreau să mă sinucid/i, message: "Vă rugăm să contactați imediat o linie de ajutor pentru prevenirea suicidului sau serviciul de urgență 112." },
];

const RED_FLAGS_EN = [
  { pattern: /chest pain|tightness in chest/i, message: "WARNING: The reported symptoms may indicate a medical emergency. Please contact emergency services (112/911) immediately." },
  { pattern: /difficulty breathing|cannot breathe/i, message: "WARNING: The reported symptoms may indicate a medical emergency. Please contact emergency services (112/911) immediately." },
  { pattern: /stroke signs|facial paralysis|slurred speech/i, message: "WARNING: The reported symptoms may indicate a medical emergency. Please contact emergency services (112/911) immediately." },
  { pattern: /suicidal ideation|want to kill myself/i, message: "Please contact a suicide prevention lifeline or emergency services (112/911) immediately." },
];

/**
 * Checks if the user input contains any red-flag symptoms.
 * @param input The user's message.
 * @param lang The language of the input ('ro' or 'en').
 */
export function detectRedFlags(input: string, lang: 'ro' | 'en' = 'ro'): RedFlagResult {
  const rules = lang === 'ro' ? RED_FLAGS_RO : RED_FLAGS_EN;

  for (const rule of rules) {
    if (rule.pattern.test(input)) {
      return { isEmergency: true, message: rule.message };
    }
  }

  return { isEmergency: false, message: "" };
}

/**
 * Guardrail to prevent Patient AI from providing medical advice.
 */
export function checkMedicalAdviceGuardrail(output: string): { violated: boolean; suggestedCorrection: string } {
  const advicePatterns = [
    /recomand să luați/i, /iați pastile/i, /diagnosticul este/i, /tratamentul este/i,
    /recommend taking/i, /take these pills/i, /the diagnosis is/i, /the treatment is/i
  ];

  for (const pattern of advicePatterns) {
    if (pattern.test(output)) {
      return {
        violated: true,
        suggestedCorrection: "I cannot provide diagnoses or medication recommendations. I am here to help gather your symptoms for the doctor, who will review everything and provide the appropriate care."
      };
    }
  }

  return { violated: false, suggestedCorrection: "" };
}
