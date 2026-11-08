// Route-level tests for the security hardening. They drive the real Worker entry through a
// fake D1 (node:sqlite) and a fake R2, so the checks that matter live in code, not in prose.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import worker, { invalidateCourse, nonceOk } from './index.js';
import { pace } from './limits.js';
import { db, r2, hashPw } from './harness.mjs';
// The client decoder is the contract for the scrambled payload, so the test decodes the
// real response with the real client code rather than a copy of the algorithm.
import { decodeYt } from '../src/app/yt-cipher.ts';

const SECRET = 'S'.repeat(40);
const OWNER = 'owner@example.com';
const OWNER_PW = 'owner-pass-123';
const ORIGIN = 'https://s.example';
const STUDENT_PW = 'student-pass-1';

// Two courses so an "unenrolled" case exists: a student is granted Course, never Other.
const FILES = {
  'Course/notes.pdf': '%PDF-1.4\nCourse notes',
  'Course/clip.mp4': new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  'Course/big.mp4': new Uint8Array(5 * 1024 * 1024),
  'Course/paced.pdf': new Uint8Array(520000), // just over a 5-second burst at 0.8 Mbps
  'Course/deleteme.pdf': '%PDF-1.4\nThrowaway lesson', // lesson delete removes its note images
  'Other/hidden.pdf': '%PDF-1.4\nOther course',
  'Other/banner.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
};

const { raw, DB } = db();
const env = { DB, RESOURCES: r2(FILES), SESSION_SECRET: SECRET, ADMIN_EMAIL: OWNER, ADMIN_PASSWORD: OWNER_PW };

const call = (path, { method = 'GET', headers = {}, body, e = env } = {}) =>
  worker.fetch(new Request(ORIGIN + path, { method, headers, body }), e);

// The Worker memoises schema setup per process, so boot once and reuse the same database.
let booted;
before(async () => {
  // /api/config no longer touches D1, so boot the schema through a database route.
  booted ||= call('/api/me').then((res) => assert.equal(res.status, 401));
  await booted;
});

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
const browser = (cookie, dest = 'empty') => ({ cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': dest });

test('fails closed when SESSION_SECRET is missing or too short', async () => {
  for (const secret of [undefined, 'short', 'x'.repeat(31)]) {
    const res = await call('/api/me', { e: { ...env, SESSION_SECRET: secret } });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Server error' });
  }
});

test('rejects state-changing calls that do not come from this site (CSRF)', async () => {
  const crossOrigin = await call('/api/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  const crossSite = await call('/api/login', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(crossSite.status, 403);
});

test('API responses carry HSTS (includeSubDomains) and are not cacheable', async () => {
  const res = await call('/api/config');
  assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('Google sign-in binds the token to a nonce the page got from /api/config', async () => {
  const res = await call('/api/config');
  const body = await res.json();
  assert.ok(typeof body.nonce === 'string' && body.nonce.length >= 16, 'config returns a nonce');
  assert.ok((res.headers.get('set-cookie') || '').startsWith('gn=' + body.nonce + ';'), 'the nonce is also set as a cookie');
  assert.ok((res.headers.get('set-cookie') || '').includes('SameSite=Strict'), 'the nonce cookie is same-site');
  // The callback must echo exactly the nonce the page was given.
  assert.equal(nonceOk(body.nonce, body.nonce), true);
  assert.equal(nonceOk('other-nonce-value', body.nonce), false);
  assert.equal(nonceOk(undefined, body.nonce), false);
  assert.equal(nonceOk(body.nonce, ''), false);
});

test('/api/config keeps the nonce a browser already holds', async () => {
  const first = await call('/api/config');
  const n1 = (await first.json()).nonce;
  const cookie = (first.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('gn=' + n1), 'the nonce is set as a cookie');
  const second = await call('/api/config', { headers: { cookie } });
  assert.equal((await second.json()).nonce, n1, 'a second call does not rotate the bound nonce');
  // A junk cookie must not be reflected back as the nonce.
  const junk = await call('/api/config', { headers: { cookie: 'gn=!!not-a-nonce!!' } });
  const n3 = (await junk.json()).nonce;
  assert.notEqual(n3, '!!not-a-nonce!!');
  assert.match(n3, /^[A-Za-z0-9_-]{16,}$/);
});

test('a malformed percent-escape in a path is a 400, not a 500', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  for (const path of ['/api/media/Course/%', '/api/notes/%', '/api/lesson/%/comments', '/api/lesson/%/yt']) {
    const res = await call(path, { headers: browser(cookie) });
    assert.equal(res.status, 400, path + ' -> ' + res.status);
    assert.deepEqual(await res.json(), { error: 'Bad request' });
  }
});

test('a failed login reveals nothing about whether the email exists', async () => {
  const known = await addUser();
  const a = await login(known, { pw: 'wrong-password', ip: '10.0.0.2' });
  const b = await login('nobody@example.com', { pw: 'wrong-password', ip: '10.0.0.3' });
  assert.equal(a.res.status, 401);
  assert.equal(b.res.status, 401);
  assert.deepEqual(await a.res.json(), await b.res.json());
});

test('login throttling locks an email+IP after 8 failures', async () => {
  const email = await addUser();
  const ip = '10.0.0.9';
  for (let i = 0; i < 8; i++) {
    const { res } = await login(email, { pw: 'nope', ip });
    assert.equal(res.status, 401, `attempt ${i + 1} is a normal rejection`);
  }
  const { res } = await login(email, { pw: 'nope', ip });
  assert.equal(res.status, 429, 'the 9th attempt is throttled');
});

test('login throttling also counts failures per email, across many IPs', async () => {
  const email = await addUser();
  // Each attempt comes from a different IP, so the email+IP cap (8) and the per-IP cap (40)
  // never trip: only a per-email counter can catch a distributed guess against one account.
  for (let i = 0; i < 30; i++) {
    const { res } = await login(email, { pw: 'nope', ip: `10.2.${i}.1` });
    assert.equal(res.status, 401, `attempt ${i + 1} is a normal rejection`);
  }
  const { res } = await login(email, { pw: 'nope', ip: '10.3.0.1' });
  assert.equal(res.status, 429, 'the account is throttled even though every IP is new');
});

test('media: the browser gate and the range-only rule are enforced', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);

  // No Sec-Fetch metadata (curl/wget/yt-dlp): refused.
  assert.equal((await call('/api/media/Course/notes.pdf', { headers: { cookie } })).status, 403);
  // A top-level navigation / iframe / new tab is refused.
  assert.equal((await call('/api/media/Course/notes.pdf', { headers: browser(cookie, 'document') })).status, 403);
  // A normal in-page fetch is served.
  assert.equal((await call('/api/media/Course/notes.pdf', { headers: browser(cookie) })).status, 200);
  // Video without a Range header is refused; with one it is served (206, not 200).
  assert.equal((await call('/api/media/Course/clip.mp4', { headers: browser(cookie, 'video') })).status, 403);
  assert.equal((await call('/api/media/Course/clip.mp4', { headers: { ...browser(cookie, 'video'), range: 'bytes=0-' } })).status, 206);
});

test('media: only a single well-formed Range is served; anything else is refused', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const video = (range) => call('/api/media/Course/clip.mp4', { headers: { ...browser(cookie, 'video'), range } });
  // Ranges that used to fall through to R2 (which returns the whole object) now 416.
  assert.equal((await video('bytes=-500')).status, 416, 'a suffix range is refused');
  assert.equal((await video('bytes=5-2')).status, 416, 'end before start is refused');
  assert.equal((await video('bytes=0-1,3-4')).status, 416, 'a multi-range is refused');
  assert.equal((await video('bytes=abc')).status, 416, 'junk is refused');
  assert.equal((await video('bytes=')).status, 416, 'an empty range is refused');
  assert.equal((await video('bytes=0-100')).status, 206, 'a normal range is still served');
});

test('media: a range larger than one chunk is capped', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const res = await call('/api/media/Course/big.mp4', { headers: { ...browser(cookie, 'video'), range: 'bytes=0-' } });
  assert.equal(res.status, 206);
  assert.equal(Number(res.headers.get('content-length')), 4 * 1024 * 1024, 'one chunk, not the whole file');
  const tail = await call('/api/media/Course/big.mp4', { headers: { ...browser(cookie, 'video'), range: 'bytes=100000-6000000' } });
  assert.equal(Number(tail.headers.get('content-length')), 4 * 1024 * 1024, 'an oversized explicit range is capped too');
});

test('media: a PDF body is paced, so one request cannot dump the file at wire speed', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  // 0.8 Mbps = 100,000 bytes/second; a 5-second burst is 500,000 bytes, so a 520 KB body
  // must spend roughly 200 ms waiting. Timers never fire early, so a lower bound is stable.
  const e = { ...env, MAX_PDF_MBPS: 0.8 };
  const started = Date.now();
  const res = await call('/api/media/Course/paced.pdf', { headers: browser(cookie), e });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let total = 0;
  let firstMs = null;
  let slices = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstMs === null) firstMs = Date.now() - started;
    total += value.byteLength;
    slices++;
  }
  const elapsed = Date.now() - started;
  assert.equal(total, 520000, 'the whole body still arrives');
  assert.ok(slices > 1, 'a big chunk is delivered in pieces, got ' + slices);
  assert.ok(firstMs < 100, 'the first bytes arrive inside the burst, got ' + firstMs + 'ms');
  assert.ok(elapsed >= 150, 'the body still waited at the rate, got ' + elapsed + 'ms');
});

test('the pacer allows a burst, then charges the rest at the configured rate', () => {
  const rate = 1000; // bytes/second
  const burst = 1000; // one second of bytes flow without waiting
  // Inside the burst: free.
  let step = pace(burst, { rate, burst, bytes: 500, elapsedMs: 0 });
  assert.equal(step.waitMs, 0, 'the burst is free');
  // 500 bytes of credit, then 1000 more: the 500 over budget cost half a second.
  step = pace(step.tokens, { rate, burst, bytes: 1000, elapsedMs: 0 });
  assert.equal(Math.round(step.waitMs), 500, 'over-budget bytes wait at the rate');
  // Waiting refills exactly what it charged, so the bucket is back to zero, never negative.
  assert.ok(step.tokens >= 0 && step.tokens < 1, 'the wait refills the bucket: ' + step.tokens);
  // An idle second refills the whole burst, so a pause is not punished.
  assert.equal(pace(0, { rate, burst, bytes: 500, elapsedMs: 1000 }).waitMs, 0, 'an idle second refills');
});

test('PDF notes: only a real PDF lesson or a real resource PDF is accepted', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const headers = { cookie, 'content-type': 'application/json' };
  const put = (key, data) => call('/api/notes/' + key.split('/').map(encodeURIComponent).join('/'), { method: 'PUT', headers, body: JSON.stringify({ data }) });

  assert.equal((await put('Course/notes.pdf', [{ x: 1 }])).status, 200, 'a real PDF lesson is accepted');
  assert.equal((await put('Course/made-up.pdf', [{ x: 1 }])).status, 404, 'an invented key is refused');

  raw.prepare("INSERT INTO resources (lesson, title, url, note, created_by, created, kind, file_key) VALUES ('Course/notes.pdf','R','',NULL,1,?, 'pdf', 'Course/_resources/real.pdf')").run(Date.now());
  assert.equal((await put('Course/_resources/real.pdf', [{ x: 2 }])).status, 200, 'a resource PDF is accepted');
  const rows = raw.prepare('SELECT COUNT(*) c FROM pdf_notes').get().c;
  assert.equal(rows, 2, 'only the two real PDFs got a row');
  raw.prepare("DELETE FROM resources WHERE file_key = 'Course/_resources/real.pdf'").run();
});

test('PDF notes are limited by bytes, not characters', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const headers = { cookie, 'content-type': 'application/json' };
  const put = (data) => call('/api/notes/Course/notes.pdf', { method: 'PUT', headers, body: JSON.stringify({ data }) });

  const under = 'ক'.repeat(400000); // 1.2 MB in UTF-8
  assert.equal((await put([under])).status, 200, 'a 1.2 MB payload is saved');
  const over = 'ক'.repeat(500001); // 1,500,003 bytes, but only 500,001 characters
  assert.equal((await put([over])).status, 413, 'a payload over 1.5 MB in bytes is refused');
});

test('media: a student only reaches courses they are enrolled in', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  assert.equal((await call('/api/media/Other/hidden.pdf', { headers: browser(cookie) })).status, 403);
});

test('media: the per-hour distinct-lesson limit answers 429', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const headers = browser(cookie);
  for (let i = 0; i < 20; i++) {
    // These keys are not in the bucket (404), but the lesson is still counted.
    assert.notEqual((await call(`/api/media/Course/lesson-${i}.pdf`, { headers })).status, 429);
  }
  assert.equal((await call('/api/media/Course/lesson-21.pdf', { headers })).status, 429);
});

test('media: repeating one lesson does not consume the per-hour distinct quota', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const headers = browser(cookie);
  // An HLS burst is one lesson fetched many times; it must count once, not fifty times.
  for (let i = 0; i < 50; i++) {
    assert.notEqual((await call('/api/media/Course/repeat.pdf', { headers })).status, 429, `repeat ${i}`);
  }
  for (let i = 0; i < 19; i++) {
    assert.notEqual((await call(`/api/media/Course/extra-${i}.pdf`, { headers })).status, 429, `extra ${i}`);
  }
  assert.equal((await call('/api/media/Course/extra-21.pdf', { headers })).status, 429, 'the 21st distinct lesson');
});

test('media: a repeat request for the same lesson does not touch D1 for the hit counter', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const headers = browser(cookie);
  await call('/api/media/Course/notes.pdf', { headers }); // records this lesson for the hour
  env.DB.stats.reset();
  await call('/api/media/Course/notes.pdf', { headers });
  // The session and enrollment reads still happen (they are security checks), but the
  // lesson-hit INSERT and COUNT must not: an HLS burst would otherwise double D1 traffic.
  assert.ok(env.DB.stats.roundTrips <= 2, 'repeat used ' + env.DB.stats.roundTrips + ' D1 round trips');
});

test('a cold course listing reads its three metadata tables in one batched round trip', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  await call('/api/course', { headers: { cookie } }); // warm the schema memo and the course cache
  invalidateCourse();
  env.DB.stats.reset();
  const res = await call('/api/course', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.ok(env.DB.stats.batches >= 1, 'metadata reads go through a batch');
  assert.ok(env.DB.stats.batchedStatements >= 3, 'all three reads share the batch, got ' + env.DB.stats.batchedStatements);
});

test('/api/progress only accepts a real lesson in a course the student has', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const headers = { cookie, origin: ORIGIN, 'content-type': 'application/json' };
  const send = (lesson) => call('/api/progress', { method: 'POST', headers, body: JSON.stringify({ lesson, done: true }) });
  assert.equal((await send('Course/missing.pdf')).status, 404, 'unknown lesson');
  assert.equal((await send('Other/hidden.pdf')).status, 403, 'known lesson, unenrolled course');
  assert.equal((await send('Course/notes.pdf')).status, 200, 'known lesson in an enrolled course');
});

test('a course banner is served to any signed-in user, and SVG cannot run script', async () => {
  const email = await addUser(); // deliberately not enrolled in Other
  const { cookie } = await login(email);
  invalidateCourse();

  const svg = await call('/api/banner/Other', { headers: browser(cookie) });
  assert.equal(svg.status, 200, 'a signed-in outsider still gets the card banner');
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.equal(svg.headers.get('cache-control'), 'private, no-store');
  const csp = svg.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /sandbox/);
  assert.match(await svg.text(), /<svg/);

  assert.equal((await call('/api/banner/Course', { headers: browser(cookie) })).status, 404, 'no banner file');
});

test('YouTube ids are fetched per lesson and never appear in /api/course', async () => {
  raw.prepare('INSERT OR IGNORE INTO youtube_lessons (id, yt, created) VALUES (?, ?, ?)').run('Course/Clip', 'dQw4w9WgXcQ', Date.now());
  invalidateCourse();

  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);

  const course = await (await call('/api/course', { headers: { cookie } })).json();
  const clip = course.flatMap((c) => c.sections.flatMap((s) => s.lessons)).find((l) => l.id === 'Course/Clip');
  assert.ok(clip, 'the YouTube lesson is listed');
  assert.ok(!('yt' in clip), 'the bulk course response carries no video id');

  const yt = await call('/api/lesson/Course/Clip/yt', { headers: { cookie } });
  assert.equal(yt.status, 200);
  const { ytKey } = await (await call('/api/me', { headers: { cookie } })).json();
  assert.equal(typeof ytKey, 'string');
  assert.ok(ytKey.length > 0, 'the session carries an obfuscation key');
  const body = await yt.json();
  assert.notEqual(body.yt, 'dQw4w9WgXcQ', 'the id is not the plain value');
  assert.ok(!String(body.yt).includes('dQw4w9WgXcQ'), 'the plain id does not appear in the payload');
  assert.equal(decodeYt(ytKey, body.yt), 'dQw4w9WgXcQ', 'the client decodes the real id');

  // A student without the course cannot fetch the id...
  const outsider = await addUser();
  const out = await login(outsider, { ip: '10.0.0.4' });
  assert.equal((await call('/api/lesson/Course/Clip/yt', { headers: { cookie: out.cookie } })).status, 403);
  // ...and a non-YouTube lesson answers 404, not an id.
  assert.equal((await call('/api/lesson/Course/notes.pdf/yt', { headers: { cookie } })).status, 404);
});

test('comments show a stable handle, never the email local part', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const headers = { cookie, origin: ORIGIN, 'content-type': 'application/json' };
  const url = '/api/lesson/Course/notes.pdf/comments';

  const posted = await call(url, { method: 'POST', headers, body: JSON.stringify({ body: 'hello' }) });
  assert.equal(posted.status, 200);
  const { comment } = await posted.json();
  const me = await (await call('/api/me', { headers: { cookie } })).json();
  assert.equal(comment.name, me.name, 'the posted handle matches the one /api/me reports');
  assert.ok(comment.name && !comment.name.includes('@'), 'the handle is not an email');
  assert.ok(!comment.name.includes(email.split('@')[0]), 'the email local part is not shown');

  const list = await (await call(url, { headers: { cookie } })).json();
  assert.equal(list.comments[0].name, comment.name, 'the handle is stable across reads');
  assert.ok(!JSON.stringify(list).includes(email), 'the email never appears in the thread');

  const email2 = await addUser();
  await enroll(email2, 'Course');
  const two = await login(email2, { ip: '10.5.5.5' });
  const posted2 = await call(url, { method: 'POST', headers: { cookie: two.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hi' }) });
  assert.notEqual((await posted2.json()).comment.name, comment.name, 'different accounts get different handles');
});

test('sign out everywhere ends every session for the account', async () => {
  const email = await addUser();
  const { cookie } = await login(email);
  assert.equal((await call('/api/me', { headers: { cookie } })).status, 200);
  const out = await call('/api/logout/all', { method: 'POST', headers: { cookie, origin: ORIGIN } });
  assert.equal(out.status, 200);
  assert.equal((await call('/api/me', { headers: { cookie } })).status, 401, 'the old cookie is dead');
});

// ---- PDF note images: stored in R2, referenced from the notes JSON by URL ----

const assetId = (n) => n.toString(16).padStart(64, '0'); // the client sends a sha-256 hex id
const assetPath = (lesson, id) => '/api/note-asset/' + encodeURIComponent(lesson) + '/' + id;
const uploadAsset = (cookie, lesson, id, body, type = 'image/png') =>
  call(assetPath(lesson, id), { method: 'PUT', headers: { ...browser(cookie), 'content-type': type }, body });

test('note images are served back only to their owner, and the type/size are checked', async () => {
  const a = await addUser();
  await enroll(a, 'Course');
  const { cookie: ca } = await login(a);
  const b = await addUser();
  await enroll(b, 'Course');
  const { cookie: cb } = await login(b);

  const id = assetId(1);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const put = await uploadAsset(ca, 'Course/notes.pdf', id, png);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).url, assetPath('Course/notes.pdf', id));

  // The owner reads the exact bytes back with the stored type.
  const got = await call(assetPath('Course/notes.pdf', id), { headers: browser(ca) });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), png);

  // Another student's key prefix does not contain it.
  assert.equal((await call(assetPath('Course/notes.pdf', id), { headers: browser(cb) })).status, 404);

  // A non-image content type is refused, as is an oversized body.
  assert.equal((await uploadAsset(ca, 'Course/notes.pdf', assetId(2), png, 'text/html')).status, 415);
  assert.equal((await uploadAsset(ca, 'Course/notes.pdf', assetId(3), new Uint8Array(17 * 1024 * 1024))).status, 413);

  // A malformed id is a plain 400, not a 500.
  assert.equal((await uploadAsset(ca, 'Course/notes.pdf', 'not-a-hash', png)).status, 400);
});

test('a student cannot store an image for a course they are not in', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  assert.equal((await uploadAsset(cookie, 'Other/hidden.pdf', assetId(4), new Uint8Array([1]))).status, 403);
});

test('saving notes keeps only the images they reference; deleting notes removes them', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const lesson = 'Course/notes.pdf';
  const id1 = assetId(11);
  const id2 = assetId(12);
  assert.equal((await uploadAsset(cookie, lesson, id1, new Uint8Array([7]))).status, 200);
  assert.equal((await uploadAsset(cookie, lesson, id2, new Uint8Array([9]))).status, 200);

  const uid = raw.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  assert.equal(env.RESOURCES.has(`_notes/${uid}/${id1}`), true);

  // Save notes that reference only id1: id2 is pruned from R2 and D1.
  const notes = [{ annotationType: 13, pageIndex: 0, bitmapUrl: assetPath(lesson, id1) }];
  const save = await call('/api/notes/' + encodeURIComponent(lesson), {
    method: 'PUT', headers: { ...browser(cookie), 'content-type': 'application/json' }, body: JSON.stringify({ data: notes }),
  });
  assert.equal(save.status, 200);
  assert.deepEqual(raw.prepare('SELECT asset_id FROM note_assets WHERE user_id = ?').all(uid).map((r) => r.asset_id), [id1]);
  assert.equal(env.RESOURCES.has(`_notes/${uid}/${id2}`), false, 'the unreferenced image left R2');
  assert.equal((await call(assetPath(lesson, id1), { headers: browser(cookie) })).status, 200, 'the referenced image stays');

  // Deleting the notes takes the last image with it.
  assert.equal((await call('/api/notes/' + encodeURIComponent(lesson), { method: 'DELETE', headers: browser(cookie) })).status, 200);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM note_assets WHERE user_id = ?').get(uid).n, 0);
  assert.equal(env.RESOURCES.has(`_notes/${uid}/${id1}`), false);
});

test('the reserved _notes prefix never shows up as a course or a file folder', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  assert.equal((await uploadAsset(cookie, 'Course/notes.pdf', assetId(21), new Uint8Array([1]))).status, 200);

  invalidateCourse(); // rebuild the cached course tree now that _notes/... exists
  const courses = await (await call('/api/course', { headers: browser(cookie) })).json();
  assert.ok(!courses.some((c) => c.title === '_notes'), 'no _notes course appears');

  const admin = await addUser({ admin: true });
  const { cookie: ca } = await login(admin, { ip: '10.9.9.9' });
  const listing = await (await call('/api/admin/files?prefix=', { headers: browser(ca) })).json();
  assert.ok(!listing.dirs.some((d) => d.name === '_notes'), 'no _notes folder in the admin file list');
});

test('deleting a user removes their note images from R2', async () => {
  const admin = await addUser({ admin: true });
  const { cookie: ca } = await login(admin, { ip: '10.9.9.8' });
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const id = assetId(31);
  assert.equal((await uploadAsset(cookie, 'Course/notes.pdf', id, new Uint8Array([1]))).status, 200);
  const uid = raw.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  assert.equal(env.RESOURCES.has(`_notes/${uid}/${id}`), true);

  const del = await call('/api/admin/users/' + uid, { method: 'DELETE', headers: { cookie: ca, origin: ORIGIN } });
  assert.equal(del.status, 200);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM note_assets WHERE user_id = ?').get(uid).n, 0);
  assert.equal(env.RESOURCES.has(`_notes/${uid}/${id}`), false);
});

test('deleting a lesson removes the note images attached to it', async () => {
  const admin = await addUser({ admin: true });
  const { cookie: ca } = await login(admin, { ip: '10.9.9.7' });
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const id = assetId(41);
  assert.equal((await uploadAsset(cookie, 'Course/deleteme.pdf', id, new Uint8Array([1]))).status, 200);
  const uid = raw.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  assert.equal(env.RESOURCES.has(`_notes/${uid}/${id}`), true);

  const res = await call('/api/admin/files/delete', {
    method: 'POST', headers: { ...browser(ca), 'content-type': 'application/json' }, body: JSON.stringify({ path: 'Course/deleteme.pdf' }),
  });
  assert.equal(res.status, 200);
  assert.equal(env.RESOURCES.has(`_notes/${uid}/${id}`), false);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM note_assets WHERE lesson = ?').get('Course/deleteme.pdf').n, 0);
});
