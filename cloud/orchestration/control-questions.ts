/**
 * Control questions: the cloud AI receives ONLY the anonymized patient summary and answers with a short
 * summary plus control questions. The local agent (gemma) then asks the patient those questions; the patient's
 * answers never go back to the cloud.
 *
 * The medical-safety rules are NOT left to the model: everything it returns is checked here with fixed rules
 * (shape, size, no dosing or treatment advice, no diagnosis). Whatever fails is dropped; if nothing usable is
 * left, the request fails instead of showing unchecked text to a patient. AI must not diagnose or prescribe.
 */
import { createHash } from 'node:crypto';
import { normalize } from '../../edge/anonymization/vocabulary';
import type { AnonymizedPatientSummary } from '../../edge/anonymization/summary';

export const ANSWER_TYPES = ['yes_no', 'number', 'short_text'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export interface ControlQuestion {
  id: string;
  text: string;
  answerType: AnswerType;
}

export interface ControlQuestionsResult {
  summary: string;
  questions: ControlQuestion[];
  /** How many proposed questions were rejected by the fixed safety rules. */
  rejectedQuestionCount: number;
}

export const MAX_QUESTIONS = 8;
const MAX_QUESTION_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 600;

/**
 * Text that gives treatment instructions, doses or a diagnosis. A control question only COLLECTS information:
 * it may never tell the patient to stop or change anything, name a dose, or state what they have. ("Luați X?" is a
 * question and is allowed; "trebuie să luați" and dose amounts are not.)
 * Matched on normalized text (no diacritics), as word prefixes. Wide on purpose: a dropped question is cheap.
 */
const UNSAFE = new RegExp(
  String.raw`\b(administrati|incepeti|opriti|intrerupeti|schimbati|cresteti|scadeti|reduceti|dubleaza\w*|dozaj\w*|doza|diagnostic\w*|prescri\w*|trebui\w* sa|aveti (cu siguranta|probabil)|suferiti de|tratament cu)\b|\d+\s?(mg|mcg|ml|ui|g|comprimate?)\b`,
);

const SLUG = /^[a-z][a-z0-9_-]{0,29}$/;

/** Fixed, deterministic summary built from the facts: used when the model's own summary is missing or unsafe. */
export function deterministicSummary(summary: AnonymizedPatientSummary): string {
  const parts: string[] = [];
  if (summary.ageBand) parts.push(`Interval de vârstă ${summary.ageBand} ani`);
  if (summary.conditions.length) parts.push(`afecțiuni: ${summary.conditions.join(', ')}`);
  if (summary.medications.length) parts.push(`medicație: ${summary.medications.join(', ')}`);
  if (summary.allergies.length) parts.push(`alergii: ${summary.allergies.join(', ')}`);
  if (summary.labFindings.length) parts.push(`analize: ${summary.labFindings.map((lab) => `${lab.test} ${lab.level}`).join(', ')}`);
  return parts.length ? `${parts.join('; ')}.` : 'Nu există fapte confirmate în dosar.';
}

export function buildControlQuestionsPrompt(summary: AnonymizedPatientSummary): string {
  return `Ești asistentul MedFlow care pregătește întrebări de control pentru un pacient, pe baza unui rezumat anonimizat al dosarului său medical.

TON ȘI ABORDARE:
- Vorbește cu empatie, calm și respect. Ia în serios ceea ce relatează pacientul, fără să judeci, să învinovățești sau să minimalizezi.
- Formulează întrebările într-un mod firesc, clar și blând, fără presiune sau reproș. Nu presupune ce simte pacientul și nu oferi reasigurări nejustificate.
- Rezumatul rămâne factual și neutru; nu adăuga formule de empatie care sugerează informații sau emoții neconfirmate.

REGULI:
- Nu pui diagnostic, nu recomanzi tratament, nu menționezi doze și nu spui pacientului să ia, să oprească sau să schimbe ceva.
- Întrebările doar COLECTEAZĂ informații pentru medic: lipsuri din dosar, cum se simte acum, ce s-a schimbat, ce medicamente ia efectiv.
- Cel mult ${MAX_QUESTIONS} întrebări, scurte, clare, în limba română, fiecare terminată cu semnul întrebării.
- Rezumatul este factual, scurt, doar din datele de mai jos. Nu inventa nimic.
- Datele sunt anonimizate; nu cere și nu presupune nume, adrese, telefoane sau date exacte.

REZUMAT ANONIMIZAT (JSON):
${JSON.stringify(summary)}

Returnează DOAR acest JSON:
{
  "summary": "rezumat factual de 1-3 propoziții",
  "questions": [
    { "id": "q1", "text": "întrebare?", "answerType": "yes_no" | "number" | "short_text" }
  ]
}`;
}

/** The first JSON object in the model's answer (it may be wrapped in a markdown block). */
function extractJson(raw: string): unknown {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) throw new Error('No JSON object found in the model response');
  return JSON.parse(match[0]);
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function isUnsafeText(text: string): boolean {
  return UNSAFE.test(normalize(text));
}

/**
 * Checks the model's answer with fixed rules and returns only what passed. Throws when no question is usable.
 */
export function parseControlQuestions(raw: string, summary: AnonymizedPatientSummary): ControlQuestionsResult {
  const parsed = extractJson(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) throw new Error('Malformed control questions response');

  let rejected = 0;
  const seenIds = new Set<string>();
  const questions: ControlQuestion[] = [];
  for (const entry of parsed.questions) {
    const valid = isRecord(entry)
      && typeof entry.id === 'string' && SLUG.test(entry.id) && !seenIds.has(entry.id)
      && typeof entry.text === 'string' && entry.text.trim().length >= 8 && entry.text.trim().length <= MAX_QUESTION_LENGTH
      && entry.text.trim().endsWith('?') && !isUnsafeText(entry.text)
      && typeof entry.answerType === 'string' && (ANSWER_TYPES as readonly string[]).includes(entry.answerType);
    if (!valid || questions.length >= MAX_QUESTIONS) { rejected += 1; continue; }
    const record = entry as Record<string, string>;
    seenIds.add(record.id as string);
    questions.push({ id: record.id as string, text: (record.text as string).trim(), answerType: record.answerType as AnswerType });
  }
  if (questions.length === 0) throw new Error('No usable control question after the safety checks');

  const text = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const usable = text.length > 0 && text.length <= MAX_SUMMARY_LENGTH && !isUnsafeText(text);
  return { summary: usable ? text : deterministicSummary(summary), questions, rejectedQuestionCount: rejected };
}

/** Hash of exactly what leaves for the cloud (for the disclosure log: the hash, never the content). */
export function payloadHash(summary: AnonymizedPatientSummary): string {
  return createHash('sha256').update(JSON.stringify(summary)).digest('hex');
}
