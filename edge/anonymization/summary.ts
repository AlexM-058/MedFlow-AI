/**
 * Anonymized patient summary: the ONLY description of a patient that may leave the laptop for the cloud AI.
 *
 * The medical file (reviewed documents + the patient's declared context) is projected into this closed
 * shape. Nothing is "cleaned": a field either becomes a term from the closed vocabularies / a coarse
 * bucket, or it stays local and is only counted. So a name, an address, a CNP, an exact date or any free
 * text cannot appear, whatever the input contained.
 *
 *   direct identifiers  never forwarded          name, CNP, address, phone, email, birth date
 *   quasi-identifiers   generalized              age -> decade band, dates dropped, places dropped
 *   medical facts       vocabulary terms only    conditions, allergies, active substances
 *   lab values          level only               low / normal / high (no numbers)
 *   free text           never forwarded
 *
 * Legally this is pseudonymized health data, not anonymous data: combinations (a rare condition plus a
 * narrow age band) can still single someone out. Keep the vocabularies and bands coarse.
 */
import {
  ALLERGEN_LOOKUP,
  ALLERGEN_TERMS,
  CONDITION_LOOKUP,
  CONDITION_TERMS,
  LAB_TEST_LOOKUP,
  LAB_TEST_TERMS,
  SUBSTANCE_LOOKUP,
  SUBSTANCE_TERMS,
  normalize,
  type Lookup,
} from './vocabulary';

export const AGE_BANDS = ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80+'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
export const LAB_LEVELS = ['low', 'normal', 'high'] as const;
export type LabLevel = (typeof LAB_LEVELS)[number];

export interface AnonymizedPatientSummary {
  version: 1;
  ageBand: AgeBand | null;
  sex: 'F' | 'M' | null;
  conditions: string[];
  allergies: string[];
  medications: string[];
  labFindings: { test: string; level: LabLevel }[];
  /** How many items of the file were NOT sent (unreviewed, not in the vocabulary, unclear). Only a count. */
  omittedItemCount: number;
}

/** What the Backend reads from the medical file. Everything here stays on the laptop except the projection. */
export interface DossierInput {
  /** ISO date YYYY-MM-DD. Never forwarded: only the decade band is. */
  birthDate?: string | null;
  sex?: string | null;
  documents: {
    /** The patient reviewed this document (medical_documents.review is set). Unreviewed documents send nothing. */
    reviewed: boolean;
    /**
     * The patient also confirmed the diagnoses and lab results (today the review covers only the medications).
     * Default false: until a review exists for them, diagnoses and lab results stay local.
     */
    diagnosesAndLabsConfirmed?: boolean;
    /**
     * ISO date (YYYY-MM-DD) of the document, used ONLY here to pick the most recent lab result when a file has
     * many documents. It is never forwarded. See toIsoDate() for converting the text found in the document.
     */
    documentDate?: string | null;
    medications: { name: string | null }[];
    diagnoses: string[];
    labResults: { test: string | null; value: string | null; referenceRange: string | null }[];
  }[];
  /** The patient's declared allergies, conditions and medication (free text typed by the patient). */
  contextItems: { kind: 'allergy' | 'condition' | 'medication'; text: string; confirmed: boolean }[];
  now: Date;
}

const MAX_PER_LIST = 30;
const MAX_OMITTED = 99;

// Words that make a statement NOT "the patient has X": negation, doubt, or someone else. Matched as word
// prefixes on normalized text (no diacritics). Deliberately wide: omitting a real fact is safe (the doctor
// still sees the original), presenting an absent or someone else's condition as the patient's is not.
const NOT_A_CONFIRMED_FACT =
  /\b(nu|fara|nici|negat\w*|neag\w*|exclus\w*|absent\w*|infirm\w*|suspici\w*|posibil\w*|probabil\w*|risc\w*|mama\w*|mamei|tata\w*|tatal|tatei|parint\w*|frate\w*|sora|surori|bunic\w*|famili\w*|ereditar\w*)\b/;

/** Alias that appears as whole words inside `text`; the canonical terms found, or [] if doubtful/unknown. */
function findTerms(text: string, lookup: Lookup): string[] {
  const normalized = normalize(text);
  if (!normalized || NOT_A_CONFIRMED_FACT.test(normalized)) return [];
  const padded = ` ${normalized} `;
  const hits: [alias: string, canonical: string][] = [];
  for (const [alias, canonical] of lookup) {
    if (alias.length < 3) continue; // a 1-2 letter alias would match inside ordinary words
    if (padded.includes(` ${alias} `)) hits.push([alias, canonical]);
  }
  // The most specific expression wins: "amoxicilina acid clavulanic" must not also add "amoxicilina".
  const specific = hits.filter(([alias]) => !hits.some(([other]) => other.length > alias.length && ` ${other} `.includes(` ${alias} `)));
  return [...new Set(specific.map(([, canonical]) => canonical))];
}

/** The whole field must be exactly a known alias (used for short lab names such as "k", "na", "alt"). */
function exactTerm(text: string | null, lookup: Lookup): string | null {
  return typeof text === 'string' ? (lookup.get(normalize(text)) ?? null) : null;
}

export function ageBandFor(birthDate: string | null | undefined, now: Date): AgeBand | null {
  const match = typeof birthDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const real = new Date(Date.UTC(year, month - 1, day));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return null; // 2000-02-30
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)) age -= 1;
  if (!Number.isFinite(age) || age < 0 || age > 120) return null;
  return AGE_BANDS[Math.min(Math.floor(age / 10), 8)] ?? null;
}

// Lab parsing accepts ONLY unambiguous, fully anchored forms; anything else returns null (stays local).
// Units are not converted: a value and a range in different units cannot be told apart here, so keep the
// reference range printed next to the value (same laboratory report) as the only supported pairing.
const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(?:\s*(?!e\d)[A-Za-zµ%/][A-Za-zµ%/0-9^.*]*)?`;
const VALUE_RE = new RegExp(String.raw`^\s*${NUMBER}${UNIT}\s*$`);
const BETWEEN_RE = new RegExp(String.raw`^\s*${NUMBER}\s*[-–—]\s*${NUMBER}${UNIT}\s*$`);
const LIMIT_RE = new RegExp(String.raw`^\s*(<=|>=|<|>|≤|≥)\s*${NUMBER}${UNIT}\s*$`);

interface Range { min?: number; max?: number; minInclusive: boolean; maxInclusive: boolean }

function toNumber(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function parseRange(text: string | null): Range | null {
  if (typeof text !== 'string') return null;
  const between = BETWEEN_RE.exec(text);
  if (between) {
    const min = toNumber(between[1]);
    const max = toNumber(between[2]);
    return min !== null && max !== null && min <= max ? { min, max, minInclusive: true, maxInclusive: true } : null;
  }
  const limit = LIMIT_RE.exec(text);
  if (limit) {
    const bound = toNumber(limit[2]);
    if (bound === null) return null;
    const inclusive = limit[1] === '<=' || limit[1] === '>=' || limit[1] === '≤' || limit[1] === '≥';
    return limit[1] === '<' || limit[1] === '<=' || limit[1] === '≤'
      ? { max: bound, minInclusive: true, maxInclusive: inclusive }
      : { min: bound, minInclusive: inclusive, maxInclusive: true };
  }
  return null;
}

export function labLevel(value: string | null, referenceRange: string | null): LabLevel | null {
  const match = typeof value === 'string' ? VALUE_RE.exec(value) : null;
  const number = match ? toNumber(match[1]) : null;
  const range = parseRange(referenceRange);
  if (number === null || !range) return null;
  if (range.min !== undefined && (number < range.min || (number === range.min && !range.minInclusive))) return 'low';
  if (range.max !== undefined && (number > range.max || (number === range.max && !range.maxInclusive))) return 'high';
  return 'normal';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Text date found in a document -> ISO date, or null. Accepts dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy and yyyy-mm-dd. */
export function toIsoDate(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const dmy = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s*$/.exec(text);
  const ymd = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(text);
  const [year, month, day] = dmy ? [dmy[3], dmy[2], dmy[1]] : ymd ? [ymd[1], ymd[2], ymd[3]] : [];
  if (!year || !month || !day) return null;
  const [y, m, d] = [Number(year), Number(month), Number(day)];
  const real = new Date(Date.UTC(y, m - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Level of the most recent dated result; undated results only count when no result is dated. */
function latestLevel(results: { date: string | null; level: LabLevel }[]): LabLevel | null {
  const dated = results.filter((entry) => entry.date !== null);
  const newest = dated.reduce<string | null>((max, entry) => (max === null || (entry.date ?? '') > max ? entry.date : max), null);
  const pool = newest === null ? results : dated.filter((entry) => entry.date === newest);
  const levels = new Set(pool.map((entry) => entry.level));
  const [only] = levels;
  return levels.size === 1 && only ? only : null;
}

/** Sorted, de-duplicated, capped list; `dropped` = how many did not fit (counted as omitted, never silent). */
function capList(values: Iterable<string>): { list: string[]; dropped: number } {
  const all = [...new Set(values)].sort((a, b) => a.localeCompare(b, 'ro'));
  return { list: all.slice(0, MAX_PER_LIST), dropped: Math.max(0, all.length - MAX_PER_LIST) };
}

function arrayOf<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new TypeError(`Dossier refused: ${what} is not a list`);
  return value as T[];
}

/**
 * Projects the medical file into the closed summary. Pure and deterministic: no model, no network.
 * The input is checked at runtime (it comes from the database): malformed input is refused, not guessed.
 */
export function anonymizeDossier(input: DossierInput): AnonymizedPatientSummary {
  let omitted = 0;
  const conditions = new Set<string>();
  const allergies = new Set<string>();
  const medications = new Set<string>();
  const labResultsByTest = new Map<string, { date: string | null; level: LabLevel }[]>();

  for (const document of arrayOf<DossierInput['documents'][number]>(input.documents, 'documents')) {
    const meds = arrayOf<{ name: string | null }>(document.medications, 'medications');
    const diagnoses = arrayOf<string>(document.diagnoses, 'diagnoses');
    const labResults = arrayOf<{ test: string | null; value: string | null; referenceRange: string | null }>(document.labResults, 'labResults');
    if (document.reviewed !== true) { omitted += meds.length + diagnoses.length + labResults.length; continue; }

    for (const medication of meds) {
      const terms = typeof medication?.name === 'string' ? findTerms(medication.name, SUBSTANCE_LOOKUP) : [];
      if (terms.length === 0) omitted += 1;
      terms.forEach((term) => medications.add(term));
    }
    if (document.diagnosesAndLabsConfirmed !== true) { omitted += diagnoses.length + labResults.length; continue; }
    for (const diagnosis of diagnoses) {
      const terms = typeof diagnosis === 'string' ? findTerms(diagnosis, CONDITION_LOOKUP) : [];
      if (terms.length === 0) omitted += 1;
      terms.forEach((term) => conditions.add(term));
    }
    for (const lab of labResults) {
      const test = exactTerm(lab?.test ?? null, LAB_TEST_LOOKUP);
      const level = labLevel(lab?.value ?? null, lab?.referenceRange ?? null);
      if (!test || !level) { omitted += 1; continue; }
      const date = typeof document.documentDate === 'string' && ISO_DATE.test(document.documentDate) ? document.documentDate : null;
      labResultsByTest.set(test, [...(labResultsByTest.get(test) ?? []), { date, level }]);
    }
  }

  for (const item of arrayOf<DossierInput['contextItems'][number]>(input.contextItems, 'contextItems')) {
    if (item?.confirmed !== true || typeof item.text !== 'string') { omitted += 1; continue; }
    const terms = item.kind === 'allergy' ? findTerms(item.text, ALLERGEN_LOOKUP)
      : item.kind === 'condition' ? findTerms(item.text, CONDITION_LOOKUP)
        : item.kind === 'medication' ? findTerms(item.text, SUBSTANCE_LOOKUP) : [];
    if (terms.length === 0) omitted += 1;
    const target = item.kind === 'allergy' ? allergies : item.kind === 'condition' ? conditions : medications;
    terms.forEach((term) => target.add(term));
  }

  // Many documents repeat the same test over time: the most recent dated result decides. Without dates, or
  // with two different results on the same day, the order of the file must not decide, so nothing is sent.
  const labs: { test: string; level: LabLevel }[] = [];
  for (const [test, results] of labResultsByTest) {
    const level = latestLevel(results);
    if (level) labs.push({ test, level });
    else omitted += 1;
  }
  labs.sort((a, b) => a.test.localeCompare(b.test, 'ro'));

  const capped = [capList(conditions), capList(allergies), capList(medications)];
  omitted += capped.reduce((sum, entry) => sum + entry.dropped, 0) + Math.max(0, labs.length - MAX_PER_LIST);

  return assertAnonymousSummary({
    version: 1,
    ageBand: ageBandFor(input.birthDate, input.now),
    sex: input.sex === 'F' || input.sex === 'M' ? input.sex : null,
    conditions: capped[0]?.list ?? [],
    allergies: capped[1]?.list ?? [],
    medications: capped[2]?.list ?? [],
    labFindings: labs.slice(0, MAX_PER_LIST),
    omittedItemCount: Math.min(omitted, MAX_OMITTED),
  });
}

const SUMMARY_KEYS = ['version', 'ageBand', 'sex', 'conditions', 'allergies', 'medications', 'labFindings', 'omittedItemCount'];

function refuse(field: string): never {
  throw new TypeError(`Anonymized summary refused: ${field}`);
}

/** A plain object with EXACTLY these own data properties: no accessors, no symbols, no hidden extras (toJSON). */
function readRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(field === 'summary' ? 'not an object' : field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) refuse(field);
  if (Object.getOwnPropertySymbols(value).length > 0) refuse(field);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || keys.some((key) => !names.includes(key))) refuse(field === 'summary' ? 'unexpected or missing field' : field);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) refuse(field);
    out[key] = descriptor.value;
  }
  return out;
}

/** A plain array with only real, own data elements: no holes, accessors, hidden extras or a custom toJSON. */
function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) refuse(field);
  if (value.length > MAX_PER_LIST || Object.getOwnPropertyNames(value).length !== value.length + 1) refuse(field);
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) refuse(field);
    out.push(descriptor.value);
  }
  return out;
}

function readTerms(value: unknown, allowed: ReadonlySet<string>, field: string): string[] {
  return readArray(value, field).map((term) => {
    if (typeof term !== 'string' || !allowed.has(term)) refuse(`${field} has a value outside the vocabulary`);
    return term;
  });
}

/**
 * Last gate before anything is sent (fail-closed). It does not just check the object it is given: it BUILDS a
 * new frozen object from the validated primitive values and returns that, so what is serialized afterwards is
 * exactly what was validated (no getter, toJSON or inherited property can swap the content later).
 * Throws on anything that is not exactly the closed shape with terms from the vocabularies.
 */
export function assertAnonymousSummary(value: unknown): AnonymizedPatientSummary {
  const summary = readRecord(value, SUMMARY_KEYS, 'summary');
  if (summary.version !== 1) refuse('version');
  const ageBand = summary.ageBand;
  if (ageBand !== null && !AGE_BANDS.includes(ageBand as AgeBand)) refuse('ageBand');
  const sex = summary.sex;
  if (sex !== null && sex !== 'F' && sex !== 'M') refuse('sex');
  const labFindings = readArray(summary.labFindings, 'labFindings').map((entry) => {
    const lab = readRecord(entry, ['test', 'level'], 'labFindings');
    if (typeof lab.test !== 'string' || !LAB_TEST_TERMS.has(lab.test) || !LAB_LEVELS.includes(lab.level as LabLevel)) refuse('labFindings');
    return Object.freeze({ test: lab.test, level: lab.level as LabLevel });
  });
  const omitted = summary.omittedItemCount;
  if (typeof omitted !== 'number' || !Number.isSafeInteger(omitted) || omitted < 0 || omitted > MAX_OMITTED) refuse('omittedItemCount');

  return Object.freeze({
    version: 1 as const,
    ageBand: ageBand as AgeBand | null,
    sex: sex as 'F' | 'M' | null,
    conditions: Object.freeze(readTerms(summary.conditions, CONDITION_TERMS, 'conditions')) as string[],
    allergies: Object.freeze(readTerms(summary.allergies, ALLERGEN_TERMS, 'allergies')) as string[],
    medications: Object.freeze(readTerms(summary.medications, SUBSTANCE_TERMS, 'medications')) as string[],
    labFindings: Object.freeze(labFindings) as { test: string; level: LabLevel }[],
    omittedItemCount: omitted,
  });
}
