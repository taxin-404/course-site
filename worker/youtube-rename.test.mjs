// Renaming a YouTube lesson is a data move, not just a label change: its name is the row's
// key, and comments, notes, progress and saved order are all attached to that key. These
// route-level tests prove the rename moves every one of those rows and refuses to clobber an
// existing lesson or file.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { db, r2, hashPw, rate } from './harness.mjs';

const SECRET = 'S'.repeat(40);
const OWNER = 'owner@example.com';
const OWNER_PW = 'owner-pass-123';
const ORIGIN = 'https://s.example';
const FILES = {
  'MERN Stack/existing.mp4': new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
};

const { raw, DB } = db();
const RATE = rate();
const env = { DB, RESOURCES: r2(FILES), SESSION_SECRET: SECRET, ADMIN_EMAIL: OWNER, ADMIN_PASSWORD: OWNER_PW, RATE: RATE.RATE };
const call = (path, { method = 'GET', headers = {}, body, e = env } = {}) =>
  worker.fetch(new Request(ORIGIN + path, { method, headers, body }), e);
const browser = (cookie) => ({ cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' });
const post = (path, body, cookie, e = env) =>
  call(path, { method: 'POST', headers: { ...browser(cookie), 'content-type': 'application/json' }, body: JSON.stringify(body), e });

let adminCookie = '';
let beforeBoot;
before(async () => {
  beforeBoot ||= call('/api/me').then((res) => assert.equal(res.status, 401));
  await beforeBoot;
  const res = await call('/api/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'cf-connecting-ip': '10.0.0.1', 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER, password: OWNER_PW }),
  });
  adminCookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
});

let n = 0;
async function student() {
  const email = `student${++n}@example.com`;
  raw.prepare('INSERT INTO users (email, pass, is_admin, ver, sid) VALUES (?, ?, 0, 0, NULL)')
    .run(email, await hashPw('student-pass-1'));
  return { email, id: raw.prepare('SELECT id FROM users WHERE email = ?').get(email).id };
}

/** Seed a YouTube lesson plus one row in every table keyed by the lesson path. */
function seedLesson(id, yt = 'VID1') {
  raw.prepare('INSERT OR REPLACE INTO youtube_lessons (id, yt, created) VALUES (?, ?, ?)').run(id, yt, 123);
  const uid = raw.prepare('INSERT INTO users (email, pass, is_admin, ver, sid) VALUES (?, ?, 0, 0, NULL) RETURNING id')
    .get(`seed${++n}@example.com`, 'x').id;
  raw.prepare('INSERT INTO watched (user_id, lesson) VALUES (?, ?)').run(uid, id);
  raw.prepare('INSERT INTO pdf_notes (user_id, lesson, data, updated) VALUES (?, ?, ?, ?)').run(uid, id, 'pdf', 1);
  raw.prepare('INSERT INTO video_notes (user_id, lesson, body, updated) VALUES (?, ?, ?, ?)').run(uid, id, 'vid', 1);
  raw.prepare('INSERT INTO note_assets (user_id, lesson, asset_id, type, created) VALUES (?, ?, ?, ?, ?)').run(uid, id, 'a1', 'image/png', 1);
  raw.prepare('INSERT INTO comments (lesson, user_id, parent_id, body, created) VALUES (?, ?, NULL, ?, ?)').run(id, uid, 'hi', 1);
  raw.prepare("INSERT INTO resources (lesson, title, url, note, created_by, created, kind, file_key) VALUES (?, ?, '', NULL, ?, ?, 'pdf', ?)").run(id, 'r', uid, 1, 'MERN Stack/Intro/res.pdf');
  raw.prepare('INSERT OR REPLACE INTO content_order (path, position) VALUES (?, ?)').run(id, 7);
  return uid;
}

const count = (sql, ...args) => raw.prepare(sql).get(...args).n;

test('POST /api/admin/youtube/rename moves the lesson row and all student data', async () => {
  const oldId = 'MERN Stack/class_01';
  const newId = 'MERN Stack/Introduction';
  seedLesson(oldId, 'ABC123');

  const res = await post('/api/admin/youtube/rename', { id: oldId, name: 'Introduction' }, adminCookie);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: newId });

  assert.equal(count('SELECT COUNT(*) n FROM youtube_lessons WHERE id = ?', oldId), 0, 'old id is gone');
  assert.equal(count('SELECT COUNT(*) n FROM youtube_lessons WHERE id = ? AND yt = ?', newId, 'ABC123'), 1, 'same video under the new id');
  for (const table of ['watched', 'pdf_notes', 'video_notes', 'note_assets', 'comments', 'resources']) {
    assert.equal(count(`SELECT COUNT(*) n FROM ${table} WHERE lesson = ?`, oldId), 0, `${table} no rows left on the old id`);
    assert.equal(count(`SELECT COUNT(*) n FROM ${table} WHERE lesson = ?`, newId), 1, `${table} moved to the new id`);
  }
  assert.equal(raw.prepare('SELECT position FROM content_order WHERE path = ?').get(newId)?.position, 7, 'saved order moved');
  assert.equal(count('SELECT COUNT(*) n FROM content_order WHERE path = ?', oldId), 0);
});

test('the renamed lesson shows up under its new name in the course', async () => {
  raw.prepare('INSERT OR REPLACE INTO youtube_lessons (id, yt, created) VALUES (?, ?, ?)').run('MERN Stack/class_02', 'VID2', 1);
  const res = await post('/api/admin/youtube/rename', { id: 'MERN Stack/class_02', name: 'Setup' }, adminCookie);
  assert.equal(res.status, 200);

  const course = (await (await call('/api/course', { headers: browser(adminCookie) })).json())
    .find((c) => c.title === 'MERN Stack');
  const titles = course.sections.flatMap((s) => s.lessons).map((l) => l.title);
  assert.ok(titles.includes('Setup'), 'new name is listed');
  assert.ok(!titles.includes('class_02'), 'old name is gone');
});

test('rename refuses a conflict with another lesson or a real file', async () => {
  seedLesson('MERN Stack/A');
  seedLesson('MERN Stack/B');

  let res = await post('/api/admin/youtube/rename', { id: 'MERN Stack/A', name: 'B' }, adminCookie);
  assert.equal(res.status, 409, 'cannot land on another lesson');

  res = await post('/api/admin/youtube/rename', { id: 'MERN Stack/A', name: 'existing.mp4' }, adminCookie);
  assert.equal(res.status, 409, 'cannot land on an R2 file');
  assert.equal(count('SELECT COUNT(*) n FROM youtube_lessons WHERE id = ?', 'MERN Stack/A'), 1, 'the source is untouched');
});

test('rename validates the name and requires an existing lesson', async () => {
  for (const [body, status] of [
    [{ id: 'MERN Stack/class_03', name: '' }, 400],
    [{ id: 'MERN Stack/class_03', name: 'a/b' }, 400],
    [{ id: '', name: 'x' }, 400],
    [{ id: 'MERN Stack/nope', name: 'x' }, 404],
  ]) {
    const res = await post('/api/admin/youtube/rename', body, adminCookie);
    assert.equal(res.status, status, JSON.stringify(body));
  }
});

test('renaming to the same name is a harmless no-op', async () => {
  seedLesson('MERN Stack/same');
  const res = await post('/api/admin/youtube/rename', { id: 'MERN Stack/same', name: 'same' }, adminCookie);
  assert.equal(res.status, 200);
  assert.equal(count('SELECT COUNT(*) n FROM youtube_lessons WHERE id = ?', 'MERN Stack/same'), 1);
});

test('only an admin may rename', async () => {
  const { email } = await student();
  const cookie = (await call('/api/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'cf-connecting-ip': '10.0.0.2', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'student-pass-1' }),
  })).headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
  const res = await post('/api/admin/youtube/rename', { id: 'MERN Stack/class_01', name: 'x' }, cookie);
  assert.equal(res.status, 403);
});