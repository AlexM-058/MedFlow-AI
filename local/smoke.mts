const base = process.argv[2] ?? 'http://127.0.0.1:8092';
const token = process.env.LOCAL_AGENT_TOKEN;
if (!token) throw new Error('LOCAL_AGENT_TOKEN missing');
for (const [path, body] of [
  ['/ready', undefined],
  ['/intake', { messages: [{ id: 'synthetic-1', text: 'Nu am febra. Disconfortul a inceput ieri.' }], asked: [] }],
  ['/summary', { messages: [{ id: 'synthetic-1', text: 'Nu am febra.' }] }],
] as const) {
  const started = Date.now();
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(110000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}, ${JSON.stringify(data)}`);
  process.stdout.write(`${path}: PASS ${Date.now() - started}ms ${JSON.stringify(data)}\n`);
}
