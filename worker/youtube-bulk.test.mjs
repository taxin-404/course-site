// Importing a whole course of YouTube lessons is one request, and the `no.` column turns
// into the folder's saved order. These route tests prove the batch is all-or-nothing, that
// the block lands after what the admin already arranged, and that re-importing a name
// updates its link without moving it.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { db, r2, rate } from './harness.mjs';

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

test('one request adds every lesson', async () => {
  const res = await post('/api/admin/youtube', {
    course: 'Bulk1', folder: 'Section',
    lessons: [
      { lesson: 'One', link: 'https://youtu.be/aaaaaaaaaa' },
      { lesson: 'Two', link: 'bbbbbbbbbb' },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added, 2);
  assert.deepEqual(body.shadowed, []);
  assert.deepEqual(ids('Bulk1'), ['Bulk1/Section/One', 'Bulk1/Section/Two']);
});

test('numbered rows are appended after what is already in the folder', async () => {
  raw.prepare("INSERT INTO youtube_lessons (id, yt, created) VALUES ('Order/Existing', 'cccccccccc', 1)").run();
  const res = await post('/api/admin/youtube', {
    course: 'Order', folder: '',
    lessons: [
      { lesson: 'Second', link: 'https://youtu.be/bbbbbbbbbb' },
      { lesson: 'First', link: 'https://youtu.be/aaaaaaaaaa' },
    ],
    order: true,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).order, true);
  assert.deepEqual(positions().filter((r) => r.path.startsWith('Order/')).map((r) => [r.path, r.position]), [
    ['Order/Existing', 1],
    ['Order/Second', 2],
    ['Order/First', 3],
  ]);
});

test('an existing name is updated in place and not moved', async () => {
  raw.prepare("INSERT INTO youtube_lessons (id, yt, created) VALUES ('Again/Pinned', 'dddddddddd', 1)").run();
  raw.prepare("INSERT INTO content_order (path, position) VALUES ('Again/Pinned', 1)").run();
  const res = await post('/api/admin/youtube', {
    course: 'Again', folder: '',
    lessons: [
      { lesson: 'Pinned', link: 'https://youtu.be/zzzzzzzzzz' },
      { lesson: 'New', link: 'https://youtu.be/yyyyyyyyyy' },
    ],
    order: true,
  });
  assert.equal(res.status, 200);
  assert.equal(raw.prepare("SELECT yt FROM youtube_lessons WHERE id = 'Again/Pinned'").get().yt, 'zzzzzzzzzz');
  assert.deepEqual(positions().filter((r) => r.path.startsWith('Again/')).map((r) => [r.path, r.position]), [
    ['Again/Pinned', 1],
    ['Again/New', 2],
  ]);
});

test('one bad row refuses the whole batch', async () => {
  const res = await post('/api/admin/youtube', {
    course: 'BadBatch', folder: '',
    lessons: [
      { lesson: 'Good', link: 'https://youtu.be/aaaaaaaaaa' },
      { lesson: 'Bad', link: 'https://example.com/x' },
    ],
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /row 2/i);
  assert.deepEqual(ids('BadBatch'), []);
});

test('a non-admin cannot use the bulk form', async () => {
  const res = await call('/api/admin/youtube', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ course: 'Nope', folder: '', lessons: [{ lesson: 'X', link: 'https://youtu.be/aaaaaaaaaa' }] }),
  });
  assert.ok([401, 403].includes(res.status));
});
