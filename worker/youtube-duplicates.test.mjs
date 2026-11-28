// A chapter can legitimately hold two videos with the same title ("Live Class", part 1 and
// part 2). The path used to be the identity, so the second upload overwrote the first link.
// Now the duplicate keeps the same visible name and gets a hidden ordinal in its id; an
// identical name *and* link is still idempotent, so re-importing a file changes nothing.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { db, r2, rate } from './harness.mjs';

const M = '\u200B';
const SECRET = 'S'.repeat(40);
const OWNER = 'owner@example.com';
const OWNER_PW = 'owner-pass-123';
const ORIGIN = 'https://s.example';

const { raw, DB } = db();
const RATE = rate();
const env = { DB, RESOURCES: r2(), SESSION_SECRET: SECRET, ADMIN_EMAIL: OWNER, ADMIN_PASSWORD: OWNER_PW, RATE: RATE.RATE };
const call = (path, { method = 'GET', headers = {}, body } = {}) =>
  worker.fetch(new Request(ORIGIN + path, { method, headers, body }), env);
const post = (path, body) =>
  call(path, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

let adminCookie = '';
before(async () => {
  const res = await call('/api/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'cf-connecting-ip': '10.0.0.1', 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER, password: OWNER_PW }),
  });
  adminCookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
});

const ids = (prefix) => raw.prepare('SELECT id FROM youtube_lessons WHERE id LIKE ? ORDER BY id').all(prefix + '/%').map((r) => r.id);
const positions = () => raw.prepare('SELECT path, position FROM content_order ORDER BY position').all();
const xp = (prefix) => positions().filter((r) => r.path.startsWith(prefix)).map((r) => [r.path, r.position]);
const ytOf = (id) => raw.prepare('SELECT yt FROM youtube_lessons WHERE id = ?').get(id)?.yt;

test('the same name with different links becomes two lessons with one visible title', async () => {
  const res = await post('/api/admin/youtube', {
    course: 'Same', folder: '',
    lessons: [
      { lesson: 'Live Class', link: 'https://youtu.be/aaaaaaaaaa' },
      { lesson: 'Live Class', link: 'https://youtu.be/bbbbbbbbbb' },
    ],
    order: true,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).added, 2);
  assert.deepEqual(ids('Same'), [`Same/Live Class`, `Same/Live Class${M}2`]);
  assert.deepEqual(xp('Same/'), [['Same/Live Class', 1], [`Same/Live Class${M}2`, 2]]);

  const course = (await (await call('/api/course', { headers: { cookie: adminCookie } })).json()).find((c) => c.title === 'Same');
  const titles = course.sections.flatMap((s) => s.lessons.map((l) => l.title));
  assert.deepEqual(titles, ['Live Class', 'Live Class']);
});

test('the same name and link twice is one lesson', async () => {
  const res = await post('/api/admin/youtube', {
    course: 'Twice', folder: '',
    lessons: [
      { lesson: 'Same', link: 'https://youtu.be/aaaaaaaaaa' },
      { lesson: 'Same', link: 'https://youtu.be/aaaaaaaaaa' },
      { lesson: 'Next', link: 'https://youtu.be/cccccccccc' },
    ],
    order: true,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).added, 2);
  assert.deepEqual(ids('Twice'), ['Twice/Next', 'Twice/Same']);
  assert.deepEqual(xp('Twice/'), [['Twice/Same', 1], ['Twice/Next', 2]]);
});

test('re-importing the same file adds nothing', async () => {
  const file = {
    course: 'Again2', folder: '',
    lessons: [
      { lesson: 'One', link: 'https://youtu.be/aaaaaaaaaa' },
      { lesson: 'One', link: 'https://youtu.be/bbbbbbbbbb' },
    ],
    order: true,
  };
  assert.equal((await post('/api/admin/youtube', file)).status, 200);
  const again = await post('/api/admin/youtube', file);
  assert.equal(again.status, 200);
  const body = await again.json();
  assert.equal(body.added, 0);
  assert.equal(body.unchanged, 2);
  assert.deepEqual(ids('Again2'), [`Again2/One`, `Again2/One${M}2`]);
});

test('adding the dialog lesson again with a new link keeps both', async () => {
  await post('/api/admin/youtube', { course: 'Dialog', lesson: 'X', link: 'https://youtu.be/aaaaaaaaaa' });
  const res = await post('/api/admin/youtube', { course: 'Dialog', lesson: 'X', link: 'https://youtu.be/bbbbbbbbbb' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, `Dialog/X${M}2`);
  assert.equal(ytOf('Dialog/X'), 'aaaaaaaaaa');
  assert.equal(ytOf(`Dialog/X${M}2`), 'bbbbbbbbbb');
});

test('editing one duplicate by id leaves the other alone', async () => {
  const res = await post('/api/admin/youtube', { id: 'Dialog/X', link: 'https://youtu.be/cccccccccc' });
  assert.equal(res.status, 200);
  assert.equal(ytOf('Dialog/X'), 'cccccccccc');
  assert.equal(ytOf(`Dialog/X${M}2`), 'bbbbbbbbbb');
});

test('renaming a duplicate to the same visible name is a no-op', async () => {
  const id = `Dialog/X${M}2`;
  const res = await post('/api/admin/youtube/rename', { id, name: 'X' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, id);
  assert.equal(ytOf(id), 'bbbbbbbbbb');
});