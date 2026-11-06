// Tests for PrivacyGateway. All data below is SYNTHETIC (invented CNPs, phones, IBANs).
// Run: npx tsx --test cloud/orchestration/privacy-gateway.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivacyGateway } from './privacy-gateway';

const gateway = new PrivacyGateway();
const SESSION = 'test-session';

// Small helper so each test reads as "this input -> this output".
async function scrub(text: string): Promise<string> {
  return gateway.scrub(text, SESSION);
}

// ---------- New Romanian patterns ----------

test('CNP: 13 digits starting with 1-9 becomes [CNP]', async () => {
  assert.equal(await scrub('CNP: 1960312123456'), 'CNP: [CNP]');
  assert.equal(await scrub('CNP 2850101223344, pacienta'), 'CNP [CNP], pacienta');
  // Glued to letters (no space) is still caught.
  assert.equal(await scrub('CNP1960312123456'), 'CNP[CNP]');
});

test('CNP: is replaced whole, not half-matched as a phone', async () => {
  const result = await scrub('Pacient 5010203040506 internat');
  assert.equal(result, 'Pacient [CNP] internat');
  assert.ok(!result.includes('[PHONE]'));
});

test('CNP: numbers that are not 13 digits or start with 0 are not CNPs', async () => {
  // Starts with 0 / has 12 or 14 digits: not a CNP. (These long numbers are still
  // caught by the US phone pattern, which is fine: a long number is safer removed.)
  assert.ok(!(await scrub('cod 0960312123456')).includes('[CNP]'));
  assert.ok(!(await scrub('nr 196031212345')).includes('[CNP]'));
  assert.ok(!(await scrub('nr 19603121234567')).includes('[CNP]'));
});

test('Romanian mobile phones in all common formats become [PHONE]', async () => {
  const phones = [
    '0722 123 456',
    '0722123456',
    '0722-123-456',
    '0722.123.456',
    '+40 722 123 456',
    '+40722123456',
    '0040722123456',
    '0040 722 123 456',
  ];
  for (const phone of phones) {
    assert.equal(await scrub(`Telefon: ${phone}.`), 'Telefon: [PHONE].', `failed for "${phone}"`);
  }
});

test('Romanian landlines (02x / 03x, 10 digits) become [PHONE]', async () => {
  assert.equal(await scrub('Fix: 021 123 4567'), 'Fix: [PHONE]');
  assert.equal(await scrub('Fix: 0264 123 456'), 'Fix: [PHONE]');
  assert.equal(await scrub('Fix: 0312345678'), 'Fix: [PHONE]');
});

test('Dates with dots become [DATE]', async () => {
  assert.equal(await scrub('Internat pe 14.03.2025.'), 'Internat pe [DATE].');
  assert.equal(await scrub('Data: 1.3.25'), 'Data: [DATE]');
  assert.equal(await scrub('Nascut 03.02.1985 ora 10'), 'Nascut [DATE] ora 10');
});

test('Romanian IBAN (compact and grouped) becomes [IBAN]', async () => {
  assert.equal(await scrub('IBAN RO49AAAA1B31007593840000'), 'IBAN [IBAN]');
  assert.equal(await scrub('IBAN: RO49 AAAA 1B31 0075 9384 0000, banca'), 'IBAN: [IBAN], banca');
  assert.equal(await scrub('cont ro49aaaa1b31007593840000'), 'cont [IBAN]');
});

// ---------- Existing patterns still work ----------

test('Existing: email becomes [EMAIL]', async () => {
  assert.equal(await scrub('Scrie la ion.popescu@example.com'), 'Scrie la [EMAIL]');
  // Digits inside an email do not become a phone/CNP.
  assert.equal(await scrub('pacient0722123456@example.ro'), '[EMAIL]');
});

test('Existing: US phone becomes [PHONE]', async () => {
  assert.equal(await scrub('Call (555) 123-4567'), 'Call [PHONE]');
  assert.equal(await scrub('Call 555-123-4567'), 'Call [PHONE]');
});

test('Existing: SSN becomes [SSN]', async () => {
  assert.equal(await scrub('SSN 123-45-6789'), 'SSN [SSN]');
});

test('Existing: dates with / and - become [DATE]', async () => {
  assert.equal(await scrub('Visit on 03/14/2025'), 'Visit on [DATE]');
  assert.equal(await scrub('Vizita 14-03-2025'), 'Vizita [DATE]');
});

// ---------- Medical values must NOT be scrubbed ----------

test('Medical values stay intact', async () => {
  const medicalTexts = [
    'Hemoglobina 13,5 g/dL',
    'Hemoglobina 13.5 g/dL',
    'Glicemie 92 mg/dL',
    'TA 120/80 mmHg',
    'Paracetamol 500 mg de 3 ori pe zi',
    'Interval de referinta 12 - 16',
    'Interval de referinta 12-16',
    'Diagnosticat in 2025',
    'Trombocite 250.000/mm3',
    'Trombocite 1.250.000/mm3',
    'pH 7.40, temperatura 38,5 C, puls 92/min',
    'Durere 7/10 de 2 zile',
    'Timestamp 2026-11-07T10:00:00Z',
  ];
  for (const text of medicalTexts) {
    assert.equal(await scrub(text), text, `medical value was changed: "${text}"`);
  }
});

test('Mixed text: only personal data is replaced, medical values stay', async () => {
  const input =
    'Pacient CNP 1960312123456, tel 0722 123 456, email ana@example.com, ' +
    'internat 14.03.2025. Hb 13,5 g/dL, glicemie 92 mg/dL, TA 120/80, paracetamol 500 mg.';
  const expected =
    'Pacient CNP [CNP], tel [PHONE], email [EMAIL], ' +
    'internat [DATE]. Hb 13,5 g/dL, glicemie 92 mg/dL, TA 120/80, paracetamol 500 mg.';
  assert.equal(await scrub(input), expected);
});

// ---------- scrubObject ----------

test('scrubObject scrubs strings at every level and keeps other values', async () => {
  const caseSummary = {
    chiefComplaint: 'Durere de cap, sunati la 0722123456',
    severity: 7,
    redFlagsDetected: false,
    associatedSymptoms: ['greata din 14.03.2025', 'febra 38,5 C'],
    rawTranscript: 'Ma numesc pacient test, CNP 2850101223344, IBAN RO49AAAA1B31007593840000.',
    metadata: {
      timestamp: '2026-11-07T10:00:00Z',
      language: 'ro',
      contact: { email: 'test@example.com', phone: '+40 722 123 456' },
    },
  };

  const result = await gateway.scrubObject(caseSummary, SESSION);

  assert.deepEqual(result, {
    chiefComplaint: 'Durere de cap, sunati la [PHONE]',
    severity: 7,
    redFlagsDetected: false,
    associatedSymptoms: ['greata din [DATE]', 'febra 38,5 C'],
    rawTranscript: 'Ma numesc pacient test, CNP [CNP], IBAN [IBAN].',
    metadata: {
      timestamp: '2026-11-07T10:00:00Z',
      language: 'ro',
      contact: { email: '[EMAIL]', phone: '[PHONE]' },
    },
  });

  // The original object is not modified (scrubObject returns a copy).
  assert.equal(caseSummary.chiefComplaint, 'Durere de cap, sunati la 0722123456');
});

// ---------- Fail-closed ----------

test('scrub throws on a non-string, so the orchestrator stops before the LLM', async () => {
  await assert.rejects(() => gateway.scrub(undefined as unknown as string, SESSION), TypeError);
});
