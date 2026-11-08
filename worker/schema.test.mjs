// The schema gate must never hang the Worker. D1 binding calls have no timeout of their
// own, so one stalled call used to pin the cached promise for the life of the isolate and
// every later request in that isolate hung with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker, {
  ensureSchema, guardDb, guardEnv, initSchema,
  SCHEMA, MIGRATIONS, SCHEMA_VERSION,
} from './index.js';
import { db, r2 } from './harness.mjs';

const SECRET = 'S'.repeat(40);
const ORIGIN = 'https://s.example';
const env = (DB) => ({ DB, RESOURCES: r2({}), SESSION_SECRET: SECRET });
const OWNER = 'owner@example.com';
// Omit ADMIN_PASSWORD entirely to model "removed": the Worker reads a missing secret as ''.
const adminEnv = (DB, password, email = OWNER) => ({
  ...env(DB),
  ADMIN_EMAIL: email,
  ...(password === undefined ? {} : { ADMIN_PASSWORD: password }),
});

/** Records prepared SQL in order, so a test can prove which path ran and what came last. */
function tracked(DB) {
  const sql = [];
  return {
    sql,
    DB: {
      prepare(q) { sql.push(q); return DB.prepare(q); },
      batch(stmts) { return DB.batch(stmts); },
    },
  };
}

/** Counts PBKDF2 derives. Only hashPw() uses deriveBits; the fingerprint uses digest. */
function deriveSpy() {
  const original = crypto.subtle.deriveBits;
  let count = 0;
  crypto.subtle.deriveBits = async (...args) => {
    count++;
    return original.apply(crypto.subtle, args);
  };
  return { count: () => count, restore: () => { crypto.subtle.deriveBits = original; } };
}

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
  const DB = {
    prepare: () => ({ all: () => new Promise(() => {}) }),
    batch: () => new Promise(() => {}),
  };
  const started = Date.now();
  await assert.rejects(ensureSchema(env(DB), 25), (e) => e.dbTimeout === true);
  assert.ok(Date.now() - started < 2000, 'the deadline, not the client, ended the request');
});

test('a later caller gets its own deadline on a cached schema promise', async () => {
  // The first caller starts the schema work and is abandoned (as when its client
  // disconnects, taking its timer with it). The next caller must not inherit a
  // never-settling promise with no deadline.
  const DB = {
    prepare: () => ({ all: () => new Promise(() => {}) }),
    batch: () => new Promise(() => {}),
  };
  ensureSchema(env(DB), 300).catch(() => {});
  const started = Date.now();
  await assert.rejects(ensureSchema(env(DB), 25), (e) => e.dbTimeout === true);
  assert.ok(Date.now() - started < 2000, 'the next request had a fresh deadline');
});

test('a database timeout becomes 503 with Retry-After', async () => {
  const DB = {
    // No version row, then the full path fails at the deadline.
    prepare: () => ({ all: async () => ({ results: [] }) }),
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

// ---- the schema version gate -------------------------------------------------------------

test('a matching version costs at most two reads and runs no DDL', async () => {
  const { DB } = db();
  await initSchema(adminEnv(DB, 'pw'));
  assert.equal((await DB.prepare("SELECT v FROM schema_meta WHERE k = 'schema'").first()).v, SCHEMA_VERSION);

  DB.stats.reset();
  const second = tracked(DB);
  await initSchema(adminEnv(second.DB, 'pw'));

  assert.ok(DB.stats.roundTrips <= 2, `a matching cold start made ${DB.stats.roundTrips} D1 calls`);
  for (const q of second.sql) {
    assert.ok(!/CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX/i.test(q), `no DDL: ${q}`);
    assert.ok(!/pragma_table_info|sqlite_master/i.test(q), `no migration probe: ${q}`);
  }
});

test('a missing version runs the full path and writes the version last', async () => {
  const { DB } = db();
  const t = tracked(DB);
  await initSchema(adminEnv(t.DB, 'pw'));

  assert.equal((await DB.prepare("SELECT v FROM schema_meta WHERE k = 'schema'").first()).v, SCHEMA_VERSION);
  assert.match(t.sql.at(-1), /INSERT INTO schema_meta/, 'the version is the final statement');
  const tables = await DB.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'resources', 'youtube_lessons', 'enrollments')",
  ).first();
  assert.equal(tables.c, 4, 'the full schema was created');
});

test('a different version runs the full path again', async () => {
  const { DB } = db();
  await initSchema(adminEnv(DB, 'pw'));
  await DB.prepare("UPDATE schema_meta SET v = '0' WHERE k = 'schema'").run();

  DB.stats.reset();
  const t = tracked(DB);
  await initSchema(adminEnv(t.DB, 'pw'));

  assert.ok(DB.stats.roundTrips > 2, 'the full path ran, not the two-read fast path');
  assert.match(t.sql.at(-1), /INSERT INTO schema_meta/);
  assert.equal((await DB.prepare("SELECT v FROM schema_meta WHERE k = 'schema'").first()).v, SCHEMA_VERSION);
});

test('a missing schema_meta table falls back to the full path', async () => {
  const { DB } = db();
  let metaThrew = false;
  const wrapped = {
    prepare(q) {
      if (!metaThrew && q.startsWith('SELECT k, v FROM schema_meta')) {
        metaThrew = true;
        return { all: async () => { throw new Error('no such table: schema_meta'); } };
      }
      return DB.prepare(q);
    },
    batch: (stmts) => DB.batch(stmts),
  };
  await initSchema(adminEnv(wrapped, 'pw'));

  assert.ok(metaThrew, 'the first read was the one that failed');
  assert.equal((await DB.prepare("SELECT v FROM schema_meta WHERE k = 'schema'").first()).v, SCHEMA_VERSION);
  assert.ok(await DB.prepare("SELECT id FROM users WHERE email = ?").bind(OWNER).first(), 'the owner row was seeded');
});

test('a failed statement leaves the version unwritten', async () => {
  const seen = [];
  const DB = {
    prepare(q) {
      seen.push(q);
      return {
        all: async () => ({ results: [] }),
        first: async () => ({ c: 1 }),
        bind() { return this; },
        run: async () => {
          if (q.includes('ADD COLUMN ver')) throw new Error('migration failed');
          return {};
        },
      };
    },
    batch: async () => [{ results: [] }, { results: [] }],
  };

  await assert.rejects(initSchema(env(DB)), /migration failed/);
  assert.ok(!seen.some((q) => q.startsWith('INSERT INTO schema_meta')), 'no version write after a failure');
});

test('a failed SCHEMA batch leaves the version unwritten', async () => {
  const seen = [];
  const DB = {
    prepare(q) {
      seen.push(q);
      return { all: async () => ({ results: [] }), first: async () => null, bind() { return this; }, run: async () => ({}) };
    },
    batch: async () => { throw new Error('schema failed'); },
  };

  await assert.rejects(initSchema(env(DB)), /schema failed/);
  assert.ok(!seen.some((q) => q.startsWith('INSERT INTO schema_meta')));
});

// ---- seedAdmin: derive only when the owner row or the secret changed ---------------------

test('a matching ADMIN_PASSWORD fingerprint does not derive, and the owner stays an admin', async () => {
  const { DB } = db();
  await initSchema(adminEnv(DB, 'pw'));
  await DB.prepare('UPDATE users SET is_admin = 0 WHERE email = ?').bind(OWNER).run();

  const spy = deriveSpy();
  try {
    await initSchema(adminEnv(DB, 'pw'));
    assert.equal(spy.count(), 0, 'PBKDF2 was skipped');
  } finally {
    spy.restore();
  }
  assert.equal((await DB.prepare('SELECT is_admin FROM users WHERE email = ?').bind(OWNER).first()).is_admin, 1);
});

test('a missing owner row is hashed once', async () => {
  const { DB } = db();
  await initSchema(env(DB)); // schema and version only, no owner

  const spy = deriveSpy();
  try {
    await initSchema(adminEnv(DB, 'pw'));
    assert.equal(spy.count(), 1, 'the new owner password is hashed');
  } finally {
    spy.restore();
  }
  const row = await DB.prepare('SELECT pass, is_admin FROM users WHERE email = ?').bind(OWNER).first();
  assert.equal(row.is_admin, 1);
  assert.ok(row.pass.includes('.'), 'a real PBKDF2 hash was stored');
});

test('a changed ADMIN_PASSWORD is hashed and replaced', async () => {
  const { DB } = db();
  await initSchema(adminEnv(DB, 'old'));
  const before = (await DB.prepare('SELECT pass FROM users WHERE email = ?').bind(OWNER).first()).pass;

  const spy = deriveSpy();
  try {
    await initSchema(adminEnv(DB, 'new'));
    assert.equal(spy.count(), 1, 'only the changed secret is hashed');
  } finally {
    spy.restore();
  }
  const after = (await DB.prepare('SELECT pass FROM users WHERE email = ?').bind(OWNER).first()).pass;
  assert.notEqual(after, before);
  assert.equal((await DB.prepare("SELECT v FROM schema_meta WHERE k = 'admin_pw'").first()).v.length > 0, true);
});

test('removing ADMIN_PASSWORD writes the unusable marker without a derive', async () => {
  const { DB } = db();
  await initSchema(adminEnv(DB, 'pw'));

  const spy = deriveSpy();
  try {
    await initSchema(adminEnv(DB, undefined));
    assert.equal(spy.count(), 0, 'the unusable marker needs no PBKDF2');
  } finally {
    spy.restore();
  }
  assert.equal((await DB.prepare('SELECT pass FROM users WHERE email = ?').bind(OWNER).first()).pass, '!');
  assert.equal((await DB.prepare("SELECT v FROM schema_meta WHERE k = 'admin_pw'").first()).v, '');
});

// ---- the schema hash guard ---------------------------------------------------------------

test('the schema hash matches the version constant', () => {
  // Changing DDL without bumping SCHEMA_VERSION would silently leave old databases
  // un-migrated, so pin a hash of everything initSchema can execute.
  const hash = createHash('sha256').update(JSON.stringify([...SCHEMA, ...MIGRATIONS])).digest('hex');
  assert.equal(
    hash,
    'd18bb927e74dfad8e1c31e0f3c333cf8050dbc87b2332a683d63aed7f1cfa1bc',
    'The schema or migration DDL changed. Bump SCHEMA_VERSION in worker/index.js, then update this hash.',
  );
});
