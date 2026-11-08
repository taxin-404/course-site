// The Worker emits one structured line for every 5xx. It must be parseable, include the
// five agreed fields, and never carry request secrets (cookies, headers, query, bodies).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

const SECRET = 'S'.repeat(40);
const ORIGIN = 'https://s.example';

const capture = () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  return { lines, restore: () => { console.error = original; } };
};

test('a 503 logs one structured line and contains no secrets', async () => {
  const { lines, restore } = capture();
  try {
    const DB = {
      prepare: () => ({}),
      batch: async () => {
        const e = new Error('stalled');
        e.dbTimeout = true;
        throw e;
      },
    };
    const res = await worker.fetch(new Request(ORIGIN + '/api/me?token=querysecret', {
      headers: { cookie: 'session=cookiesecret', authorization: 'Bearer headersecret' },
    }), { DB, RESOURCES: {}, SESSION_SECRET: SECRET });
    assert.equal(res.status, 503);
  } finally {
    restore();
  }

  assert.equal(lines.length, 1, 'exactly one line');
  const line = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(line).sort(), ['dbTimeout', 'method', 'ms', 'path', 'status']);
  assert.equal(line.path, '/api/me');
  assert.equal(line.method, 'GET');
  assert.equal(line.status, 503);
  assert.equal(line.dbTimeout, true);
  assert.ok(Number.isFinite(line.ms) && line.ms >= 0, 'ms is measured');
  for (const secret of ['querysecret', 'cookiesecret', 'headersecret']) {
    assert.ok(!lines[0].includes(secret), `the log must not contain ${secret}`);
  }
});

test('a thrown handler logs the same line before the error surfaces', async () => {
  const { lines, restore } = capture();
  try {
    const env = { get SESSION_SECRET() { throw new Error('boom'); } };
    await assert.rejects(worker.fetch(new Request(ORIGIN + '/api/me'), env), /boom/);
  } finally {
    restore();
  }

  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.path, '/api/me');
  assert.equal(line.method, 'GET');
  assert.equal(line.status, 500);
  assert.equal(line.dbTimeout, false);
});