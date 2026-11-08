// Route-level tests for RESOURCE folders shared down the tree. Every lesson inherits the
// resource files sitting in any ancestor RESOURCE folder, nearest scope first, appended to
// its own rows as synthetic read-only rows. Same fake D1/R2 harness as resources.test.mjs.
// This file grows through Tasks 6-7, so the admin cookie is created up front for them.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { db, r2, hashPw, rate } from './harness.mjs';

const SECRET = 'S'.repeat(40);
const OWNER = 'owner@example.com';
const OWNER_PW = 'owner-pass-123';
const ORIGIN = 'https://s.example';
const STUDENT_PW = 'student-pass-1';

// One course with a RESOURCE folder at every level, a deep lesson, a sibling module, an
// ordinary (non-shared) lesson file and a `not-resources` folder that must not be mistaken
// for a RESOURCE folder.
const FILES = {
  'Course/RESOURCE/syllabus.pdf': '%PDF-1.4\nsyllabus',
  'Course/Module 01/RESOURCE/cheatsheet.md': '# Cheat',
  'Course/Module 01/Sub/RESOURCE/notes.txt': 'deep notes',
  'Course/Module 01/Sub/01 - Intro.mp4': new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  'Course/Module 02/02 - Setup.mp4': new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  'Course/Module 01/guide.md': '# Guide\n\nRead me.',   // ordinary (non-shared) lesson file
  'Course/not-resources/local.txt': 'local',            // must NOT be treated as shared (F2)
  'Course/not-resources/guide.pdf': '%PDF-1.4\nnope',
};

const { raw, DB } = db();
const RATE = rate();
const env = { DB, RESOURCES: r2(FILES), SESSION_SECRET: SECRET, ADMIN_EMAIL: OWNER, ADMIN_PASSWORD: OWNER_PW, RATE: RATE.RATE };

const call = (path, { method = 'GET', headers = {}, body, e = env } = {}) =>
  worker.fetch(new Request(ORIGIN + path, { method, headers, body }), e);

let n = 0;
async function addUser({ admin = false, pw = STUDENT_PW } = {}) {
  const email = `user${++n}@example.com`;
  raw.prepare('INSERT INTO users (email, pass, is_admin, ver, sid) VALUES (?, ?, ?, 0, NULL)')
    .run(email, await hashPw(pw), admin ? 1 : 0);
  return email;
}
const enroll = (email, course) =>
  raw.prepare('INSERT OR IGNORE INTO enrollments (user_id, course) SELECT id, ? FROM users WHERE email = ?').run(course, email);

async function login(email, { pw = STUDENT_PW, ip = '10.0.0.1' } = {}) {
  const res = await call('/api/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'cf-connecting-ip': ip, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  });
  return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

// The Worker memoises schema setup per process, so boot the schema once, then create the
// enrolled student and an admin whose sessions the tests (and Task 6) reuse.
let cookie = '';
let adminCookie = '';
before(async () => {
  await call('/api/me').then((res) => assert.equal(res.status, 401)); // boot the schema
  const email = await addUser();
  await enroll(email, 'Course');
  ({ cookie } = await login(email));
  const admin = await addUser({ admin: true });
  ({ cookie: adminCookie } = await login(admin));
});

test('a lesson inherits every ancestor RESOURCE folder, nearest scope first', async () => {
  const res = await call('/api/lesson/Course%2FModule%2001%2FSub%2F01%20-%20Intro.mp4/resources', { headers: { cookie } });
  const shared = (await res.json()).resources.filter((r) => r.shared);
  assert.deepEqual(shared.map((r) => [r.title, r.kind, r.scope]), [
    ['notes', 'txt', 'Sub'],
    ['cheatsheet', 'md', 'Module 01'],
    ['syllabus', 'pdf', 'Course'],
  ]);
});

test('a sibling module inherits only the course-level RESOURCE folder', async () => {
  const res = await call('/api/lesson/Course%2FModule%2002%2F02%20-%20Setup.mp4/resources', { headers: { cookie } });
  const shared = (await res.json()).resources.filter((r) => r.shared);
  assert.deepEqual(shared.map((r) => r.title), ['syllabus']);
});

test('a folder named not-resources is not a RESOURCE folder (F2)', async () => {
  const res = await call('/api/lesson/Course%2Fnot-resources%2Fguide.pdf/resources', { headers: { cookie } });
  const shared = (await res.json()).resources.filter((r) => r.shared);
  // The lesson sits under Course, so it correctly inherits the course-level RESOURCE file.
  // The point: `not-resources` itself is NOT a RESOURCE folder, so nothing from it (local.txt,
  // guide.pdf) is shared and no row carries scope `not-resources`.
  assert.deepEqual(shared.map((r) => [r.title, r.kind, r.scope]), [['syllabus', 'pdf', 'Course']]);
});

test('a D1 timeout on the resources read fails cleanly, it does not hang', async () => {
  const { guardDb } = await import('./index.js');
  const hang = () => new Promise(() => {});
  const broken = {
    prepare: (sql) => {
      if (!/FROM resources/.test(sql)) return DB.prepare(sql);
      const stmt = { first: hang, all: hang, run: hang, bind: () => stmt };
      return stmt;
    },
    batch: (stmts) => DB.batch(stmts), // schema bootstrap must still succeed
  };
  const res = await call('/api/lesson/Course%2FModule%2001%2FSub%2F01%20-%20Intro.mp4/resources', {
    headers: { cookie },
    e: { ...env, DB: guardDb(broken, 25) },
  });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'Database temporarily unavailable' });
});
