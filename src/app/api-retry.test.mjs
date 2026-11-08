import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, retryDelayMs, DEFAULT_RETRY_MS, MAX_RETRY_MS } from './api-retry.ts';

const reply = (status, retryAfter) => new Response('{}', {
  status,
  headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
});

test('Retry-After is read in seconds, clamped to the max, and defaults to two seconds', () => {
  assert.equal(retryDelayMs(null), DEFAULT_RETRY_MS);
  assert.equal(retryDelayMs('1'), 1000);
  assert.equal(retryDelayMs('60'), MAX_RETRY_MS);
  assert.equal(retryDelayMs('0'), 0);
  assert.equal(retryDelayMs('not-a-date'), DEFAULT_RETRY_MS);
});

test('a GET 503 is retried exactly once after its Retry-After', async () => {
  let calls = 0;
  const waits = [];
  const res = await fetchWithRetry('GET', async () => {
    calls++;
    return calls === 1 ? reply(503, '1') : reply(200);
  }, async (ms) => { waits.push(ms); });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(res.status, 200);
});

test('a GET that keeps returning 503 stops after one retry', async () => {
  let calls = 0;
  const res = await fetchWithRetry('GET', async () => { calls++; return reply(503); }, async () => {});
  assert.equal(calls, 2);
  assert.equal(res.status, 503);
});

test('a POST 503 is not retried', async () => {
  let calls = 0;
  const res = await fetchWithRetry('POST', async () => { calls++; return reply(503); }, async () => {});
  assert.equal(calls, 1);
  assert.equal(res.status, 503);
});

test('a GET network failure is retried once', async () => {
  let calls = 0;
  const res = await fetchWithRetry('GET', async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return reply(200);
  }, async () => {});
  assert.equal(calls, 2);
  assert.equal(res.status, 200);
});

test('a GET that keeps failing surfaces after one retry', async () => {
  let calls = 0;
  await assert.rejects(fetchWithRetry('GET', async () => {
    calls++;
    throw new TypeError('fetch failed');
  }, async () => {}), /fetch failed/);
  assert.equal(calls, 2);
});

test('a POST network failure is not retried and still surfaces', async () => {
  let calls = 0;
  await assert.rejects(fetchWithRetry('POST', async () => {
    calls++;
    throw new TypeError('fetch failed');
  }, async () => {}), /fetch failed/);
  assert.equal(calls, 1);
});