// Route-level tests for text/Markdown lessons and reserved RESOURCE folders. They drive the
// real Worker entry through a fake D1 (node:sqlite) and a fake R2, like security.test.mjs.
// This file grows through Tasks 3-7, so the harness stays small and reusable.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { db, r2, hashPw, rate } from './harness.mjs';

const SECRET = 'S'.repeat(40);
const OWNER = 'owner@example.com';
const OWNER_PW = 'owner-pass-123';
const ORIGIN = 'https://s.example';
const STUDENT_PW = 'student-pass-1';

// One course with a shared RESOURCE folder, a video, a Markdown and a text lesson, plus an
// HLS segment that must never appear as a lesson of its own.
const FILES = {
  'Course/RESOURCE/syllabus.pdf': '%PDF-1.4\nsyllabus',
  'Course/Module 01/Module 01 - Intro.mp4': new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  'Course/Module 01/guide.md': '# Guide\n\nRead me.',
  'Course/Module 01/notes.txt': 'plain notes',
  'Course/Module 01/clip.ts': new Uint8Array([1, 2, 3]), // HLS segment
};

const { raw, DB } = db();
const RATE = rate();
const env = { DB, RESOURCES: r2(FILES), SESSION_SECRET: SECRET, ADMIN_EMAIL: OWNER, ADMIN_PASSWORD: OWNER_PW, RATE: RATE.RATE };

const call = (path, { method = 'GET', headers = {}, body, e = env } = {}) =>
  worker.fetch(new Request(ORIGIN + path, { method, headers, body }), e);

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
// enrolled student whose session every test reuses.
let cookie = '';
before(async () => {
  await call('/api/me').then((res) => assert.equal(res.status, 401)); // boot the schema
  const email = await addUser();
  await enroll(email, 'Course');
  ({ cookie } = await login(email));
});

test('listCourse lists text/markdown lessons and skips the RESOURCE folder', async () => {
  const data = await call('/api/course', { headers: { cookie } }).then((r) => r.json());
  const course = data.find((c) => c.title === 'Course');
  const lessons = course.sections.flatMap((s) => s.lessons);
  assert.deepEqual(lessons.filter((l) => l.kind === 'md').map((l) => l.id), ['Course/Module 01/guide.md']);
  assert.deepEqual(lessons.filter((l) => l.kind === 'txt').map((l) => l.id), ['Course/Module 01/notes.txt']);
  assert.ok(!lessons.some((l) => l.id.includes('RESOURCE')), 'shared files are not lessons');
  assert.ok(!lessons.some((l) => l.id.endsWith('clip.ts')), 'HLS segments are not lessons');
});

test('serve returns text and markdown with the right content type', async () => {
  const md = await call('/api/media/Course/Module%2001/guide.md', { headers: browser(cookie) });
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.match(md.headers.get('x-content-type-options'), /nosniff/);
  const txt = await call('/api/media/Course/Module%2001/notes.txt', { headers: browser(cookie) });
  assert.equal(txt.status, 200);
  assert.match(txt.headers.get('content-type'), /text\/plain/);
});
