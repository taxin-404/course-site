// Test-only stand-ins for the Cloudflare bindings the Worker expects: a D1 adapter over
// Node's built-in SQLite, a tiny in-memory R2, and a Durable Object namespace that runs the
// real RateLimiter class against an in-memory SQLite database. Imported by worker/*.test.mjs;
// never shipped.
import { DatabaseSync } from 'node:sqlite';
import { RateLimiter } from './index.js';

const enc = new TextEncoder();
const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Normalise whatever the Worker passes as `range`: a Headers instance (the raw
 * request headers used for non-video media), a `{ offset, length }` object, or a
 * `bytes=start-end` string. Returns null when there is no usable range.
 */
function readRange(range) {
  if (!range) return null;
  if (typeof range.get === 'function') {
    const header = range.get('range');
    return header ? readRange(header) : null;
  }
  if (typeof range === 'string') {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] === '' ? Infinity : Number(m[2]);
    return { offset: start, length: end - start + 1 };
  }
  if (typeof range.suffix === 'number') return { suffix: range.suffix };
  if (typeof range.offset === 'number') return { offset: range.offset, length: range.length ?? Infinity };
  return null;
}

/**
 * A fake R2 bucket. `files` maps an object key to a string (encoded as UTF-8) or raw bytes.
 * It implements the two methods the Worker uses: `list` (paged) and `get` (with ranges).
 */
export function r2(files = {}) {
  const toBytes = (v) => (typeof v === 'string' ? enc.encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v));
  const map = new Map();
  const meta = new Map();
  for (const [key, value] of Object.entries(files)) map.set(key, toBytes(value));
  return {
    async list({ prefix = '', delimiter, cursor, limit = 1000 } = {}) {
      const objects = [];
      const prefixes = new Set();
      for (const key of [...map.keys()].sort()) {
        if (!key.startsWith(prefix)) continue;
        if (delimiter) {
          const rest = key.slice(prefix.length);
          const at = rest.indexOf(delimiter);
          if (at >= 0) { prefixes.add(prefix + rest.slice(0, at + delimiter.length)); continue; }
        }
        objects.push({ key, size: map.get(key).length });
      }
      const start = cursor ? objects.findIndex((o) => o.key === cursor) + 1 : 0;
      const page = objects.slice(start, start + limit);
      return {
        objects: page,
        delimitedPrefixes: [...prefixes].sort(),
        truncated: start + limit < objects.length,
        cursor: page.at(-1)?.key,
      };
    },
    async get(key, { range } = {}) {
      if (!map.has(key)) return null;
      const bytes = map.get(key);
      const total = bytes.length;
      const spec = readRange(range);
      const httpMetadata = meta.get(key);
      if (!spec) return { body: bytes, size: total, httpMetadata };
      let offset = 0;
      let length = total;
      if (spec.suffix != null) {
        offset = Math.max(0, total - spec.suffix);
        length = total - offset;
      } else {
        offset = Math.min(spec.offset, total);
        length = Math.max(0, Math.min(spec.length, total - offset));
      }
      return { body: bytes.subarray(offset, offset + length), size: total, range: { offset, length }, httpMetadata };
    },
    async head(key) {
      if (!map.has(key)) return null;
      return { key, size: map.get(key).length, httpMetadata: meta.get(key) };
    },
    async put(key, value, opts = {}) {
      map.set(key, toBytes(value));
      if (opts.httpMetadata) meta.set(key, opts.httpMetadata);
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) { map.delete(k); meta.delete(k); }
    },
    // Test-only helper: the Worker never calls this, but tests assert an object really left.
    has: (key) => map.has(key),
  };
}

/** A D1-shaped adapter over a node:sqlite database: `prepare(sql).bind(...).run()/first()/all()`. */
export function d1(raw) {
  // Round-trip telemetry for tests: a batch is one round trip, however many statements it
  // carries. This lets a test assert that a hot path did not regress into N separate queries.
  const stats = {
    roundTrips: 0,
    batches: 0,
    batchedStatements: 0,
    reset() { this.roundTrips = 0; this.batches = 0; this.batchedStatements = 0; },
  };
  const exec = {
    run: (sql, args) => {
      const r = raw.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    first: (sql, args) => raw.prepare(sql).get(...args) ?? null,
    all: (sql, args) => ({ results: raw.prepare(sql).all(...args) }),
  };
  const make = (sql, args = []) => {
    const stmt = {
      run: async () => { stats.roundTrips++; return exec.run(sql, args); },
      first: async () => { stats.roundTrips++; return exec.first(sql, args); },
      all: async () => { stats.roundTrips++; return exec.all(sql, args); },
      bind: (...more) => make(sql, more),
    };
    // Called by batch(), which already counted this statement's shared round trip.
    Object.defineProperty(stmt, 'exec', {
      value: () => (/^\s*(select|with|pragma)\b/i.test(sql)
        ? { success: true, ...exec.all(sql, args) }
        : exec.run(sql, args)),
    });
    return stmt;
  };
  return {
    prepare: (sql) => make(sql),
    batch: async (stmts) => {
      stats.roundTrips++;
      stats.batches++;
      stats.batchedStatements += stmts.length;
      return stmts.map((s) => s.exec());
    },
    stats,
  };
}

/** A fresh in-memory database plus its D1 adapter. */
export function db() {
  const raw = new DatabaseSync(':memory:');
  return { raw, DB: d1(raw) };
}

/**
 * A fake Durable Object namespace for RateLimiter. Each id gets its own in-memory SQLite
 * database and one real RateLimiter instance, so tests exercise the object's SQL rather
 * than a mock of it. `stats.mode` can be set to 'throw' or 'hang' to model a failing or
 * stalled object; `raw(id)` gives a test the object's tables.
 */
export function rate() {
  const objects = new Map();
  const stats = {
    calls: 0,
    objects: 0,
    mode: 'ok',
    reset() { this.calls = 0; this.objects = 0; this.mode = 'ok'; },
  };
  const objectFor = (id) => {
    let obj = objects.get(id);
    if (!obj) {
      const raw = new DatabaseSync(':memory:');
      obj = { raw, alarmAt: null, limiter: null };
      const ctx = {
        storage: {
          sql: {
            exec(query, ...args) {
              const stmt = raw.prepare(query);
              if (/^\s*(select|with|pragma)\b/i.test(query)) {
                const rows = stmt.all(...args);
                return { toArray: () => rows, one: () => rows[0] };
              }
              stmt.run(...args);
              return { toArray: () => [], one: () => undefined };
            },
          },
          async getAlarm() { return obj.alarmAt; },
          async setAlarm(at) { obj.alarmAt = Number(at); },
          async deleteAlarm() { obj.alarmAt = null; },
          async deleteAll() {
            raw.exec('DROP TABLE IF EXISTS login');
            raw.exec('DROP TABLE IF EXISTS hits');
          },
        },
      };
      obj.limiter = new RateLimiter(ctx, {});
      objects.set(id, obj);
      stats.objects++;
    }
    return obj;
  };
  const RATE = {
    idFromName: (name) => name,
    get(id) {
      if (stats.mode === 'throw') return { fetch: async () => { throw new Error('limiter down'); } };
      if (stats.mode === 'hang') return { fetch: () => new Promise(() => {}) };
      const obj = objectFor(id);
      return {
        fetch(input, init) {
          stats.calls++;
          return obj.limiter.fetch(new Request(new URL(input, 'https://limiter.internal'), init));
        },
      };
    },
  };
  return {
    RATE, stats,
    raw: (id) => objects.get(id)?.raw,
    alarm: (id) => objectFor(id).limiter.alarm(),
    alarmAt: (id) => objects.get(id)?.alarmAt ?? null,
  };
}

/** PBKDF2 hash exactly as the Worker stores it (`salt.hash`, base64url), for seeding users. */
export async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return b64(salt) + '.' + b64(bits);
}
