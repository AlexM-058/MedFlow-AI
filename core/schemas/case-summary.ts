/**
 * Structured Case Summary Schema
 * This schema defines the output of the Patient AI (Edge)
 * and the input for the Doctor AI (Cloud).
 */

export interface CaseSummary {
  chiefComplaint: string;            // The primary reason the patient is seeking care
  onset: string;                     // When the symptoms started
  duration: string;                  // How long the symptoms have lasted
  pattern: string;                   // Constant, intermittent, worsening, etc.
  severity: number;                  // Scale 0-10
  associatedSymptoms: string[];      // Other symptoms reported
  currentMedications: string[];      // Medications the patient is currently taking
  allergiesConditions: string[];     // Known allergies or chronic conditions
  redFlagsDetected: boolean;          // Whether any emergency red-flags were triggered
  rawTranscript: string;             // The full conversation for doctor review
  metadata: {
    timestamp: string;
    patientId: string;
    language: 'ro' | 'en';
  };
}

export type CaseSummaryJSON = string; // The serialized version of the CaseSummary
