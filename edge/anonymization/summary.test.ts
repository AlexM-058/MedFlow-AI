// Tests for the anonymized patient summary. All data below is SYNTHETIC (invented names, CNPs, addresses).
// Run: npx tsx --test edge/anonymization/summary.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONDITION_TERMS, normalize } from './vocabulary';
import { ageBandFor, anonymizeDossier, assertAnonymousSummary, labLevel, type DossierInput } from './summary';

const now = new Date('2026-11-07T10:00:00Z');

function dossier(overrides: Partial<DossierInput> = {}): DossierInput {
  return { birthDate: '1980-03-14', sex: 'F', documents: [], contextItems: [], now, ...overrides };
}

test('age becomes a decade band and the birth date never appears', () => {
  assert.equal(ageBandFor('1980-03-14', now), '40-49');
  assert.equal(ageBandFor('1980-12-31', now), '40-49'); // birthday not reached yet: still 45
  assert.equal(ageBandFor('2026-01-01', now), '0-9');
  assert.equal(ageBandFor('1930-05-05', now), '80+');
  assert.equal(ageBandFor('not a date', now), null);
  assert.equal(ageBandFor('2030-01-01', now), null); // born in the future
  assert.equal(ageBandFor(null, now), null);
  assert.doesNotMatch(JSON.stringify(anonymizeDossier(dossier())), /1980|03-14/);
});

test('only reviewed documents contribute; unreviewed content stays local and is only counted', () => {
  const doc = (reviewed: boolean, diagnosesAndLabsConfirmed = true) => ({
    reviewed,
    diagnosesAndLabsConfirmed,
    medications: [{ name: 'Amlodipină' }],
    diagnoses: ['Hipertensiune arterială esențială (I10)'],
    labResults: [{ test: 'Glicemie', value: '130', referenceRange: '70 - 110' }],
  });
  const withReview = anonymizeDossier(dossier({ documents: [doc(true)] }));
  assert.deepEqual(withReview.medications, ['amlodipină']);
  assert.deepEqual(withReview.conditions, ['hipertensiune arterială']);
  assert.deepEqual(withReview.labFindings, [{ test: 'glicemie', level: 'high' }]);
  // Diagnoses and lab results are not covered by the patient's review yet: they stay local unless confirmed.
  const medsOnly = anonymizeDossier(dossier({ documents: [doc(true, false)] }));
  assert.deepEqual([medsOnly.medications, medsOnly.conditions, medsOnly.labFindings], [['amlodipină'], [], []]);
  assert.equal(medsOnly.omittedItemCount, 2);
  const without = anonymizeDossier(dossier({ documents: [doc(false)] }));
  assert.deepEqual([without.medications, without.conditions, without.labFindings], [[], [], []]);
  assert.equal(without.omittedItemCount, 3);
});

test('names, addresses, CNP and phones typed as free text can never reach the summary', () => {
  const summary = anonymizeDossier(dossier({
    contextItems: [
      { kind: 'condition', text: 'Ionescu Maria are diabet, locuiește pe Str. Florilor 12, Sibiu, CNP 2850101223344, tel 0722 123 456', confirmed: true },
      { kind: 'allergy', text: 'alergic la penicilină (Dr. Popescu Andrei, Spitalul Județean)', confirmed: true },
      { kind: 'medication', text: 'ia metformin de la farmacia Dona', confirmed: true },
    ],
  }));
  assert.deepEqual(summary.conditions, ['diabet zaharat']);
  assert.deepEqual(summary.allergies, ['penicilină']);
  assert.deepEqual(summary.medications, ['metformin']);
  const sent = JSON.stringify(summary);
  for (const secret of ['Ionescu', 'Maria', 'Florilor', 'Sibiu', '2850101223344', '0722', 'Popescu', 'Andrei', 'Spitalul', 'Dona', 'farmacia']) {
    assert.ok(!sent.includes(secret), `${secret} must not be in the summary`);
  }
});

test('anything outside the vocabulary is omitted, never sent as text', () => {
  const summary = anonymizeDossier(dossier({
    documents: [{ reviewed: true, diagnosesAndLabsConfirmed: true, medications: [{ name: 'Ionescu Maria' }, { name: null }], diagnoses: ['sindrom rar necunoscut'], labResults: [] }],
    contextItems: [{ kind: 'condition', text: 'boală misterioasă a familiei Vasilescu', confirmed: true }],
  }));
  assert.deepEqual([summary.medications, summary.conditions], [[], []]);
  assert.equal(summary.omittedItemCount, 4);
});

test('negated statements are not turned into a condition the patient does not have', () => {
  const summary = anonymizeDossier(dossier({
    contextItems: [
      { kind: 'condition', text: 'nu am diabet', confirmed: true },
      { kind: 'allergy', text: 'fără alergie la penicilină', confirmed: true },
    ],
  }));
  assert.deepEqual([summary.conditions, summary.allergies], [[], []]);
  assert.equal(summary.omittedItemCount, 2);
});

test('unconfirmed declared items stay local', () => {
  const summary = anonymizeDossier(dossier({ contextItems: [{ kind: 'condition', text: 'astm', confirmed: false }] }));
  assert.deepEqual(summary.conditions, []);
  assert.equal(summary.omittedItemCount, 1);
});

test('brand names resolve to the active substance and duplicates collapse', () => {
  const summary = anonymizeDossier(dossier({
    contextItems: [
      { kind: 'medication', text: 'Nurofen', confirmed: true },
      { kind: 'medication', text: 'ibuprofen 400 mg', confirmed: true },
    ],
  }));
  assert.deepEqual(summary.medications, ['ibuprofen']);
});

test('lab values become a level only; unclear ranges or unknown tests stay local', () => {
  assert.equal(labLevel('13,5', '12 - 16'), 'normal');
  assert.equal(labLevel('10,1', '12 - 16'), 'low');
  assert.equal(labLevel('6,3', '< 5,7'), 'high');
  assert.equal(labLevel('45', '> 40'), 'normal');
  assert.equal(labLevel('abc', '12 - 16'), null);
  assert.equal(labLevel('13', 'vezi interpretare'), null);
  const summary = anonymizeDossier(dossier({
    documents: [{
      reviewed: true, diagnosesAndLabsConfirmed: true, medications: [], diagnoses: [],
      labResults: [
        { test: 'Hemoglobină', value: '10,1 g/dL', referenceRange: '12 - 16' },
        { test: 'Parametru ciudat', value: '5', referenceRange: '1 - 9' },
        { test: 'TSH', value: '2', referenceRange: 'necunoscut' },
      ],
    }],
  }));
  assert.deepEqual(summary.labFindings, [{ test: 'hemoglobină', level: 'low' }]);
  assert.equal(summary.omittedItemCount, 2);
  assert.doesNotMatch(JSON.stringify(summary), /10,1|12|16/);
});

test('the gate refuses extra fields, free text and terms outside the vocabulary (fail-closed)', () => {
  const ok = anonymizeDossier(dossier());
  assert.doesNotThrow(() => assertAnonymousSummary(ok));
  assert.throws(() => assertAnonymousSummary({ ...ok, patientName: 'Ionescu Maria' }), /unexpected/);
  assert.throws(() => assertAnonymousSummary({ ...ok, rawTranscript: 'text liber' }), /unexpected/);
  assert.throws(() => assertAnonymousSummary({ ...ok, conditions: ['Ionescu Maria'] }), /vocabulary/);
  assert.throws(() => assertAnonymousSummary({ ...ok, medications: ['amlodipină 5 mg'] }), /vocabulary/);
  assert.throws(() => assertAnonymousSummary({ ...ok, labFindings: [{ test: 'glicemie', level: 'high', value: '130' }] }), /labFindings/);
  assert.throws(() => assertAnonymousSummary({ ...ok, ageBand: '43' }), /ageBand/);
  assert.throws(() => assertAnonymousSummary({ ...ok, sex: 'Maria' }), /sex/);
  assert.throws(() => assertAnonymousSummary(null), /not an object/);
  const { omittedItemCount: _omit, ...missing } = ok;
  assert.throws(() => assertAnonymousSummary(missing), /missing/);
});

test('the vocabulary itself holds no accidental identifiers and is normalized consistently', () => {
  for (const term of CONDITION_TERMS) assert.ok(!/\d{6,}/.test(term), `${term} looks like an identifier`);
  assert.equal(normalize('Hipertensiune  Arterială,'), 'hipertensiune arteriala');
});

test('the same file always gives the same summary (deterministic, sorted)', () => {
  const input = dossier({ contextItems: [
    { kind: 'condition', text: 'astm', confirmed: true },
    { kind: 'condition', text: 'diabet', confirmed: true },
  ] });
  assert.deepEqual(anonymizeDossier(input), anonymizeDossier({ ...input, contextItems: [...input.contextItems].reverse() }));
});

// ---------------------------------------------------------------------------------------------------
// Regression tests for the code review: each one asserts on the final SERIALIZED JSON.
// ---------------------------------------------------------------------------------------------------

const valid = () => anonymizeDossier(dossier({ contextItems: [{ kind: 'condition', text: 'diabet', confirmed: true }] }));

test('the gate returns a new frozen object: toJSON, getters and inherited fields cannot change what is sent', () => {
  const base = valid();
  const withToJson = { ...base };
  Object.defineProperty(withToJson, 'toJSON', { value: () => ({ name: 'Pacient Sintetic' }), enumerable: false });
  assert.throws(() => assertAnonymousSummary(withToJson));

  const withGetter = { ...base };
  let calls = 0;
  Object.defineProperty(withGetter, 'conditions', { enumerable: true, get: () => (calls++ === 0 ? [] : ['Pacient Sintetic']) });
  assert.throws(() => assertAnonymousSummary(withGetter));

  const arrayWithToJson = Object.assign([...base.conditions], {});
  Object.defineProperty(arrayWithToJson, 'toJSON', { value: () => ['Pacient Sintetic'], enumerable: false });
  assert.throws(() => assertAnonymousSummary({ ...base, conditions: arrayWithToJson }));

  const inherited = Object.create({ test: 'glicemie', level: 'high' }) as Record<string, unknown>;
  inherited.patientName = 'Pacient Sintetic';
  inherited.cnp = '2850101223344';
  assert.throws(() => assertAnonymousSummary({ ...base, labFindings: [inherited] }), /labFindings/);

  const sparse = new Array<string>(2);
  assert.throws(() => assertAnonymousSummary({ ...base, conditions: sparse }));

  const result = assertAnonymousSummary(base);
  assert.notEqual(result, base);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.conditions));
  assert.equal(JSON.stringify(result), JSON.stringify(base));
});

test('the omitted counter is capped and cannot carry a number such as a CNP', () => {
  assert.throws(() => assertAnonymousSummary({ ...valid(), omittedItemCount: 2850101223344 }), /omittedItemCount/);
  assert.throws(() => assertAnonymousSummary({ ...valid(), omittedItemCount: -1 }), /omittedItemCount/);
  const many = Array.from({ length: 500 }, () => ({ kind: 'condition' as const, text: 'termen necunoscut', confirmed: true }));
  assert.equal(anonymizeDossier(dossier({ contextItems: many })).omittedItemCount, 99);
});

test('malformed input from the database is refused, not guessed', () => {
  assert.throws(() => anonymizeDossier(dossier({ documents: { length: 2850101223344 } as never })), /not a list/);
  const strings = anonymizeDossier(dossier({ contextItems: [{ kind: 'condition', text: 'astm', confirmed: 'false' as never }] }));
  assert.deepEqual(strings.conditions, []); // "false" is a string, not true
  const flag = anonymizeDossier(dossier({ documents: [{ reviewed: 'true' as never, medications: [{ name: 'metformin' }], diagnoses: [], labResults: [] }] }));
  assert.deepEqual(flag.medications, []);
});

test('negated, doubtful or someone else\'s conditions are never the patient\'s', () => {
  const sent = (text: string) => anonymizeDossier(dossier({ contextItems: [{ kind: 'condition', text, confirmed: true }] })).conditions;
  for (const text of ['pneumonie exclusă', 'pneumonie absentă', 'diabet infirmat', 'mama are diabet', 'suspiciune de diabet',
    'posibil astm', 'probabil gastrită', 'risc de infarct', 'tatăl a avut infarct', 'istoric familial de cancer', 'nu am diabet']) {
    assert.deepEqual(sent(text), [], text);
  }
  assert.deepEqual(sent('diabet zaharat tip 2'), ['diabet zaharat']);
});

test('similar-looking substances stay distinct and compound drugs are not doubled', () => {
  const meds = (text: string) => anonymizeDossier(dossier({ contextItems: [{ kind: 'medication', text, confirmed: true }] })).medications;
  assert.deepEqual(meds('Sintrom'), ['acenocumarol']);
  assert.deepEqual(meds('warfarin'), ['warfarină']);
  assert.deepEqual(meds('prednisolon'), ['prednisolon']);
  assert.deepEqual(meds('amoxicilină cu acid clavulanic'), ['amoxicilină cu acid clavulanic']);
  assert.deepEqual(meds('amoxicilină 500 mg'), ['amoxicilină']);
});

test('lab parsing accepts only unambiguous forms', () => {
  for (const [value, range] of [['1e3', '70-110'], ['1 000', '70-110'], ['.5', '0.1-0.9'], ['< 5', '4-6'], ['abc', '1-2'],
    ['5', '1-2-4'], ['5', '1-3; femei 4-6'], ['5', null], [null, '1-2']] as [string | null, string | null][]) {
    assert.equal(labLevel(value, range), null, `${value} / ${range}`);
  }
  assert.equal(labLevel('5', '< 5'), 'high'); // the limit is exclusive
  assert.equal(labLevel('5', '<= 5'), 'normal');
  assert.equal(labLevel('5', '> 5'), 'low');
  assert.equal(labLevel('5', '≥ 5'), 'normal');
  assert.equal(labLevel('13,5 g/dL', '12 - 16 g/dL'), 'normal');
});

test('two disagreeing confirmed results of one test are not sent, in either order', () => {
  const lab = (value: string) => ({ reviewed: true, diagnosesAndLabsConfirmed: true, medications: [], diagnoses: [],
    labResults: [{ test: 'Glicemie', value, referenceRange: '70 - 110' }] });
  const a = anonymizeDossier(dossier({ documents: [lab('180'), lab('90')] }));
  const b = anonymizeDossier(dossier({ documents: [lab('90'), lab('180')] }));
  assert.deepEqual(a, b);
  assert.deepEqual(a.labFindings, []);
  assert.equal(a.omittedItemCount, 1);
  assert.deepEqual(anonymizeDossier(dossier({ documents: [lab('90'), lab('95')] })).labFindings, [{ test: 'glicemie', level: 'normal' }]);
});

test('items cut by the size limit are counted, not silently dropped', () => {
  const all = [...CONDITION_TERMS];
  assert.ok(all.length > 30);
  const summary = anonymizeDossier(dossier({ contextItems: all.map((text) => ({ kind: 'condition' as const, text, confirmed: true })) }));
  assert.equal(summary.conditions.length, 30);
  assert.ok(summary.omittedItemCount >= all.length - 30 || summary.omittedItemCount === 99);
});

test('impossible calendar dates give no age band', () => {
  assert.equal(ageBandFor('2000-99-99', now), null);
  assert.equal(ageBandFor('2000-02-30', now), null);
  assert.equal(ageBandFor('2000-02-29', now), '20-29');
});

// ---------------------------------------------------------------------------------------------------
// A file with many documents: the same test repeated over time, the most recent dated result decides.
// ---------------------------------------------------------------------------------------------------

import { toIsoDate } from './summary';

const dated = (documentDate: string | null, value: string) => ({
  reviewed: true, diagnosesAndLabsConfirmed: true, documentDate, medications: [], diagnoses: [],
  labResults: [{ test: 'Glicemie', value, referenceRange: '70 - 110' }],
});

test('the most recent dated lab result decides, whatever the order of the documents', () => {
  const docs = [dated('2023-02-01', '180'), dated('2026-05-10', '90'), dated('2025-01-01', '150')];
  for (const order of [docs, [...docs].reverse(), [docs[1]!, docs[0]!, docs[2]!]]) {
    assert.deepEqual(anonymizeDossier(dossier({ documents: order })).labFindings, [{ test: 'glicemie', level: 'normal' }]);
  }
  assert.equal(anonymizeDossier(dossier({ documents: docs })).omittedItemCount, 0);
});

test('two different results on the same most recent day, or only undated disagreeing results, are not sent', () => {
  const sameDay = anonymizeDossier(dossier({ documents: [dated('2026-05-10', '90'), dated('2026-05-10', '180'), dated('2020-01-01', '95')] }));
  assert.deepEqual(sameDay.labFindings, []);
  const undated = anonymizeDossier(dossier({ documents: [dated(null, '90'), dated(null, '180')] }));
  assert.deepEqual(undated.labFindings, []);
});

test('an undated result never overrides a dated one, and the document date is never in the output', () => {
  const summary = anonymizeDossier(dossier({ documents: [dated(null, '180'), dated('2026-05-10', '90')] }));
  assert.deepEqual(summary.labFindings, [{ test: 'glicemie', level: 'normal' }]);
  assert.doesNotMatch(JSON.stringify(summary), /2026-05|2023/);
});

test('30 documents repeating the same medicines give each medicine once', () => {
  const doc = { reviewed: true, medications: [{ name: 'Amlodipină 5 mg' }, { name: 'Metformin' }], diagnoses: [], labResults: [] };
  const summary = anonymizeDossier(dossier({ documents: Array.from({ length: 30 }, () => doc) }));
  assert.deepEqual(summary.medications, ['amlodipină', 'metformin']);
  assert.equal(summary.omittedItemCount, 0);
});

test('toIsoDate converts the dates found in documents and refuses impossible ones', () => {
  assert.equal(toIsoDate('14.03.2025'), '2025-03-14');
  assert.equal(toIsoDate('2/11/2025'), '2025-11-02');
  assert.equal(toIsoDate(' 14-03-2025 '), '2025-03-14');
  assert.equal(toIsoDate('2025-03-14'), '2025-03-14');
  assert.equal(toIsoDate('31.02.2025'), null);
  assert.equal(toIsoDate('14.03.25'), null); // two-digit years are ambiguous: not guessed
  assert.equal(toIsoDate('martie 2025'), null);
  assert.equal(toIsoDate(null), null);
});
