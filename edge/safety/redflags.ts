/**
 * Red Flag Detector
 * Deterministic rule layer to intercept emergency symptoms
 * and trigger immediate warnings, bypassing the LLM.
 */

export interface RedFlagResult {
  isEmergency: boolean;
  message: string;
}

// KEEP IN SYNC with MedFlow-Backend/src/redFlags.ts: the Backend has its own copy of these rules
// (it checks every patient message, even when this AI service is down). Same phrases, same matching.
//
// Matching works on NORMALIZED text: lower case, no diacritics (both ș/ş and ț/ţ), punctuation
// turned into spaces, whole words only. So "DURERE ÎN PIEPT", "durere in piept" and "dureri în piept,"
// all match. Romanian AND English phrases are always checked, whatever the case language.

const MESSAGES = {
  emergency: {
    ro: "ATENȚIE: Simptomele raportate pot indica o urgență medicală. Vă rugăm să contactați imediat serviciul de urgență 112.",
    en: "WARNING: The reported symptoms may indicate a medical emergency. Please contact emergency services (112/911) immediately.",
  },
  suicide: {
    ro: "Vă rugăm să contactați imediat o linie de ajutor pentru prevenirea suicidului sau serviciul de urgență 112.",
    en: "Please contact a suicide prevention lifeline or emergency services (112/911) immediately.",
  },
};

// Order matters: the first matching rule wins. Suicide is first because it has a specific message.
const RED_FLAG_RULES: { phrases: string[]; message: keyof typeof MESSAGES }[] = [
  {
    message: "suicide",
    phrases: ["idei suicidare", "ganduri suicidare", "vreau sa ma sinucid", "vreau sa mor", "nu mai vreau sa traiesc",
      "suicidal ideation", "suicidal thoughts", "want to kill myself", "want to die"],
  },
  {
    message: "emergency", // chest pain
    phrases: ["durere in piept", "dureri in piept", "durere la piept", "dureri la piept", "tensiune in piept",
      "apasare in piept", "ma doare pieptul", "ma doare in piept", "chest pain", "tightness in chest", "my chest hurts"],
  },
  {
    message: "emergency", // breathing difficulty
    phrases: ["dificultate de respiratie", "dificultati de respiratie", "nu pot respira", "nu mai pot respira",
      "nu pot sa respir", "ma sufoc", "difficulty breathing", "cannot breathe", "can't breathe"],
  },
  {
    message: "emergency", // stroke signs
    phrases: ["accident vascular cerebral", "avc", "paralizie faciala", "vorbire neclara",
      "stroke signs", "having a stroke", "facial paralysis", "slurred speech"],
  },
  {
    message: "emergency", // loss of consciousness
    phrases: ["am lesinat", "a lesinat", "lesin", "mi-am pierdut cunostinta", "fainted", "passed out"],
  },
];

/** "Mă DOARE pieptul!!" -> "ma doare pieptul" */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // drop the accents split off by NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Checks if the user input contains any red-flag symptoms.
 * @param input The user's message.
 * @param lang Only chooses the LANGUAGE OF THE WARNING ('ro' or 'en'); both phrase lists are always checked.
 */
export function detectRedFlags(input: string, lang: 'ro' | 'en' = 'ro'): RedFlagResult {
  const text = " " + normalizeText(input) + " ";

  for (const rule of RED_FLAG_RULES) {
    for (const phrase of rule.phrases) {
      if (text.includes(" " + normalizeText(phrase) + " ")) {
        return { isEmergency: true, message: MESSAGES[rule.message][lang] };
      }
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
