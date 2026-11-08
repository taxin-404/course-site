// The Durable Object limiter is the shared counter for logins and the per-hour lesson cap.
// These tests drive the real class through the fake namespace from harness.mjs, so the SQL
// and the window arithmetic are exercised, not mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rate } from './harness.mjs';

const { RATE, raw } = rate();
const object = (name) => RATE.get(RATE.idFromName(name));
const call = async (name, path, body = {}) => {
  const res = await object(name).fetch('https://limiter.internal' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, path + ' answered ' + res.status);
  return res.json();
};

const LOCK_MS = 15 * 60e3;

test('login check, record and clear follow the 8-failure threshold', async () => {
  const name = 'login:a@example.com|1.2.3.4';
  for (let i = 0; i < 7; i++) await call(name, '/login/fail');
  assert.equal((await call(name, '/login/check', { max: 8 })).locked, false, 'seven failures are not locked');
  await call(name, '/login/fail');
  assert.equal((await call(name, '/login/check', { max: 8 })).locked, true, 'the eighth failure locks at 8');
  assert.equal((await call(name, '/login/check', { max: 9 })).locked, false, 'a higher threshold is still open');
  await call(name, '/login/clear');
  assert.equal((await call(name, '/login/check', { max: 8 })).locked, false, 'clear resets the counter');
});

test('a lockout ends after 15 minutes and the next failure starts a new window', async () => {
  const name = 'login:old@example.com|9.9.9.9';
  for (let i = 0; i < 8; i++) await call(name, '/login/fail');
  assert.equal((await call(name, '/login/check', { max: 8 })).locked, true);

  raw(name).prepare('UPDATE login SET t = ?').run(Date.now() - LOCK_MS - 1);
  assert.equal((await call(name, '/login/check', { max: 8 })).locked, false, 'the window has passed');

  await call(name, '/login/fail');
  const row = raw(name).prepare('SELECT n, t FROM login').get();
  assert.equal(row.n, 1, 'a failure after the window starts at one');
  assert.ok(Date.now() - row.t < 1000, 'and the window starts now');
});

test('lesson hits count distinct lessons for the current hour', async () => {
  const name = 'lessons:7';
  assert.equal((await call(name, '/lesson?hour=1000&lesson=A')).n, 1);
  assert.equal((await call(name, '/lesson?hour=1000&lesson=A')).n, 1, 'a repeat is not distinct');
  assert.equal((await call(name, '/lesson?hour=1000&lesson=B')).n, 2);
  assert.equal((await call(name, '/lesson?hour=1001&lesson=A')).n, 1, 'a new hour starts at zero');
});

test('lesson rows from more than one hour ago are cleaned on access', async () => {
  const name = 'lessons:8';
  await call(name, '/lesson?hour=2000&lesson=A');
  await call(name, '/lesson?hour=2001&lesson=B');
  await call(name, '/lesson?hour=2002&lesson=C');
  const old = raw(name).prepare('SELECT COUNT(*) c FROM hits WHERE hour = 2000').get();
  assert.equal(old.c, 0, 'hour 2000 was removed when hour 2002 was recorded');
  const kept = raw(name).prepare('SELECT COUNT(*) c FROM hits WHERE hour >= 2001').get();
  assert.equal(kept.c, 2, 'the previous and current hours stay');
});