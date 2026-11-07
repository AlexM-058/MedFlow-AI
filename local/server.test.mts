import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAgentServer, QUESTIONS } from './server.mts';

const token = 'synthetic-test-token-12345678901234567890';
async function fixture(output: unknown, run: (url: string, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const fetcher = (async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(String(input).endsWith('/api/tags')
      ? { models: [{ name: 'gemma3:1b' }] } : { response: JSON.stringify(output), done: true }));
  }) as typeof fetch;
  const server = createAgentServer({ token, fetcher }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('only liveness is public; unauthorized requests never call Ollama', async () => fixture({}, async (url, calls) => {
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/ready`)).status, 401);
  assert.equal((await fetch(`${url}/intake`, { method: 'POST' })).status, 401);
  assert.deepEqual(calls, []);
}));
test('readiness checks the configured installed model', async () => fixture({}, async (url) => {
  assert.equal((await fetch(`${url}/ready`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
}));
test('intake returns an allowed static question, not free-form medical advice', async () => fixture({ questionId: 'onset', advice: 'invented' }, async (url) => {
  const response = await post(`${url}/intake`, { messages: [{ id: '1', text: 'Mesaj sintetic' }] });
  assert.deepEqual(await response.json(), { questionId: 'onset', text: QUESTIONS.onset });
}));
test('an already asked or invented question is rejected', async () => fixture({ questionId: 'prescribe' }, async (url) => {
  assert.equal((await post(`${url}/intake`, { messages: [{ id: '1', text: 'test' }] })).status, 502);
}));
test('summary preserves exact negation and includes originals and uncovered messages', async () => fixture({ items: [{ messageId: '1', quote: 'Nu am febra.' }] }, async (url) => {
  const messages = [{ id: '1', text: 'Nu am febra.' }, { id: '2', text: 'Poate de ieri.' }];
  const response = await post(`${url}/summary`, { messages });
  const result = await response.json();
  assert.deepEqual(result.originals, messages); assert.deepEqual(result.uncoveredMessageIds, ['2']);
  assert.equal(result.items[0].text, messages[0]!.text);
}));
test('invented summary text cannot leave the gateway', async () => fixture({ items: [{ messageId: '1', quote: 'Are febra.' }] }, async (url) => {
  assert.equal((await post(`${url}/summary`, { messages: [{ id: '1', text: 'Nu am febra.' }] })).status, 502);
}));
test('invalid input and arbitrary proxy paths are refused', async () => fixture({}, async (url, calls) => {
  assert.equal((await post(`${url}/summary`, { messages: [], url: 'http://example.test' })).status, 400);
  assert.equal((await post(`${url}/api/generate`, {})).status, 404);
  assert.deepEqual(calls, []);
}));

// ---------------------------------------------------------------------------------------------------
// /control-questions: the only route to the cloud AI. The cloud must receive ONLY the anonymized summary.
// ---------------------------------------------------------------------------------------------------
type Call = { url: string; body: string; auth: string | null };
async function cloudFixture(reply: { status?: number; body?: unknown }, run: (url: string, calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const fetcher = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body), auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(reply.body ?? { summary: 'Rezumat.', questions: [{ id: 'q1', text: 'Cum vă simțiți azi?', answerType: 'short_text' }], payloadHash: 'h', model: 'm' }), { status: reply.status ?? 200 });
  }) as typeof fetch;
  const server = createAgentServer({ token, fetcher }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
const dossier = {
  birthDate: '1980-03-14', sex: 'F',
  documents: [{ reviewed: true, medications: [{ name: 'Metformin' }], diagnoses: [], labResults: [] }],
  contextItems: [{ kind: 'condition', text: 'Ionescu Maria are diabet, Str. Florilor 12, Sibiu, CNP 2850101223344, tel 0722 123 456', confirmed: true }],
};
test('control questions: the cloud receives the anonymized summary and NOTHING raw', async () => cloudFixture({}, async (url, calls) => {
  const response = await post(`${url}/control-questions`, { caseId: 'case-1', dossier });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://127.0.0.1:8091/control-questions');
  assert.equal(calls[0]!.auth, null); // the gateway token is never passed on
  const sent = JSON.parse(calls[0]!.body) as { caseId: string; summary: Record<string, unknown> };
  assert.deepEqual(Object.keys(sent).sort(), ['caseId', 'summary']);
  assert.deepEqual(sent.summary.conditions, ['diabet zaharat']);
  assert.deepEqual(sent.summary.medications, ['metformin']);
  for (const secret of ['Ionescu', 'Maria', 'Florilor', 'Sibiu', '2850101223344', '0722', '1980', 'diagnoses', 'documents', 'contextItems']) {
    assert.ok(!calls[0]!.body.includes(secret), `${secret} must never reach the cloud`);
  }
  const result = await response.json();
  assert.equal(result.summary, 'Rezumat.');
  assert.equal(result.questions.length, 1);
  assert.deepEqual(result.anonymizedSummary, sent.summary); // returned so Backend can log exactly what was sent
}));
test('control questions: token required, JSON only, exact keys, and a malformed dossier never reaches the cloud', async () => cloudFixture({}, async (url, calls) => {
  assert.equal((await fetch(`${url}/control-questions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${url}/control-questions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await post(`${url}/control-questions`, { caseId: 'c', dossier, extra: 1 })).status, 400);
  assert.equal((await post(`${url}/control-questions`, { caseId: 'c', dossier: { ...dossier, rawTranscript: 'text liber' } })).status, 400);
  assert.equal((await post(`${url}/control-questions`, { caseId: 'c', dossier: { ...dossier, documents: { length: 5 } } })).status, 400);
  assert.equal((await post(`${url}/control-questions`, { caseId: '', dossier })).status, 400);
  assert.equal((await fetch(`${url}/control-questions`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  assert.deepEqual(calls, []);
}));
test('the old raw-text proxies are gone', async () => cloudFixture({}, async (url, calls) => {
  assert.equal((await post(`${url}/analysis`, { caseId: 'c' })).status, 404);
  assert.equal((await post(`${url}/case-summary`, { caseId: 'c' })).status, 404);
  assert.deepEqual(calls, []);
}));
test('cloud failures do not leak their text and the cloud must stay on loopback', async () => {
  await cloudFixture({ status: 500, body: { error: 'Gemini quota exceeded: key AIza-secret' } }, async (url) => {
    const response = await post(`${url}/control-questions`, { caseId: 'c', dossier });
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'AI_CLOUD_FAILED' });
  });
  await cloudFixture({ body: { unexpected: true } }, async (url) => assert.equal((await post(`${url}/control-questions`, { caseId: 'c', dossier })).status, 502));
  assert.throws(() => createAgentServer({ token, cloudUrl: 'https://example.test' }), /loopback/);
});
test('intake uses the control questions from the cloud: the model only picks an id', async () => fixture({ questionId: 'sete' }, async (url) => {
  const questions = [{ id: 'sete', text: 'Ați observat sete mai mare?', answerType: 'yes_no' }, { id: 'greutate', text: 'S-a schimbat greutatea recent?', answerType: 'yes_no' }];
  const response = await post(`${url}/intake`, { messages: [{ id: '1', text: 'Mesaj sintetic' }], questions });
  assert.deepEqual(await response.json(), { questionId: 'sete', text: 'Ați observat sete mai mare?' });
}));
test('intake refuses unsafe, malformed or duplicated control questions and ids outside them', async () => fixture({ questionId: 'a1' }, async (url) => {
  const messages = [{ id: '1', text: 'test' }];
  const ask = (questions: unknown, asked?: unknown) => post(`${url}/intake`, { messages, questions, ...(asked ? { asked } : {}) }).then((r) => r.status);
  assert.equal(await ask([{ id: 'a1', text: 'Luați 500 mg de metformin zilnic?' }]), 400);
  assert.equal(await ask([{ id: 'a1', text: 'Opriți tratamentul dacă aveți greață?' }]), 400);
  assert.equal(await ask([{ id: 'A 1', text: 'Cum vă simțiți azi?' }]), 400);
  assert.equal(await ask([{ id: 'a1', text: 'Cum vă simțiți azi?' }, { id: 'a1', text: 'Aceeași identitate, repetată?' }]), 400);
  assert.equal(await ask([]), 400);
  assert.equal(await ask(Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, text: `Întrebarea numărul ${i} aici?` }))), 400);
  assert.equal(await ask([{ id: 'a1', text: 'Cum vă simțiți azi?', note: 'x' }]), 400);
  assert.equal(await ask([{ id: 'a1', text: 'Cum vă simțiți azi?' }], ['onset']), 400); // an id from the fixed list is not in this bank
  assert.equal(await ask([{ id: 'a1', text: 'Cum vă simțiți azi?' }]), 200);
}));
test('with every control question already asked the conversation can be sent to the doctor', async () => fixture({}, async (url) => {
  const response = await post(`${url}/intake`, { messages: [{ id: '1', text: 'test' }], questions: [{ id: 'a1', text: 'Cum vă simțiți azi?' }], asked: ['a1'] });
  assert.deepEqual(await response.json(), { questionId: null, text: 'Informațiile pot fi trimise medicului pentru verificare.' });
}));
