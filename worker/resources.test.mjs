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
  'RESOURCE/global.txt': 'top level',
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
// enrolled student and an admin whose sessions every test reuses.
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

function fileForm(name, body) {
  const form = new FormData();
  form.append('file', new File([body], name));
  return form;
}

test('listCourse lists text/markdown lessons and skips the RESOURCE folder', async () => {
  const data = await call('/api/course', { headers: { cookie } }).then((r) => r.json());
  const course = data.find((c) => c.title === 'Course');
  const lessons = course.sections.flatMap((s) => s.lessons);
  assert.deepEqual(lessons.filter((l) => l.kind === 'md').map((l) => l.id), ['Course/Module 01/guide.md']);
  assert.deepEqual(lessons.filter((l) => l.kind === 'txt').map((l) => l.id), ['Course/Module 01/notes.txt']);
  assert.ok(!lessons.some((l) => l.id.includes('RESOURCE')), 'shared files are not lessons');
  assert.ok(!lessons.some((l) => l.id.endsWith('clip.ts')), 'HLS segments are not lessons');
  assert.ok(!data.some((c) => c.title === 'RESOURCE'), 'a top-level RESOURCE folder is not a course');
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

test('a txt resource uploads with kind txt and a .txt file_key', async () => {
  const res = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('cheat.txt', 'plain text') });
  assert.equal(res.status, 200);
  const { resource } = await res.json();
  assert.equal(resource.kind, 'txt');
  assert.match(resource.url, /^Course\/_resources\/[0-9a-f-]+\.txt$/);
});

test('a .markdown resource maps to kind md; the legacy /pdf route still works', async () => {
  const md = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('doc.markdown', '# Doc') });
  assert.equal((await md.json()).resource.kind, 'md');
  const pdf = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/pdf',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('slides.pdf', '%PDF-1.4\nx') });
  assert.equal(pdf.status, 200);
  assert.equal((await pdf.json()).resource.kind, 'pdf');
});

test('text resources reject a NUL byte, an oversized body and an unknown extension', async () => {
  const nul = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('bad.txt', new Uint8Array([65, 0, 66])) });
  assert.equal(nul.status, 400);
  const big = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('big.txt', 'x'.repeat(2 * 1024 * 1024 + 1)) });
  assert.equal(big.status, 413);
  const exe = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('run.exe', 'x') });
  assert.equal(exe.status, 400);
});

test('GET reports real kinds; PATCH ignores a url on a file row; DELETE removes the object', async () => {
  const listed = await call('/api/lesson/Course%2FModule%2001%2Fguide.md/resources', { headers: { cookie } });
  const body = await listed.json(); // read the body once: a Response stream cannot be re-read
  const kinds = body.resources.map((r) => r.kind);
  assert.ok(kinds.includes('txt') && kinds.includes('md') && kinds.includes('pdf'));
  const txt = body.resources.find((r) => r.kind === 'txt');
  const patched = await call(`/api/admin/resources/${txt.id}`,
    { method: 'PATCH', headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Cheat sheet', url: 'https://evil.example' }) });
  assert.equal((await patched.json()).resource.url, txt.url, 'the file_key survives a url in the body');
  const key = txt.url;
  const del = await call(`/api/admin/resources/${txt.id}`, { method: 'DELETE', headers: { cookie: adminCookie, origin: ORIGIN } });
  assert.equal(del.status, 200);
  assert.equal(env.RESOURCES.has(key), false, 'the R2 object is gone');
});

test('deleting a non-pdf resource does not touch pdf_notes', async () => {
  const res = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('pin.txt', 'pin') });
  assert.equal(res.status, 200);
  const { resource } = await res.json();
  // Seed a pdf_notes row keyed by this non-pdf resource's file_key directly.
  await env.DB.prepare('INSERT OR REPLACE INTO pdf_notes (user_id, lesson, data, updated) VALUES (?, ?, ?, ?)')
    .bind(1, resource.url, '[]', Date.now()).run();
  const del = await call(`/api/admin/resources/${resource.id}`, { method: 'DELETE', headers: { cookie: adminCookie, origin: ORIGIN } });
  assert.equal(del.status, 200);
  const n = (await env.DB.prepare('SELECT COUNT(*) n FROM pdf_notes WHERE lesson = ?').bind(resource.url).first()).n;
  assert.equal(Number(n), 1, 'a non-pdf delete does not touch pdf_notes');
});
