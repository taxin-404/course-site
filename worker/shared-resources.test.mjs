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

// Same browser-fetch markers other route tests use: the media route refuses a request that
// does not look like a same-origin browser fetch (see mediaRequestOk).
const browser = (cookie, dest = 'empty') => ({ cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': dest });

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

test('a YouTube lesson cannot be created under RESOURCE', async () => {
  const res = await call('/api/admin/youtube', {
    method: 'POST',
    headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ course: 'Course', folder: 'Module 01/RESOURCE', lesson: 'Extra', link: 'dQw4w9WgXcQ' }),
  });
  assert.equal(res.status, 400);
});

test('moving an entry into RESOURCE is refused, but editing within RESOURCE is allowed', async () => {
  const move = (from, to) => call('/api/admin/files/move', {
    method: 'POST',
    headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  // A lesson file moved into RESOURCE is refused (today by the "must stay a lesson" guard).
  assert.equal((await move('Course/Module 01/guide.md', 'Course/Module 01/RESOURCE/guide.md')).status, 400);
  // F8: a whole section moved into RESOURCE must also be refused by the new reserved-name rule.
  // A folder move skips the lesson guard, so this case genuinely exercises the new guard (and is
  // the real RED: it succeeds today).
  assert.equal((await move('Course/Module 02', 'Course/RESOURCE/Module 02')).status, 400);
  // F7: seed a file inside RESOURCE at test time (the fake R2 bucket has put()) so Task 5's
  // per-scope ordering assertions are not polluted by a second course-level file.
  await env.RESOURCES.put('Course/RESOURCE/extra.txt', 'extra');
  assert.equal((await move('Course/RESOURCE/extra.txt', 'Course/RESOURCE/extra-v2.txt')).status, 200);
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

test('notes round-trip on a real shared PDF and 404 on an invented key', async () => {
  const key = 'Course/RESOURCE/syllabus.pdf';
  const url = '/api/notes/' + encodeURIComponent(key);
  const put = await call(url, {
    method: 'PUT',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ data: [{ id: 'a', page: 1 }] }),
  });
  assert.equal(put.status, 200);
  const get = await call(url, { headers: { cookie } });
  assert.deepEqual((await get.json()).data, [{ id: 'a', page: 1 }]);

  const invented = '/api/notes/' + encodeURIComponent('Course/RESOURCE/does-not-exist.pdf');
  assert.equal((await call(invented, { headers: { cookie } })).status, 404);
});

test('an unenrolled student cannot fetch a shared PDF', async () => {
  const stranger = await addUser();
  const { cookie: strangerCookie } = await login(stranger);
  const res = await call('/api/media/Course/RESOURCE/syllabus.pdf', { headers: browser(strangerCookie) });
  assert.equal(res.status, 403);
});

test('a shared PDF keeps its notes when it is renamed inside RESOURCE', async () => {
  const from = 'Course/RESOURCE/syllabus.pdf';
  await call('/api/notes/' + encodeURIComponent(from), {
    method: 'PUT',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ data: [{ id: 'z', page: 2 }] }),
  });
  const mv = await call('/api/admin/files/move', {
    method: 'POST',
    headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: 'Course/RESOURCE/renamed.pdf', kind: 'file' }),
  });
  assert.equal(mv.status, 200);
  const after = await call('/api/notes/' + encodeURIComponent('Course/RESOURCE/renamed.pdf'), { headers: { cookie } });
  assert.deepEqual((await after.json()).data, [{ id: 'z', page: 2 }]);
});

test('a shared PDF moved out of RESOURCE takes its notes with it', async () => {
  // Seed just-in-time so test order cannot matter (a later/earlier test renames syllabus.pdf).
  await env.RESOURCES.put('Course/RESOURCE/moved.pdf', '%PDF-1.4\nmoved');
  const put = await call('/api/notes/' + encodeURIComponent('Course/RESOURCE/moved.pdf'), {
    method: 'PUT',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ data: [{ id: 'out', page: 7 }] }),
  });
  assert.equal(put.status, 200);
  const mv = await call('/api/admin/files/move', {
    method: 'POST',
    headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'Course/RESOURCE/moved.pdf', to: 'Course/Module 01/moved.pdf', kind: 'file' }),
  });
  assert.equal(mv.status, 200);
  const after = await call('/api/notes/' + encodeURIComponent('Course/Module 01/moved.pdf'), { headers: { cookie } });
  assert.deepEqual((await after.json()).data, [{ id: 'out', page: 7 }]);
});
