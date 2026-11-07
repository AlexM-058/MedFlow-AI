// Tests for the control questions checks. All data is SYNTHETIC.
// Run: npx tsx --test cloud/orchestration/control-questions.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anonymizeDossier } from '../../edge/anonymization/summary';
import { buildControlQuestionsPrompt, deterministicSummary, isUnsafeText, parseControlQuestions, payloadHash } from './control-questions';

const summary = anonymizeDossier({
  birthDate: '1980-03-14', sex: 'F', now: new Date('2026-11-07T10:00:00Z'), documents: [],
  contextItems: [
    { kind: 'condition', text: 'diabet, Ionescu Maria, Str. Florilor 12', confirmed: true },
    { kind: 'medication', text: 'metformin', confirmed: true },
  ],
});
const answer = (questions: unknown[], text = 'Pacient cu diabet zaharat, tratat cu metformin.') => JSON.stringify({ summary: text, questions });
const q = (id: string, text: string, answerType = 'yes_no') => ({ id, text, answerType });

test('the prompt contains only the anonymized summary, never an identifier', () => {
  const prompt = buildControlQuestionsPrompt(summary);
  assert.ok(prompt.includes('diabet zaharat') && prompt.includes('metformin') && prompt.includes('40-49'));
  for (const secret of ['Ionescu', 'Maria', 'Florilor', '1980', '03-14']) assert.ok(!prompt.includes(secret), secret);
});

test('valid questions pass, are trimmed and keep their answer type', () => {
  const result = parseControlQuestions(answer([q('q1', ' Cum vă simțiți acum? ', 'short_text'), q('q2', 'Luați metforminul zilnic?')]), summary);
  assert.deepEqual(result.questions, [
    { id: 'q1', text: 'Cum vă simțiți acum?', answerType: 'short_text' },
    { id: 'q2', text: 'Luați metforminul zilnic?', answerType: 'yes_no' },
  ]);
  assert.equal(result.rejectedQuestionCount, 0);
});

test('a JSON object wrapped in a markdown block is accepted', () => {
  const raw = '```json\n' + answer([q('q1', 'Ați avut glicemii mari recent?')]) + '\n```';
  assert.equal(parseControlQuestions(raw, summary).questions.length, 1);
});

test('questions that give advice, doses or a diagnosis are dropped by fixed rules', () => {
  const unsafe = [
    'Ar trebui să luați 1000 mg de metformin?', 'Opriți metforminul dacă aveți greață?', 'Creșteți doza de insulină?',
    'Sunteți diagnosticat cu diabet de tip 2?', 'Vi s-a prescris un alt tratament?', 'Folosiți 2 comprimate seara?',
  ];
  const result = parseControlQuestions(answer([...unsafe.map((text, i) => q(`u${i}`, text)), q('ok', 'Ați observat sete mai mare?')]), summary);
  assert.deepEqual(result.questions.map((entry) => entry.id), ['ok']);
  assert.equal(result.rejectedQuestionCount, unsafe.length);
  assert.ok(unsafe.every((text) => isUnsafeText(text)));
  assert.ok(!isUnsafeText('Ce simptome ați observat în ultima săptămână?'));
  assert.ok(!isUnsafeText('Ce medicamente luați în prezent?'));
});

test('malformed questions are dropped: no question mark, too short or long, bad id, duplicate id, bad type, extra than 8', () => {
  const many = Array.from({ length: 12 }, (_, i) => q(`q${i + 1}`, `Întrebarea numărul ${i + 1} despre simptome?`));
  const result = parseControlQuestions(answer([
    q('a1', 'Fără semn de întrebare'), q('a2', 'Scurt?'), q('a3', `${'x'.repeat(220)}?`), q('Bad Id', 'Cum vă simțiți azi?'),
    q('q1', 'Prima întrebare validă?'), q('q1', 'Aceeași identitate, repetată?'), q('a4', 'Cum vă simțiți azi?', 'essay'),
    ...many.slice(1),
  ]), summary);
  assert.equal(result.questions.length, 8);
  assert.equal(new Set(result.questions.map((entry) => entry.id)).size, 8);
  assert.ok(result.rejectedQuestionCount >= 7);
});

test('nothing usable, or not JSON, throws instead of showing unchecked text', () => {
  assert.throws(() => parseControlQuestions(answer([q('q1', 'Luați 500 mg acum?')]), summary), /No usable/);
  assert.throws(() => parseControlQuestions('Nu pot ajuta cu asta.', summary), /No JSON/);
  assert.throws(() => parseControlQuestions('{"summary":"x"}', summary), /Malformed/);
});

test('an unsafe or missing model summary is replaced by the deterministic one', () => {
  const fallback = deterministicSummary(summary);
  assert.ok(fallback.includes('diabet zaharat') && fallback.includes('metformin'));
  assert.equal(parseControlQuestions(answer([q('q1', 'Cum vă simțiți azi?')], 'Pacientul are diabet și trebuie să ia 500 mg.'), summary).summary, fallback);
  assert.equal(parseControlQuestions(JSON.stringify({ questions: [q('q1', 'Cum vă simțiți azi?')] }), summary).summary, fallback);
  assert.equal(deterministicSummary(anonymizeDossier({ documents: [], contextItems: [], now: new Date() })), 'Nu există fapte confirmate în dosar.');
});

test('the disclosure hash depends only on what is sent', () => {
  assert.equal(payloadHash(summary), payloadHash(JSON.parse(JSON.stringify(summary))));
  assert.match(payloadHash(summary), /^[0-9a-f]{64}$/);
});
