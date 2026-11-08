// /api/health is a dependency-free uptime probe: it must answer without the schema
// bootstrap, without a session, and without leaking anything but `ok`. A failing D1 call is
// a 503, never a hang, and GET/HEAD are the only methods it owns.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { guardDb } from './index.js';
import { db, r2 } from './harness.mjs';

const SECRET = 'S'.repeat(40);
const ORIGIN = 'https://s.example';
// RESOURCES is unused by /api/health itself, but the fall-through path (a non-GET method)
// still runs the schema bootstrap, which reads the bucket.
const env = (DB) => ({ DB, RESOURCES: r2({}), SESSION_SECRET: SECRET });
const HEALTH_SQL = 'SELECT 1 AS ok';

/** Records every prepared statement and batch so a test can prove what actually ran. */
function tracked(DB) {
  const sql = [];
  const batched = [];
  return {
    sql,
    batched,
    DB: {
      prepare(q) { sql.push(q); return DB.prepare(q); },
      batch(stmts) { batched.push(stmts.length); return DB.batch(stmts); },
    },
  };
}

test('GET /api/health answers 200 {ok:true} from one query and no schema work', async () => {
  const t = tracked(db().DB);
  const res = await worker.fetch(new Request(ORIGIN + '/api/health'), env(t.DB));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('retry-after'), null);
  assert.deepEqual(t.sql, [HEALTH_SQL], 'only the health query ran');
  assert.equal(t.batched.length, 0, 'the schema batch never ran');
});

test('GET /api/health answers 503 {ok:false} with Retry-After when the DB stalls', async () => {
  // guardEnv adds the default 8 s deadline; pre-guarding with a shorter one makes the inner
  // deadline reject first, so the stall is modelled without an 8 s test.
  const stalled = guardDb({ prepare: () => ({ first: () => new Promise(() => {}) }) }, 25);
  const started = Date.now();
  const res = await worker.fetch(new Request(ORIGIN + '/api/health'), env(stalled));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '5');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: false }, 'the body carries nothing but ok:false');
  assert.ok(Date.now() - started < 2000, 'the deadline, not the client, ended the wait');
});

test('HEAD /api/health returns the same status with no body', async () => {
  const t = tracked(db().DB);
  const ok = await worker.fetch(new Request(ORIGIN + '/api/health', { method: 'HEAD' }), env(t.DB));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(await ok.text(), '', 'HEAD has no body');
  assert.deepEqual(t.sql, [HEALTH_SQL]);

  const stalled = guardDb({ prepare: () => ({ first: () => new Promise(() => {}) }) }, 25);
  const down = await worker.fetch(new Request(ORIGIN + '/api/health', { method: 'HEAD' }), env(stalled));
  assert.equal(down.status, 503);
  assert.equal(down.headers.get('retry-after'), '5');
  assert.equal(await down.text(), '', 'a failing HEAD also has no body');
});

test('another method is not answered by /api/health', async () => {
  const t = tracked(db().DB);
  const res = await worker.fetch(new Request(ORIGIN + '/api/health', { method: 'POST' }), env(t.DB));
  assert.notEqual(res.status, 200, 'POST is not the health success');
  assert.ok(!t.sql.includes(HEALTH_SQL), 'the health query did not run for POST');
});
