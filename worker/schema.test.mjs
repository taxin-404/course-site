// The schema gate must never hang the Worker. D1 binding calls have no timeout of their
// own, so one stalled call used to pin the cached promise for the life of the isolate and
// every later request in that isolate hung with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { ensureSchema, guardDb, guardEnv } from './index.js';
import { db, r2 } from './harness.mjs';

const SECRET = 'S'.repeat(40);
const ORIGIN = 'https://s.example';
const env = (DB) => ({ DB, RESOURCES: r2({}), SESSION_SECRET: SECRET });

test('/api/config never touches the database', async () => {
  const touched = () => { throw new Error('D1 touched'); };
  const res = await worker.fetch(new Request(ORIGIN + '/api/config'), {
    ...env({ prepare: touched, batch: touched }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.nonce, 'config still returns a sign-in nonce');
});

test('a stalled schema call rejects at the deadline instead of hanging', async () => {
  const DB = { prepare: () => ({}), batch: () => new Promise(() => {}) };
  const started = Date.now();
  await assert.rejects(ensureSchema(env(DB), 25), (e) => e.dbTimeout === true);
  assert.ok(Date.now() - started < 2000, 'the deadline, not the client, ended the request');
});

test('a later caller gets its own deadline on a cached schema promise', async () => {
  // The first caller starts the schema work and is abandoned (as when its client
  // disconnects, taking its timer with it). The next caller must not inherit a
  // never-settling promise with no deadline.
  const DB = { prepare: () => ({}), batch: () => new Promise(() => {}) };
  ensureSchema(env(DB), 300).catch(() => {});
  const started = Date.now();
  await assert.rejects(ensureSchema(env(DB), 25), (e) => e.dbTimeout === true);
  assert.ok(Date.now() - started < 2000, 'the next request had a fresh deadline');
});

test('a database timeout becomes 503 with Retry-After', async () => {
  const DB = {
    prepare: () => ({}),
    batch: async () => {
      const e = new Error('stalled');
      e.dbTimeout = true;
      throw e;
    },
  };
  const res = await worker.fetch(new Request(ORIGIN + '/api/me'), env(DB));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '5');
});

test('the next request retries after a timeout instead of reusing the dead promise', async () => {
  const { DB } = db();
  await ensureSchema(env(DB), 5000);
  const row = await DB.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table'").first();
  assert.ok(row.c >= 10, 'schema was created by the retry, not skipped');
});

// Past the schema gate, every later query is a plain D1 call with no timeout of its own.
// guardDb races each one against the deadline so a stalled query cannot pin the request.
test('a stalled query rejects at the deadline instead of hanging', async () => {
  const stmt = { first: () => new Promise(() => {}), all: () => new Promise(() => {}), run: () => new Promise(() => {}) };
  stmt.bind = () => stmt;
  const started = Date.now();
  await assert.rejects(guardDb({ prepare: () => stmt }, 25).prepare('SELECT 1').first(), (e) => e.dbTimeout === true);
  assert.ok(Date.now() - started < 2000, 'the deadline, not the client, ended the query');
});

test('the deadline survives bind()', async () => {
  const bound = { first: () => new Promise(() => {}) };
  const stmt = { bind: () => bound };
  await assert.rejects(guardDb({ prepare: () => stmt }, 25).prepare('SELECT ?').bind(1).first(), (e) => e.dbTimeout === true);
});

test('batch receives the original statements, not the guards', async () => {
  const made = [];
  let received;
  const DB = {
    prepare: (q) => { const s = { q }; made.push(s); return s; },
    batch: async (stmts) => { received = stmts; return stmts; },
  };
  const g = guardDb(DB, 1000);
  await g.batch([g.prepare('a'), g.prepare('b')]);
  assert.equal(received.length, 2);
  assert.equal(received[0], made[0], 'workerd must see the real D1PreparedStatement');
  assert.equal(received[1], made[1]);
});

test('the guarded binding resolves real results (query and batch)', async () => {
  const { DB } = db();
  const g = guardDb(DB, 1000);
  const row = await g.prepare('SELECT 42 AS n').first();
  assert.equal(row.n, 42);
  const batched = await g.batch([g.prepare('SELECT 1 AS n'), g.prepare('SELECT 2 AS n')]);
  assert.equal(batched[0].results[0].n, 1);
  assert.equal(batched[1].results[0].n, 2);
});

test('guardEnv routes DB through the guard and leaves other bindings intact', async () => {
  const { DB } = db();
  const g = guardEnv({ DB, RESOURCES: r2({}), SESSION_SECRET: SECRET });
  assert.equal(g.SESSION_SECRET, SECRET, 'non-DB bindings pass through');
  assert.ok(g.RESOURCES, 'R2 binding still reachable');
  assert.equal((await g.DB.prepare('SELECT 7 AS n').first()).n, 7);
});
