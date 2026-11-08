import { handleFiles } from './files.js';
import { BANNER_TYPES, bannerKeys } from './banners.js';
import { lessonOf, hourBucket, publicLesson, pace } from './limits.js';
import { sessionKey, scramble } from './yt-cipher.mjs';
import { YOUTUBE_LESSONS } from './youtube.js';

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (d, status = 200, h = {}) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...h } });
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

async function hmac(secret, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
async function derive(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return b64(salt) + '.' + (await derive(pw, salt));
}
async function checkPw(pw, stored) {
  if (!stored.includes('.')) return false;
  const [s, h] = stored.split('.');
  return safeEq(h, await derive(pw, unb64(s)));
}
async function getUser(req, env) {
  const c = /(?:^|; )s=([^;]+)/.exec(req.headers.get('cookie') || '')?.[1];
  if (!c) return null;
  const [p, sig] = c.split('.');
  if (!sig || !safeEq(sig, await hmac(env.SESSION_SECRET, p))) return null;
  const d = JSON.parse(new TextDecoder().decode(unb64(p)));
  if (d.exp < Date.now()) return null;
  const u = await env.DB.prepare('SELECT id, email, is_admin, ver, sid FROM users WHERE id = ?').bind(d.uid).first();
  // 'ver' changes on password reset / role change, which signs the user out everywhere
  if (!u || (d.v || 0) !== u.ver) return null;
  // Students: the cookie must carry the account's current session id, so a newer
  // login (or a cookie from before this feature) is rejected. Admins are exempt.
  if (!u.is_admin && (!d.sid || d.sid !== u.sid)) return null;
  return u;
}
// 'Secure' is only sent over HTTPS: browsers reject a Secure cookie on a plain-HTTP
// origin (e.g. the dev server over http://192.168.0.101:4200), which made the login
// appear to do nothing on a phone while localhost — treated as trustworthy — worked.
async function sessionCookie(u, env, secure) {
  const p = b64(enc.encode(JSON.stringify({ uid: u.id, v: u.ver || 0, sid: u.sid || '', exp: Date.now() + 7 * 864e5 })));
  return `s=${p}.${await hmac(env.SESSION_SECRET, p)}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict; Path=/; Max-Age=604800`;
}
// A new login becomes the only live session for that account: a fresh random id
// replaces the stored one, so every cookie minted earlier fails getUser.
async function startSession(env, u, secure) {
  const sid = crypto.randomUUID();
  await env.DB.prepare('UPDATE users SET sid = ? WHERE id = ?').bind(sid, u.id).run();
  return sessionCookie({ ...u, sid }, env, secure);
}
function clearCookie(secure) {
  return `s=; HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict; Path=/; Max-Age=0`;
}
// Google sign-in nonce: the page asks /api/config for one, passes it to Google, and Google
// echoes it in the ID token. The same value rides in this HttpOnly, same-site cookie, so a
// token minted for another site (login CSRF) cannot be replayed here: the attacker cannot
// read the cookie to learn the nonce. The check itself is the pure, testable nonceOk().
const nonceOf = (req) => /(?:^|; )gn=([^;]+)/.exec(req.headers.get('cookie') || '')?.[1] || '';
export function nonceOk(claim, cookie) {
  return !!cookie && !!claim && safeEq(String(claim), cookie);
}
const nonceCookie = (nonce, secure) => `gn=${nonce}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict; Path=/; Max-Age=43200`;

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, sid TEXT)',
  'CREATE TABLE IF NOT EXISTS watched (user_id INTEGER NOT NULL, lesson TEXT NOT NULL, PRIMARY KEY (user_id, lesson))',
  'CREATE TABLE IF NOT EXISTS pdf_notes (user_id INTEGER NOT NULL, lesson TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, lesson))',
  // Images pasted into a PDF are far too big for a D1 row (2 MB hard cap), so only the bytes
  // go to R2, under a private `_notes/<user>/<sha256>` key; this table remembers which assets
  // a student's per-lesson notes reference, and their content type, so they can be served
  // back and swept when the notes, the lesson or the student go away.
  'CREATE TABLE IF NOT EXISTS note_assets (user_id INTEGER NOT NULL, lesson TEXT NOT NULL, asset_id TEXT NOT NULL, type TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (user_id, lesson, asset_id))',
  'CREATE INDEX IF NOT EXISTS idx_note_assets_lesson ON note_assets(lesson)',
  'CREATE INDEX IF NOT EXISTS idx_note_assets_user ON note_assets(user_id, asset_id)',
  'CREATE TABLE IF NOT EXISTS attempts (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)',
  // Distinct lessons a student opened in one hour bucket. In D1 so every Worker instance
  // shares the count; a row is written only when a lesson is new for that hour.
  'CREATE TABLE IF NOT EXISTS lesson_hits (user_id INTEGER NOT NULL, hour INTEGER NOT NULL, lesson TEXT NOT NULL, PRIMARY KEY (user_id, hour, lesson))',
  'CREATE INDEX IF NOT EXISTS idx_lesson_hits_hour ON lesson_hits(hour)',
  'CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson TEXT NOT NULL, user_id INTEGER NOT NULL, parent_id INTEGER, body TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_comments_lesson ON comments(lesson, created)',
  'CREATE TABLE IF NOT EXISTS comment_likes (comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (comment_id, user_id))',
  'CREATE TABLE IF NOT EXISTS video_notes (user_id INTEGER NOT NULL, lesson TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, lesson))',
  'CREATE TABLE IF NOT EXISTS resources (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, note TEXT, created_by INTEGER NOT NULL, created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_resources_lesson ON resources(lesson, created)',
  // Admin-chosen order for folders, files and YouTube lessons. A path without a row keeps
  // the default order (folders, then files, then YouTube; each by name). Positions are
  // per parent folder, so moving an item to another folder drops its old number.
  'CREATE TABLE IF NOT EXISTS content_order (path TEXT PRIMARY KEY, position INTEGER NOT NULL)',
  // Owner-written course descriptions, keyed by the top-level folder name (the course).
  "CREATE TABLE IF NOT EXISTS course_meta (course TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '')",
];
let ready;
// The owner comes from the Cloudflare secret ADMIN_EMAIL: the row is created on the first
// request if missing and always kept as an admin, so that email can sign in with Google
// (the Google callback links the account by matching the verified email).
// ADMIN_PASSWORD is optional but authoritative: when it is set the owner can also sign in
// with that password, when it is missing or changed the stored password follows the secret,
// and with no secret at all the row keeps the unusable-password marker so password login fails.
async function seedAdmin(env) {
  const email = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return;
  const password = env.ADMIN_PASSWORD ? String(env.ADMIN_PASSWORD) : '';
  const u = await env.DB.prepare('SELECT id, is_admin, pass FROM users WHERE email = ?').bind(email).first();
  if (!u) {
    await env.DB.prepare('INSERT INTO users (email, pass, is_admin) VALUES (?, ?, 1)').bind(email, password ? await hashPw(password) : await unusablePw()).run();
    return;
  }
  if (!u.is_admin) await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(u.id).run();
  if (password && (u.pass === '!' || !(await checkPw(password, u.pass)))) {
    await env.DB.prepare('UPDATE users SET pass = ? WHERE id = ?').bind(await hashPw(password), u.id).run();
  } else if (!password && u.pass !== '!') {
    await env.DB.prepare('UPDATE users SET pass = ? WHERE id = ?').bind(await unusablePw(), u.id).run();
  }
}
async function migrate(env) {
  // One round trip for every column check: five separate pragma reads cost five times the
  // D1 latency on a cold isolate, which is noticeable when the database is far away.
  const [usersCols, resCols] = await env.DB.batch([
    env.DB.prepare("SELECT name FROM pragma_table_info('users')"),
    env.DB.prepare("SELECT name FROM pragma_table_info('resources')"),
  ]);
  const userHas = new Set((usersCols.results || []).map((r) => r.name));
  const resHas = new Set((resCols.results || []).map((r) => r.name));
  if (!userHas.has('google_sub')) await env.DB.prepare('ALTER TABLE users ADD COLUMN google_sub TEXT').run();
  if (!userHas.has('ver')) await env.DB.prepare('ALTER TABLE users ADD COLUMN ver INTEGER NOT NULL DEFAULT 0').run();
  if (!userHas.has('sid')) await env.DB.prepare('ALTER TABLE users ADD COLUMN sid TEXT').run();
  if (!resHas.has('kind')) await env.DB.prepare("ALTER TABLE resources ADD COLUMN kind TEXT NOT NULL DEFAULT 'link'").run();
  if (!resHas.has('file_key')) await env.DB.prepare('ALTER TABLE resources ADD COLUMN file_key TEXT').run();
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub)').run();
  // YouTube lessons are managed from the Admin panel. Created here (before listCourse runs
  // below) and seeded once from worker/youtube.js, so the hadYt guard makes a later delete
  // permanent: a removed seed never comes back.
  const hadYt = await env.DB.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = 'youtube_lessons'").first();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS youtube_lessons (id TEXT PRIMARY KEY, yt TEXT NOT NULL, created INTEGER NOT NULL)').run();
  if (!hadYt.c) {
    for (const [rawPath, link] of Object.entries(YOUTUBE_LESSONS)) {
      const parts = String(rawPath).split('/').map((s) => s.trim()).filter(Boolean);
      const yt = ytId(link);
      if (parts.length < 2 || !yt) continue;
      await env.DB.prepare('INSERT OR IGNORE INTO youtube_lessons (id, yt, created) VALUES (?, ?, ?)').bind(parts.join('/'), yt, Date.now()).run();
    }
  }
  const had = await env.DB.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = 'enrollments'").first();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS enrollments (user_id INTEGER NOT NULL, course TEXT NOT NULL, PRIMARY KEY (user_id, course))').run();
  if (!had.c) { // first deploy only: today's students keep access to every current course
    const courses = (await listCourse(env)).map((c) => c.title);
    const users = (await env.DB.prepare('SELECT id FROM users').all()).results;
    const st = users.flatMap((x) => courses.map((c) => env.DB.prepare('INSERT OR IGNORE INTO enrollments (user_id, course) VALUES (?, ?)').bind(x.id, c)));
    for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  }
}
const SCHEMA_DEADLINE_MS = 8000;
// A D1 binding call has no timeout of its own, so one stalled call used to leave this
// promise pending forever. Because it is cached, every later request in the same isolate
// awaited the dead promise and hung too — a single stall took the Worker down until the
// next deploy. Race it against a deadline so the request fails fast and the cache resets.
function withDeadline(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('Database temporarily unavailable');
      e.dbTimeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The schema gate has its own deadline (above), but every later query in a request is a
// fresh D1 call with no timeout of its own: a single stalled one hung the request — and a
// client that never times out — forever. This wrapper races every query against the same
// deadline, so a stall answers 503 instead of pinning the connection. It is transparent:
// `prepare().bind(...).first()/all()/run()/raw()` resolve to the real value, and `batch`
// gets the original statement objects back so workerd's own binding checks still pass.
const DB_DEADLINE_MS = 8000;
const RAW_STMT = Symbol('rawStatement');
const QUERY_TERMINALS = new Set(['first', 'all', 'run', 'raw']);

function guardStatement(stmt, ms) {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      if (prop === RAW_STMT) return target;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'bind') return (...args) => guardStatement(value.apply(target, args), ms);
      if (QUERY_TERMINALS.has(prop)) return (...args) => withDeadline(value.apply(target, args), ms);
      return value.bind(target);
    },
  });
}

const guardedDbCache = new WeakMap();
export function guardDb(DB, ms = DB_DEADLINE_MS) {
  if (!DB || typeof DB.prepare !== 'function') return DB;
  let guarded = guardedDbCache.get(DB);
  if (!guarded) {
    const target = DB;
    guarded = new Proxy(target, {
      get(db, prop, receiver) {
        if (prop === 'prepare') return (query) => guardStatement(target.prepare(query), ms);
        // Unwrap the guarded statements so the real binding gets real D1PreparedStatements.
        if (prop === 'batch') return (stmts) => withDeadline(target.batch(stmts.map((s) => (s && s[RAW_STMT]) || s)), ms);
        if (prop === 'exec') return (query) => withDeadline(target.exec(query), ms);
        const value = Reflect.get(db, prop, receiver);
        return typeof value === 'function' ? value.bind(db) : value;
      },
    });
    guardedDbCache.set(DB, guarded);
  }
  return guarded;
}

/** Route a request's env through the per-query deadline so no D1 call can hang it. */
export function guardEnv(env) {
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === 'DB') return guardDb(target.DB);
      return Reflect.get(target, prop, receiver);
    },
  });
}
export function ensureSchema(env, deadlineMs = SCHEMA_DEADLINE_MS) {
  if (!ready) {
    const run = withDeadline(
      env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).then(() => migrate(env)).then(() => seedAdmin(env)),
      deadlineMs,
    );
    // The abandoned promise cannot be cancelled; dropping it from the cache is what
    // matters, so the next request retries cleanly (the schema statements are idempotent).
    const guarded = run.catch((e) => {
      if (ready === guarded) ready = undefined;
      throw e;
    });
    ready = guarded;
  }
  return ready;
}

// ---- Google sign-in: verify the ID token (RS256 JWT) against Google's public keys ----
let jwks = { at: 0, keys: [] };
async function googleKeys(force) {
  if (!force && jwks.keys.length && Date.now() - jwks.at < 36e5) return jwks.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('jwks');
  jwks = { at: Date.now(), keys: (await r.json()).keys || [] };
  return jwks.keys;
}
const jpart = (s) => JSON.parse(new TextDecoder().decode(unb64(s)));
async function verifyGoogle(token, env) {
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  const head = jpart(h);
  if (head.alg !== 'RS256') return null;
  let jwk = (await googleKeys()).find((k) => k.kid === head.kid) || (await googleKeys(true)).find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64(sig), enc.encode(h + '.' + p)))) return null;
  const c = jpart(p);
  const okIss = c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com';
  if (!okIss || c.aud !== env.GOOGLE_CLIENT_ID || !(c.exp * 1000 > Date.now())) return null;
  if (!(c.email_verified === true || c.email_verified === 'true') || !c.email || !c.sub) return null;
  return c;
}
// Google-only users get a marker that never matches any password (no costly hashing needed).
const unusablePw = async () => '!';
const isOwner = (env, email) => !!env.ADMIN_EMAIL && email === String(env.ADMIN_EMAIL).trim().toLowerCase();
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const validPw = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;
// Comments show a stable, non-identifying handle rather than the account's email: on a small
// course the local part of an address is easy to guess from, so it must not appear in a public
// thread. The handle is derived from the account id, so it is the same everywhere and never
// changes, but carries no personal information.
const HANDLE_ADJ = ['Bright', 'Calm', 'Cheerful', 'Clever', 'Curious', 'Eager', 'Gentle', 'Happy', 'Kind', 'Lively', 'Merry', 'Noble', 'Patient', 'Quick', 'Quiet', 'Sharp', 'Steady', 'Sunny', 'Swift', 'Warm', 'Wise', 'Brave', 'Bold', 'Cosmic', 'Daring', 'Honest', 'Humble', 'Jolly', 'Keen', 'Lucky', 'Mellow', 'Neat', 'Polite', 'Proud', 'Vivid'];
const HANDLE_ANIMAL = ['Badger', 'Bear', 'Beaver', 'Bison', 'Bobcat', 'Cheetah', 'Crane', 'Deer', 'Dolphin', 'Eagle', 'Falcon', 'Finch', 'Fox', 'Gecko', 'Goose', 'Heron', 'Ibis', 'Jaguar', 'Koala', 'Lemur', 'Lynx', 'Marten', 'Moose', 'Newt', 'Otter', 'Owl', 'Panda', 'Parrot', 'Puma', 'Raven', 'Robin', 'Salmon', 'Seal', 'Sparrow', 'Stork', 'Swan', 'Tiger', 'Turtle', 'Wolf', 'Wren', 'Yak', 'Zebra'];
function displayName(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h >>>= 0;
  return HANDLE_ADJ[h % HANDLE_ADJ.length] + ' ' + HANDLE_ANIMAL[(h >>> 8) % HANDLE_ANIMAL.length];
}

// Bucket structure:
//   <Course>/<file>                  → course with a flat lesson
//   <Course>/<Section>/<file>        → course with a section containing a lesson
//   <Course>/<Section>/<Sub>/...     → deeper sub-folders treated as nested sections
const VIDEO_EXT = /\.(mp4|webm|mkv|mov|avi|m4v|m3u8)$/i;
const MEDIA_TYPES = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', vtt: 'text/vtt', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo', m4v: 'video/mp4' };
let cache = { at: 0, data: null };
// Called after any admin file change so the site reflects it immediately instead of
// waiting out the 60 s window below.
export function invalidateCourse() { cache = { at: 0, data: null }; }
const NUM = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// YouTube lessons (worker/youtube.js) need no upload: a path plus any YouTube link
// (watch, youtu.be, embed, shorts, live) or a bare video id. Returns the video id.
function ytId(link) {
  const s = String(link || '').trim();
  if (!s) return null;
  const m = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{6,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{6,}$/.test(s) ? s : null;
}
async function listCourse(env) {
  if (cache.data && Date.now() - cache.at < 60000) return cache.data;
  const keys = []; let cursor;
  do {
    const r = await env.RESOURCES.list({ cursor, limit: 1000 });
    keys.push(...r.objects.map((o) => o.key)); cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);

  const banners = bannerKeys(keys);

  // Sidecar subtitles: <Lesson>/index.<lang>[.<n>].vtt belongs to that folder's HLS lesson.
  const subtitleMap = new Map();
  for (const key of keys) {
    const m = /^(.+)\/index\.([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.\d+)?\.vtt$/.exec(key);
    if (!m) continue;
    if (!subtitleMap.has(m[1])) subtitleMap.set(m[1], []);
    subtitleMap.get(m[1]).push({ key, lang: m[2] });
  }

  // courses: Map<courseName, Map<sectionName, lesson[]>>
  // files directly under course root go into section '' (no section)
  const courses = new Map();
  for (const key of keys) {
    if (key === '_notes' || key.startsWith('_notes/')) continue; // reserved: private note images
    // A course is a top-level folder. Register it for any nested key, so a folder that
    // holds only its `.keep` placeholder (a brand-new, empty course) is listed too.
    const slash = key.indexOf('/');
    if (slash > 0) {
      const top = key.slice(0, slash);
      if (!courses.has(top)) courses.set(top, new Map());
    }
    if (/\.ts$/i.test(key)) continue; // skip HLS segments
    if (key.split('/').includes('_resources')) continue; // resource PDFs are not lessons
    const pdf = /\.pdf$/i.test(key), video = VIDEO_EXT.test(key);
    if (!pdf && !video) continue;
    const parts = key.split('/');
    if (parts.length < 2) continue; // skip root-level files with no course folder
    const courseName = parts[0];
    const file = parts[parts.length - 1];
    // section = everything between course and filename joined, or '' if file is directly in course
    const sectionName = parts.slice(1, -1).join(' / ');
    // For HLS: index.m3u8 title comes from its immediate parent folder
    const title = (file === 'index.m3u8') ? (parts[parts.length - 2] || file) : file.replace(/\.[^.]+$/, '');
    if (!courses.has(courseName)) courses.set(courseName, new Map());
    const secs = courses.get(courseName);
    if (!secs.has(sectionName)) secs.set(sectionName, []);
    const lesson = { id: key, title, kind: pdf ? 'pdf' : 'video' };
    if (file === 'index.m3u8') {
      const subs = subtitleMap.get(key.slice(0, key.lastIndexOf('/')));
      if (subs) lesson.subtitles = subs.sort((a, b) => NUM.compare(a.lang, b.lang) || NUM.compare(a.key, b.key));
    }
    secs.get(sectionName).push(lesson);
  }

  // Three independent metadata reads share one D1 round trip. A full course build happens
  // once per cold Worker instance, so collapsing these calls matters more than it looks.
  const [ytRows, posRows, descRows] = await env.DB.batch([
    env.DB.prepare('SELECT id, yt FROM youtube_lessons'),
    env.DB.prepare('SELECT path, position FROM content_order'),
    env.DB.prepare('SELECT course, description FROM course_meta'),
  ]);
  // YouTube lessons managed from the Admin panel (D1). The id is a path like an R2
  // key (<Course>/<Folder>/<Name>); the first segment is the course.
  for (const row of ytRows.results) {
    const parts = String(row.id).split('/').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2 || !row.yt) continue;
    const id = parts.join('/');
    const courseName = parts[0];
    if (!courses.has(courseName)) courses.set(courseName, new Map());
    const secs = courses.get(courseName);
    if ([...secs.values()].some((list) => list.some((l) => l.id === id))) continue; // a real file wins a clash
    const sectionName = parts.slice(1, -1).join(' / ');
    if (!secs.has(sectionName)) secs.set(sectionName, []);
    secs.get(sectionName).push({ id, title: parts[parts.length - 1], kind: 'youtube', yt: row.yt });
  }

  const positions = new Map(
    posRows.results
      .map((r) => [String(r.path), Number(r.position)]),
  );
  const descriptions = new Map(
    descRows.results
      .map((r) => [String(r.course), String(r.description ?? '')]),
  );
  // Numbered items come first, in their saved order; unnumbered ones keep the default
  // order (folders before files at the same level, then by name).
  const ordered = (aPath, aName, bPath, bName) => {
    const pa = positions.get(aPath);
    const pb = positions.get(bPath);
    if (pa != null && pb != null) return pa - pb || NUM.compare(aName, bName);
    if (pa != null) return -1;
    if (pb != null) return 1;
    return NUM.compare(aName, bName);
  };
  const sectionPath = (courseName, sectionName) =>
    sectionName ? `${courseName}/${sectionName.split(' / ').join('/')}` : courseName;

  const data = [...courses].sort((a, b) => ordered(a[0], a[0], b[0], b[0])).map(([courseName, secs]) => {
    const sections = [...secs]
      .sort((a, b) => ordered(sectionPath(courseName, a[0]), a[0], sectionPath(courseName, b[0]), b[0]))
      .map(([sectionName, lessons]) => ({
        title: sectionName || null,
        lessons: lessons.sort((a, b) => ordered(a.id, a.title, b.id, b.title)),
      }));
    return { title: courseName, description: descriptions.get(courseName) || '', banner: banners.get(courseName) || '', sections };
  });
  cache = { at: Date.now(), data };
  return data;
}

// ---- Course access: a student only gets the courses an admin gave them (admins get all) ----
const courseOf = (key) => String(key).split('/')[0];
// Lesson-scoped features (comments, notes, resources) all ask the same question: does this
// key exist in the bucket, and may this user see the course it belongs to?
async function lessonAccess(env, u, key) {
  if (!key || key.length > 500) return 'missing';
  const course = (await listCourse(env)).find((c) => c.title === courseOf(key));
  if (!course || !course.sections.some((s) => s.lessons.some((l) => l.id === key))) return 'missing';
  if (u.is_admin) return 'ok';
  const mine = await myCourses(env, u);
  return mine && mine.has(courseOf(key)) ? 'ok' : 'denied';
}
const accessError = (access) => access === 'missing' ? json({ error: 'Not found' }, 404) : json({ error: 'Not allowed' }, 403);
async function myCourses(env, u) {
  if (u.is_admin) return null; // null = everything
  return new Set((await env.DB.prepare('SELECT course FROM enrollments WHERE user_id = ?').bind(u.id).all()).results.map((r) => r.course));
}
async function grant(env, emails, courses) {
  const cs = (Array.isArray(courses) ? courses : []).slice(0, 100).map(String);
  const st = emails.flatMap((e) => cs.map((c) => env.DB.prepare('INSERT OR IGNORE INTO enrollments (user_id, course) SELECT id, ? FROM users WHERE email = ?').bind(c, e)));
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
}

// ---- Login throttling (stored in D1, so it works across all Worker instances) ----
const LOCK_MS = 15 * 60e3;
const ipOf = (req) => req.headers.get('cf-connecting-ip') || 'unknown';
async function locked(env, keys) {
  for (const [k, max] of keys) {
    const r = await env.DB.prepare('SELECT n, t FROM attempts WHERE k = ?').bind(k).first();
    if (r && Date.now() - r.t < LOCK_MS && r.n >= max) return true;
  }
  return false;
}
async function noteFail(env, keys) {
  const now = Date.now();
  await env.DB.batch([
    ...keys.map(([k]) => env.DB.prepare('INSERT INTO attempts (k, n, t) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ? - t > ? THEN 1 ELSE n + 1 END, t = CASE WHEN ? - t > ? THEN ? ELSE t END').bind(k, now, now, LOCK_MS, now, LOCK_MS, now)),
    env.DB.prepare('DELETE FROM attempts WHERE t < ?').bind(now - LOCK_MS * 4),
  ]);
}
const tooMany = () => json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);

// ---- Media protection ----
// 1) Browsers tell us who is asking via Sec-Fetch-* headers. Downloaders (curl, wget, yt-dlp, most download
//    managers) do not send them, and other websites cannot make a browser send "same-origin".
function mediaRequestOk(req, env) {
  const site = req.headers.get('sec-fetch-site');
  const dest = req.headers.get('sec-fetch-dest');
  if (['document', 'iframe', 'frame', 'embed', 'object'].includes(dest) || req.headers.get('sec-fetch-mode') === 'navigate') return false;
  if (env.RELAX_FETCH_METADATA) return true; // escape hatch for old browsers
  return site === 'same-origin' && ['video', 'audio', 'empty', 'track'].includes(dest);
}
// 2) Scraping a whole course touches many lessons quickly. Cap distinct lessons per user
//    per hour in D1, so the count is shared by every Worker instance. (The old in-memory
//    Map lived in one isolate, so a scrape spread across isolates could dodge it.)
const lessonLimit = (env) => Number(env.MAX_LESSONS_PER_HOUR || 20);
// A plain media request — and every HLS segment is one — must not cost a D1 write and read
// each time. Within one Worker instance, remember which (user, hour, lesson) hits we already
// recorded and the count we last read, so a segment burst collapses to near-zero D1 traffic.
// Both memos are advisory: D1 stays the source of truth across instances, so the cap can be
// lax by at most COUNT_TTL_MS on another instance, never bypassed for long.
const hitMemo = new Set();
const countMemo = new Map();
const COUNT_TTL = 3000;
async function scraping(env, u, key) {
  if (u.is_admin) return false;
  const hour = hourBucket(Date.now());
  const lesson = lessonOf(key);
  const hitKey = `${u.id}|${hour}|${lesson}`;
  const countKey = `${u.id}|${hour}`;
  if (!hitMemo.has(hitKey)) {
    // INSERT OR IGNORE only writes a row when this lesson is new for the hour. Skipping the
    // statement when this instance already recorded it removes one D1 write per HLS segment.
    await env.DB.prepare('INSERT OR IGNORE INTO lesson_hits (user_id, hour, lesson) VALUES (?, ?, ?)').bind(u.id, hour, lesson).run();
    if (hitMemo.size > 5000) hitMemo.clear();
    hitMemo.add(hitKey);
    countMemo.delete(countKey); // a new distinct lesson may have moved the count
  }
  let seen = countMemo.get(countKey);
  if (!seen || Date.now() - seen.at > COUNT_TTL) {
    const row = await env.DB.prepare('SELECT COUNT(*) c FROM lesson_hits WHERE user_id = ? AND hour = ?').bind(u.id, hour).first();
    seen = { n: Number(row && row.c), at: Date.now() };
    if (countMemo.size > 2000) countMemo.clear();
    countMemo.set(countKey, seen);
    // Dead hour buckets are removed opportunistically (about one request in fifty) so no
    // scheduled job is needed and the table stays small on the free plan.
    if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM lesson_hits WHERE hour < ?').bind(hour - 1).run();
  }
  return seen.n > lessonLimit(env);
}

// 3) Slow-down: video must be requested in ranges (browsers always do; a plain "download this URL" gets refused),
//    each answer is at most CHUNK bytes, and each student's total media speed is capped near normal playback
//    speed. Fast requests are delayed instead of rejected, so playback stays smooth but bulk downloading is slow.
const CHUNK = 4 * 1024 * 1024;
const VIDEO_FILE = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;
const buckets = new Map();
// Only a single, well-formed byte range is served: "bytes=start-end" (end optional)
// with end >= start. Anything else — a suffix "-N", a multi-range, junk — is refused
// with 416 instead of being handed to R2, which would ignore it and return the whole
// object, dodging both the chunk cap and the speed limiter. start may be large; when
// it (or the end) is not a finite number the range is refused rather than mis-computed.
function videoRange(header) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? Infinity : Number(m[2]);
  if (!Number.isFinite(start) || Number.isNaN(end) || end < start) return null;
  return { offset: start, length: Math.min(end - start + 1, CHUNK) };
}
function reserve(env, u, bytes) {
  if (u.is_admin) return 0;
  const rate = Number(env.MAX_MBPS || 12) * 125000; // bytes per second
  const burst = rate * 20; // lets the player fill its buffer and seek
  const now = Date.now();
  let b = buckets.get(u.id);
  if (!b) { if (buckets.size > 2000) buckets.clear(); b = { tokens: burst, t: now }; buckets.set(u.id, b); }
  b.tokens = Math.min(burst, b.tokens + ((now - b.t) / 1000) * rate);
  b.t = now;
  b.tokens -= bytes;
  if (b.tokens >= 0) return 0;
  const wait = (-b.tokens / rate) * 1000;
  if (wait > 25000) { b.tokens += bytes; return null; }
  return wait;
}

// A video request is at most CHUNK bytes and the player makes many, so delaying each request
// caps the total. A PDF cannot use that trick: PDF.js opens every PDF with one plain GET (it
// only switches to byte ranges for files larger than twice its chunk size, and its first
// request — and a downloader's — both carry no Range at all), so refusing or chunk-capping the
// request would break the viewer. Instead the body is paced: each student has a token bucket
// and a single response pays for its bytes in wall-clock time. `MAX_PDF_MBPS` tunes it
// (default: the video cap).
const pdfBuckets = new Map();
function paceBody(env, u, body) {
  if (!body || u.is_admin) return body;
  const rate = Math.max(1, Number(env.MAX_PDF_MBPS ?? env.MAX_MBPS ?? 12) * 125000); // bytes/sec
  const burst = rate * 5; // about five seconds of bytes flow at once, so first pages still paint
  let s = pdfBuckets.get(u.id);
  if (!s) { if (pdfBuckets.size > 2000) pdfBuckets.clear(); s = { tokens: burst, at: Date.now() }; pdfBuckets.set(u.id, s); }
  const source = typeof body.getReader === 'function' ? body : new ReadableStream({ start(c) { c.enqueue(body); c.close(); } });
  const reader = source.getReader();
  const SLICE = 256 * 1024; // pace in small pieces, so a big R2 chunk is not stuck behind one long wait
  let pending = null;
  let offset = 0;
  return new ReadableStream({
    async pull(c) {
      if (!pending) {
        const { done, value } = await reader.read();
        if (done) return void c.close();
        if (!value.byteLength) return; // an empty chunk; the next pull reads again
        pending = value;
        offset = 0;
      }
      const size = Math.min(SLICE, pending.byteLength - offset);
      const bytes = pending.subarray(offset, offset + size);
      offset += size;
      if (offset >= pending.byteLength) pending = null;
      const now = Date.now();
      const step = pace(s.tokens, { rate, burst, bytes: size, elapsedMs: now - s.at });
      s.tokens = step.tokens;
      s.at = now + step.waitMs;
      if (step.waitMs > 0) await new Promise((r) => setTimeout(r, step.waitMs));
      c.enqueue(bytes);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

// ---- PDF note images (stored in R2, referenced from the notes JSON by URL) ----
const NOTE_ASSET_MAX = 16 * 1024 * 1024; // one image; above this the browser must not inline it
const NOTE_ASSETS_PER_USER = 500; // a generous ceiling so one account cannot fill the bucket
// Exactly the image types PDF.js accepts for a stamp; anything else is refused.
const NOTE_ASSET_TYPES = new Set(['image/apng', 'image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp', 'image/x-icon']);
const ASSET_ID_RE = /^[a-f0-9]{64}$/; // sha-256 hex, computed by the browser
const noteAssetKey = (userId, assetId) => `_notes/${userId}/${assetId}`;
const noteAssetUrl = (lesson, assetId) => `/api/note-asset/${encodeURIComponent(lesson)}/${assetId}`;

/** The asset ids a notes payload references, read from each note's bitmapUrl. */
function referencedAssetIds(notes) {
  const ids = new Set();
  for (const note of notes) {
    const url = note && typeof note === 'object' ? note.bitmapUrl : null;
    if (typeof url !== 'string') continue;
    const last = url.split('?')[0].split('#')[0].split('/').pop() || '';
    if (ASSET_ID_RE.test(last)) ids.add(last);
  }
  return ids;
}

/**
 * Delete note_assets rows for (user, lesson) that `keep` does not name, then remove the R2
 * object of each dropped asset that no other lesson of that user still needs. With no keep,
 * every asset for that lesson is dropped (notes deleted, or the lesson deleted).
 */
async function pruneNoteAssets(env, userId, lesson, keep = new Set()) {
  const rows = (await env.DB.prepare('SELECT asset_id FROM note_assets WHERE user_id = ? AND lesson = ?').bind(userId, lesson).all()).results || [];
  const drop = rows.map((r) => String(r.asset_id)).filter((id) => !keep.has(id));
  if (!drop.length) return;
  await env.DB.batch(drop.map((id) => env.DB.prepare('DELETE FROM note_assets WHERE user_id = ? AND lesson = ? AND asset_id = ?').bind(userId, lesson, id)));
  const keys = [];
  for (const id of drop) {
    const still = await env.DB.prepare('SELECT 1 x FROM note_assets WHERE user_id = ? AND asset_id = ? LIMIT 1').bind(userId, id).first();
    if (!still) keys.push(noteAssetKey(userId, id));
  }
  if (keys.length) await env.RESOURCES.delete([...new Set(keys)]);
}

/** Remove every R2 object under a prefix (a deleted user's `_notes/<id>/` folder). */
async function sweepPrefix(env, prefix) {
  let cursor;
  do {
    const r = await env.RESOURCES.list({ prefix, cursor, limit: 1000 });
    const keys = (r.objects || []).map((o) => o.key);
    if (keys.length) await env.RESOURCES.delete(keys);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
}

async function serve(req, env, key, u) {
  const isPdf = /\.pdf$/i.test(key);
  const ok = /\.(m3u8|ts|pdf|mp4|webm|mkv|mov|avi|m4v|vtt)$/i.test(key);
  if (!ok || !mediaRequestOk(req, env)) return json({ error: 'Not allowed' }, 403);
  if (await scraping(env, u, key)) return json({ error: 'Too many lessons opened. Please slow down.' }, 429);
  const isVideo = VIDEO_FILE.test(key);
  let range = req.headers;
  if (isVideo) {
    if (!req.headers.has('range')) return json({ error: 'Not allowed' }, 403);
    const spec = videoRange(req.headers.get('range'));
    if (!spec) return json({ error: 'Range not satisfiable' }, 416);
    range = spec;
  }
  const obj = await env.RESOURCES.get(key, { range });
  if (!obj) return json({ error: 'File not found' }, 404);
  const h = new Headers();
  h.set('content-type', MEDIA_TYPES[key.split('.').pop().toLowerCase()] || 'application/octet-stream');
  h.set('accept-ranges', 'bytes');
  // Nothing from the media route is cacheable: a browser that keeps the bytes keeps a copy
  // the site cannot account for. PDF.js still streams range requests, so it stays quick.
  h.set('cache-control', 'private, no-store');
  h.set('x-content-type-options', 'nosniff');
  h.set('content-disposition', 'inline');
  h.set('cross-origin-resource-policy', 'same-origin');
  h.set('x-robots-tag', 'noindex');
  let status = 200;
  if (obj.range && req.headers.has('range')) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    h.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set('content-length', String(length));
    status = 206;
  } else h.set('content-length', String(obj.size));
  // Videos (and other media) are throttled by delaying each range request. PDFs skip that
  // (a whole file would 429 at the request cap) and are paced by the body instead.
  if (!isPdf) {
    const wait = reserve(env, u, Number(h.get('content-length')) || 0);
    if (wait === null) return json({ error: 'Too fast. Please slow down.' }, 429, { 'retry-after': '30' });
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return new Response(isPdf ? paceBody(env, u, obj.body) : obj.body, { status, headers: h });
}

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export default {
  async fetch(req, env) {
    // Fail closed when the session secret is missing or too short: without a strong secret
    // the signed session cookie cannot be trusted. The reply is generic and never names the
    // variable or its value.
    if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) {
      return json({ error: 'Server error' }, 500);
    }
    const url = new URL(req.url);
    // CSRF defense in depth: state-changing API calls must come from this site
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.get('origin');
      const site = req.headers.get('sec-fetch-site');
      if ((origin && new URL(origin).host !== url.host) || (!origin && site && site !== 'same-origin' && site !== 'none')) {
        return json({ error: 'Forbidden' }, 403);
      }
    }
    const res = await handle(req, guardEnv(env));
    for (const [k, v] of Object.entries(SEC_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
    if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'no-store');
    return res;
  },
};

const handle = async (req, env) => {
  {
    const { pathname: path, protocol } = new URL(req.url);
    const secure = protocol === 'https:';
    const m = req.method;
    // Sign-in config only mints a nonce and reads an env var, so keep it off the database
    // path: the login screen (and the Google button) still render when D1 is unavailable.
    if (path === '/api/config') {
      // Reuse the nonce this browser already holds. Rotating it on every call breaks a page
      // that is mid sign-in (a second tab, or a form left open past the 12h cookie life),
      // because the callback would echo a nonce the cookie no longer matches. The value is
      // still unguessable and HttpOnly, so replay stays bound to this browser.
      const existing = nonceOf(req);
      const nonce = /^[A-Za-z0-9_-]{16,}$/.test(existing) ? existing : b64(crypto.getRandomValues(new Uint8Array(16)));
      return json({ googleClientId: env.GOOGLE_CLIENT_ID || '', nonce }, 200, { 'set-cookie': nonceCookie(nonce, secure) });
    }
    try {
      await ensureSchema(env);
      if (path === '/api/login/google' && m === 'POST') {
        if (!env.GOOGLE_CLIENT_ID) return json({ error: 'Google sign-in is not set up' }, 503);
        const ip = ['i:' + ipOf(req), 40];
        if (await locked(env, [ip])) return tooMany();
        const { credential } = await req.json();
        const c = await verifyGoogle(String(credential || ''), env).catch(() => null);
        if (!c) { await noteFail(env, [ip]); return json({ error: 'Google sign-in failed' }, 401); }
        // The token must carry the nonce this browser was issued, or it was minted elsewhere.
        if (!nonceOk(c.nonce, nonceOf(req))) { await noteFail(env, [ip]); return json({ error: 'Google sign-in failed' }, 401); }
        let u = await env.DB.prepare('SELECT id, email, google_sub, ver FROM users WHERE google_sub = ?').bind(c.sub).first();
        if (!u) {
          u = await env.DB.prepare('SELECT id, email, google_sub, ver FROM users WHERE email = ?').bind(c.email.toLowerCase()).first();
          if (!u) return json({ error: 'This Google account has not been invited' }, 403);
          if (u.google_sub && u.google_sub !== c.sub) return json({ error: 'This email is linked to a different Google account' }, 403);
          await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(c.sub, u.id).run();
        }
        return json({ ok: true }, 200, { 'set-cookie': await startSession(env, u, secure) });
      }
      if (path === '/api/login' && m === 'POST') {
        const { email, password } = await req.json();
        const em = String(email || '').trim().toLowerCase();
        // Three counters: a tight one per email+IP (a single machine guessing one account), a
        // looser per-IP one (one machine guessing many accounts), and a per-email one so a
        // guess spread across many IPs still slows down. The per-email cap is high enough that
        // only a real attack reaches it, and it expires with the same 15-minute window.
        const keys = [['ei:' + em + '|' + ipOf(req), 8], ['i:' + ipOf(req), 40], ['e:' + em, 30]];
        if (await locked(env, keys)) return tooMany();
        const pass = String(password || '');
        const u = await env.DB.prepare('SELECT id, pass, ver FROM users WHERE email = ?').bind(em).first();
        // Spend one PBKDF2 derive even when the email is unknown, and when the account has no
        // usable password (Google-only sign-in), so the response time does not reveal which
        // emails exist. The error message stays identical in every case.
        let ok = false;
        if (u && u.pass.includes('.')) ok = await checkPw(pass, u.pass);
        else await derive(pass, crypto.getRandomValues(new Uint8Array(16)));
        if (!ok) { await noteFail(env, keys); return json({ error: 'Wrong email or password' }, 401); }
        return json({ ok: true }, 200, { 'set-cookie': await startSession(env, u, secure) });
      }
      if (path === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearCookie(secure) });

      const u = await getUser(req, env);
      if (!u) return json({ error: 'Not logged in' }, 401);

      if (path === '/api/me') return json({ id: u.id, email: u.email, is_admin: u.is_admin, name: displayName(u.id), ytKey: await sessionKey(env.SESSION_SECRET, u.id, u.sid) });
      // "Sign out everywhere": bump the session version so every cookie minted before now
      // fails getUser, then clear this device's cookie too. Available to any user (admins
      // included) as the least disruptive alternative to forcing single-device login on admins.
      if (path === '/api/logout/all' && m === 'POST') {
        await env.DB.prepare('UPDATE users SET ver = ver + 1 WHERE id = ?').bind(u.id).run();
        return json({ ok: true }, 200, { 'set-cookie': clearCookie(secure) });
      }
      if (path === '/api/course') {
        const w = new Set((await env.DB.prepare('SELECT lesson FROM watched WHERE user_id = ?').bind(u.id).all()).results.map((r) => r.lesson));
        const mine = await myCourses(env, u);
        // A catalog: every course is listed. An ungranted one is `locked` and its
        // sections are withheld here, so a locked course can never leak its lessons.
        return json((await listCourse(env)).map((c) => {
          const locked = !!mine && !mine.has(c.title);
          return {
            title: c.title,
            description: c.description || '',
            banner: c.banner ? `/api/banner/${encodeURIComponent(c.title)}` : '',
            locked,
            sections: locked ? [] : c.sections.map((s) => ({
              title: s.title,
              // publicLesson() drops the YouTube id: ids are fetched one at a time from
              // /api/lesson/<id>/yt, so the whole-course response cannot be scraped for them.
              lessons: s.lessons.map((l) => publicLesson(l, w.has(l.id))),
            })),
          };
        }));
      }
      // The YouTube id for one lesson, fetched when the lesson opens. Admins and students go
      // through the same check as media: lessonAccess, then the per-hour lesson limit. Only a
      // YouTube lesson the user may open answers; anything else is a 404.
      if (path.startsWith('/api/lesson/') && path.endsWith('/yt')) {
        const key = decodeURIComponent(path.slice('/api/lesson/'.length, -'/yt'.length));
        const access = await lessonAccess(env, u, key);
        if (access !== 'ok') return accessError(access);
        const course = (await listCourse(env)).find((c) => c.title === courseOf(key));
        const lesson = course && course.sections.flatMap((s) => s.lessons).find((l) => l.id === key);
        if (!lesson || lesson.kind !== 'youtube' || !lesson.yt) return json({ error: 'Not found' }, 404);
        if (await scraping(env, u, key)) return json({ error: 'Too many lessons opened. Please slow down.' }, 429);
        return json({ yt: scramble(await sessionKey(env.SESSION_SECRET, u.id, u.sid), lesson.yt) }, 200, { 'cache-control': 'no-store' });
      }
      // Position numbers the student browser shows: path -> number. A course-level row
      // is public (so the catalog sorts the same for everyone); a lesson-level row is
      // only included when the student is granted that course, so a locked course's
      // folder/lesson paths never leak.
      if (path === '/api/order') {
        const mine = await myCourses(env, u);
        const rows = (await env.DB.prepare('SELECT path, position FROM content_order').all()).results || [];
        const order = {};
        for (const row of rows) {
          const key = String(row.path);
          const courseLevel = !key.includes('/');
          if (!mine || mine.has(key.split('/')[0]) || courseLevel) order[key] = Number(row.position);
        }
        return json(order);
      }
      if (path.startsWith('/api/banner/')) {
        const course = decodeURIComponent(path.slice('/api/banner/'.length));
        const c = (await listCourse(env)).find((x) => x.title === course);
        const ext = c && c.banner ? c.banner.split('.').pop().toLowerCase() : '';
        if (!ext || !BANNER_TYPES[ext]) return json({ error: 'Not found' }, 404);
        const obj = await env.RESOURCES.get(c.banner);
        if (!obj) return json({ error: 'Not found' }, 404);
        const h = new Headers();
        h.set('content-type', BANNER_TYPES[ext]);
        h.set('cache-control', 'private, no-store');
        h.set('x-content-type-options', 'nosniff');
        h.set('content-disposition', 'inline');
        h.set('cross-origin-resource-policy', 'same-origin');
        h.set('x-robots-tag', 'noindex');
        h.set('content-length', String(obj.size));
        return new Response(obj.body, { headers: h });
      }
      if (path.startsWith('/api/media/')) {
        const key = decodeURIComponent(path.slice(11));
        const mine = await myCourses(env, u);
        if (mine && !mine.has(courseOf(key))) return json({ error: 'Not allowed' }, 403);
        return serve(req, env, key, u);
      }
      if (path.startsWith('/api/note-asset/')) {
        // Private images pasted into a PDF's notes. The bytes live in R2 under this user's
        // `_notes/` prefix and only the signed-in student may read or write their own.
        const rest = path.slice('/api/note-asset/'.length);
        const cut = rest.lastIndexOf('/');
        const lesson = cut > 0 ? decodeURIComponent(rest.slice(0, cut)) : '';
        const assetId = cut > 0 ? rest.slice(cut + 1) : '';
        if (!ASSET_ID_RE.test(assetId)) return json({ error: 'Bad request' }, 400);
        if (lesson.length > 500 || !/\.pdf$/i.test(lesson)) return json({ error: 'Bad lesson' }, 400);
        const mineA = await myCourses(env, u);
        if (mineA && !mineA.has(courseOf(lesson))) return json({ error: 'Not allowed' }, 403);
        const realA = await env.DB.prepare('SELECT 1 x FROM resources WHERE file_key = ?').bind(lesson).first();
        if (!realA && (await lessonAccess(env, u, lesson)) !== 'ok') return json({ error: 'Not found' }, 404);
        if (m === 'PUT') {
          const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          if (!NOTE_ASSET_TYPES.has(type)) return json({ error: 'That is not an image we can store' }, 415);
          const body = new Uint8Array(await req.arrayBuffer());
          if (!body.length) return json({ error: 'Empty image' }, 400);
          if (body.length > NOTE_ASSET_MAX) return json({ error: 'That image is too large to store' }, 413);
          const exists = await env.DB.prepare('SELECT 1 x FROM note_assets WHERE user_id = ? AND asset_id = ? LIMIT 1').bind(u.id, assetId).first();
          if (!exists) {
            const n = await env.DB.prepare('SELECT COUNT(*) n FROM note_assets WHERE user_id = ?').bind(u.id).first();
            if (n && Number(n.n) >= NOTE_ASSETS_PER_USER) return json({ error: 'You have too many stored images on this PDF' }, 413);
          }
          await env.RESOURCES.put(noteAssetKey(u.id, assetId), body, { httpMetadata: { contentType: type } });
          await env.DB.prepare(
            'INSERT INTO note_assets (user_id, lesson, asset_id, type, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, lesson, asset_id) DO UPDATE SET type = excluded.type',
          ).bind(u.id, lesson, assetId, type, Date.now()).run();
          return json({ url: noteAssetUrl(lesson, assetId) });
        }
        if (m === 'GET') {
          const row = await env.DB.prepare('SELECT type FROM note_assets WHERE user_id = ? AND lesson = ? AND asset_id = ?').bind(u.id, lesson, assetId).first();
          if (!row) return json({ error: 'Not found' }, 404);
          const obj = await env.RESOURCES.get(noteAssetKey(u.id, assetId));
          if (!obj) return json({ error: 'Not found' }, 404);
          return new Response(obj.body, {
            status: 200,
            headers: {
              'content-type': row.type || 'application/octet-stream',
              'x-content-type-options': 'nosniff',
              // An image is data, never a document: sandbox it in case an SVG slips through.
              'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
              'cache-control': 'private, max-age=31536000, immutable',
            },
          });
        }
        return json({ error: 'Not found' }, 404);
      }
      if (path.startsWith('/api/notes/')) {
        // Private PDF notes: every query is scoped to the signed-in user, so nobody can read another student's notes.
        const lesson = decodeURIComponent(path.slice(11));
        if (lesson.length > 500 || !/\.pdf$/i.test(lesson)) return json({ error: 'Bad lesson' }, 400);
        const mineN = await myCourses(env, u);
        if (mineN && !mineN.has(courseOf(lesson))) return json({ error: 'Not allowed' }, 403);
        // Notes are only meaningful for a PDF that exists: a lesson in the bucket, or an
        // admin-uploaded resource. This keeps a student from inventing names to fill D1.
        const realFile = await env.DB.prepare('SELECT 1 x FROM resources WHERE file_key = ?').bind(lesson).first();
        if (!realFile && (await lessonAccess(env, u, lesson)) !== 'ok') return json({ error: 'Not found' }, 404);
        if (m === 'GET') {
          const r = await env.DB.prepare('SELECT data FROM pdf_notes WHERE user_id = ? AND lesson = ?').bind(u.id, lesson).first();
          return json({ data: r ? JSON.parse(r.data) : [] });
        }
        if (m === 'PUT') {
          const { data } = await req.json();
          if (!Array.isArray(data)) return json({ error: 'Bad notes' }, 400);
          const text = JSON.stringify(data);
          // Measure bytes, not characters: D1 stores UTF-8 bytes, so a short multi-byte
          // string (e.g. Bengali, 3 bytes per character) could otherwise be saved past
          // the limit and then fail at the storage layer.
          if (enc.encode(text).length > 1500000) return json({ error: 'Your notes on this PDF are too large to save' }, 413);
          if (!data.length) await env.DB.prepare('DELETE FROM pdf_notes WHERE user_id = ? AND lesson = ?').bind(u.id, lesson).run();
          else await env.DB.prepare('INSERT INTO pdf_notes (user_id, lesson, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, lesson) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(u.id, lesson, text, Date.now()).run();
          // An image the student removed (or replaced) no longer belongs in the bucket.
          await pruneNoteAssets(env, u.id, lesson, referencedAssetIds(data));
          return json({ ok: true });
        }
        if (m === 'DELETE') {
          await env.DB.prepare('DELETE FROM pdf_notes WHERE user_id = ? AND lesson = ?').bind(u.id, lesson).run();
          await pruneNoteAssets(env, u.id, lesson);
          return json({ ok: true });
        }
      }
      if (path === '/api/progress' && m === 'POST') {
        const { lesson, done } = await req.json();
        // Same rule as comments/notes/resources: the lesson must exist and the student must
        // be granted its course. lessonAccess also caps the key at 500 characters.
        const access = await lessonAccess(env, u, lesson);
        if (access !== 'ok') return accessError(access);
        await env.DB.prepare(done ? 'INSERT OR IGNORE INTO watched (user_id, lesson) VALUES (?, ?)' : 'DELETE FROM watched WHERE user_id = ? AND lesson = ?').bind(u.id, lesson).run();
        return json({ ok: true });
      }
      // ---- Lesson discussion, private notes and admin resources (video lessons) ----
      if (path.startsWith('/api/lesson/') && path.endsWith('/comments')) {
        const key = decodeURIComponent(path.slice('/api/lesson/'.length, -'/comments'.length));
        const access = await lessonAccess(env, u, key);
        if (access !== 'ok') return accessError(access);
        if (m === 'GET') {
          const rows = (await env.DB.prepare('SELECT c.id, c.parent_id, c.body, c.created, c.user_id FROM comments c WHERE c.lesson = ? ORDER BY c.created DESC LIMIT 500').bind(key).all()).results;
          const likes = (await env.DB.prepare('SELECT comment_id, COUNT(*) n FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE lesson = ?) GROUP BY comment_id').bind(key).all()).results;
          const mine = new Set((await env.DB.prepare('SELECT cl.comment_id id FROM comment_likes cl JOIN comments c ON c.id = cl.comment_id WHERE c.lesson = ? AND cl.user_id = ?').bind(key, u.id).all()).results.map((r) => r.id));
          const count = new Map(likes.map((r) => [r.comment_id, r.n]));
          return json({
            comments: rows.map((r) => {
              const name = displayName(r.user_id);
              return {
                id: r.id, parent_id: r.parent_id, body: r.body, created: r.created,
                name, initial: name[0].toUpperCase(),
                likes: count.get(r.id) || 0, liked: mine.has(r.id),
                own: r.user_id === u.id, can_delete: r.user_id === u.id || !!u.is_admin,
              };
            }),
          });
        }
        if (m === 'POST') {
          const b = await req.json();
          const body = String(b.body || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
          if (!body) return json({ error: 'Write something first' }, 400);
          if (body.length > 1000) return json({ error: 'Comments are limited to 1000 characters' }, 400);
          let parent = null;
          if (b.parent != null) {
            parent = Number(b.parent);
            const pc = await env.DB.prepare('SELECT id, parent_id, lesson FROM comments WHERE id = ?').bind(parent).first();
            if (!pc || pc.lesson !== key || pc.parent_id != null) return json({ error: 'You can only reply to a comment' }, 400);
          }
          const recent = await env.DB.prepare('SELECT COUNT(*) n FROM comments WHERE user_id = ? AND created > ?').bind(u.id, Date.now() - 5 * 60e3).first();
          if (recent.n >= 10) return json({ error: 'You are commenting too fast. Try again in a few minutes.' }, 429);
          const now = Date.now();
          const res = await env.DB.prepare('INSERT INTO comments (lesson, user_id, parent_id, body, created) VALUES (?, ?, ?, ?, ?)').bind(key, u.id, parent, body, now).run();
          const name = displayName(u.id);
          return json({ comment: { id: res.meta.last_row_id, parent_id: parent, body, created: now, name, initial: name[0].toUpperCase(), likes: 0, liked: false, own: true, can_delete: true } });
        }
      }
      {
        const mm = /^\/api\/comments\/(\d+)\/like$/.exec(path);
        if (mm && m === 'POST') {
          const id = Number(mm[1]);
          const c = await env.DB.prepare('SELECT id, lesson FROM comments WHERE id = ?').bind(id).first();
          if (!c) return json({ error: 'Not found' }, 404);
          const access = await lessonAccess(env, u, c.lesson);
          if (access !== 'ok') return accessError(access);
          const had = await env.DB.prepare('SELECT 1 x FROM comment_likes WHERE comment_id = ? AND user_id = ?').bind(id, u.id).first();
          if (had) await env.DB.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?').bind(id, u.id).run();
          else await env.DB.prepare('INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)').bind(id, u.id).run();
          const n = await env.DB.prepare('SELECT COUNT(*) n FROM comment_likes WHERE comment_id = ?').bind(id).first();
          return json({ liked: !had, likes: n.n });
        }
      }
      {
        const md = /^\/api\/comments\/(\d+)$/.exec(path);
        if (md && m === 'DELETE') {
          const id = Number(md[1]);
          const c = await env.DB.prepare('SELECT id, lesson, user_id, parent_id FROM comments WHERE id = ?').bind(id).first();
          if (!c) return json({ error: 'Not found' }, 404);
          const access = await lessonAccess(env, u, c.lesson);
          if (access !== 'ok') return accessError(access);
          if (c.user_id !== u.id && !u.is_admin) return json({ error: 'Not allowed' }, 403);
          const ids = [id];
          if (c.parent_id == null) ids.push(...(await env.DB.prepare('SELECT id FROM comments WHERE parent_id = ?').bind(id).all()).results.map((r) => r.id));
          await env.DB.batch([
            ...ids.map((x) => env.DB.prepare('DELETE FROM comment_likes WHERE comment_id = ?').bind(x)),
            env.DB.prepare('DELETE FROM comments WHERE id IN (' + ids.map(() => '?').join(',') + ')').bind(...ids),
          ]);
          return json({ ok: true });
        }
      }
      if (path.startsWith('/api/lesson/') && path.endsWith('/notes')) {
        // Private like the PDF notes: every query is scoped to the signed-in user.
        const key = decodeURIComponent(path.slice('/api/lesson/'.length, -'/notes'.length));
        const access = await lessonAccess(env, u, key);
        if (access !== 'ok') return accessError(access);
        if (m === 'GET') {
          const r = await env.DB.prepare('SELECT body FROM video_notes WHERE user_id = ? AND lesson = ?').bind(u.id, key).first();
          return json({ body: r ? r.body : '' });
        }
        if (m === 'PUT') {
          const b = await req.json();
          const body = String(b.body ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
          if (body.length > 20000) return json({ error: 'Your notes on this lesson are too long to save' }, 413);
          if (!body) await env.DB.prepare('DELETE FROM video_notes WHERE user_id = ? AND lesson = ?').bind(u.id, key).run();
          else await env.DB.prepare('INSERT INTO video_notes (user_id, lesson, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, lesson) DO UPDATE SET body = excluded.body, updated = excluded.updated').bind(u.id, key, body, Date.now()).run();
          return json({ ok: true });
        }
      }
      if (path.startsWith('/api/lesson/') && path.endsWith('/resources')) {
        const key = decodeURIComponent(path.slice('/api/lesson/'.length, -'/resources'.length));
        const access = await lessonAccess(env, u, key);
        if (access !== 'ok') return accessError(access);
        if (m === 'GET') {
          const rows = (await env.DB.prepare('SELECT id, title, url, note, kind, file_key FROM resources WHERE lesson = ? ORDER BY created ASC').bind(key).all()).results;
          const resources = rows.map((r) => ({
            id: r.id,
            title: r.title,
            url: r.kind === 'pdf' ? (r.file_key || '') : r.url,
            note: r.note,
            kind: r.kind === 'pdf' ? 'pdf' : 'link',
          }));
          return json({ resources });
        }
      }
      if (path.startsWith('/api/admin/')) {
        if (!u.is_admin) return json({ error: 'Admins only' }, 403);
        if (path.startsWith('/api/admin/lesson/') && path.endsWith('/resources/pdf') && m === 'POST') {
          const key = decodeURIComponent(path.slice('/api/admin/lesson/'.length, -'/resources/pdf'.length));
          const access = await lessonAccess(env, u, key);
          if (access !== 'ok') return accessError(access);
          if (Number(req.headers.get('content-length') || 0) > 26 * 1024 * 1024) return json({ error: 'PDFs must be 25 MB or smaller' }, 413);
          const form = await req.formData().catch(() => null);
          const file = form && form.get('file');
          if (!form || !(file instanceof File)) return json({ error: 'Choose a PDF file' }, 400);
          if (!/\.pdf$/i.test(file.name || '')) return json({ error: 'Choose a PDF file' }, 400);
          if (file.size > 25 * 1024 * 1024) return json({ error: 'PDFs must be 25 MB or smaller' }, 413);
          const head = String.fromCharCode(...new Uint8Array(await file.slice(0, 5).arrayBuffer()));
          if (head !== '%PDF-') return json({ error: 'That file is not a PDF' }, 400);

          const rawTitle = String(form.get('title') || '').trim();
          const note = String(form.get('note') || '').trim();
          let title = rawTitle || String(file.name).replace(/\.pdf$/i, '').trim() || 'PDF';
          if (title.length > 120) {
            if (rawTitle) return json({ error: 'Keep the title under 120 characters' }, 400);
            title = title.slice(0, 120);
          }
          if (note.length > 300) return json({ error: 'Keep the note under 300 characters' }, 400);

          const n = await env.DB.prepare('SELECT COUNT(*) n FROM resources WHERE lesson = ?').bind(key).first();
          if (n.n >= 100) return json({ error: 'This lesson already has 100 resources' }, 400);

          const fileKey = `${courseOf(key)}/_resources/${crypto.randomUUID()}.pdf`;
          await env.RESOURCES.put(fileKey, await file.arrayBuffer(), { httpMetadata: { contentType: 'application/pdf' } });
          try {
            const res = await env.DB.prepare("INSERT INTO resources (lesson, title, url, note, created_by, created, kind, file_key) VALUES (?, ?, '', ?, ?, ?, 'pdf', ?)").bind(key, title, note || null, u.id, Date.now(), fileKey).run();
            return json({ resource: { id: res.meta.last_row_id, title, url: fileKey, note: note || null, kind: 'pdf' } });
          } catch (e) {
            await env.RESOURCES.delete(fileKey).catch(() => {});
            throw e;
          }
        }
        if (path.startsWith('/api/admin/lesson/') && path.endsWith('/resources') && m === 'POST') {
          const key = decodeURIComponent(path.slice('/api/admin/lesson/'.length, -'/resources'.length));
          const access = await lessonAccess(env, u, key);
          if (access !== 'ok') return accessError(access);
          const b = await req.json();
          const title = String(b.title || '').trim();
          const url = String(b.url || '').trim();
          const note = String(b.note || '').trim();
          if (!title) return json({ error: 'Give the resource a title' }, 400);
          if (title.length > 120) return json({ error: 'Keep the title under 120 characters' }, 400);
          if (!url || url.length > 800) return json({ error: 'Enter a link' }, 400);
          let parsed;
          try { parsed = new URL(url); } catch { return json({ error: 'Enter a valid http(s) link' }, 400); }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return json({ error: 'Enter a valid http(s) link' }, 400);
          if (note.length > 300) return json({ error: 'Keep the note under 300 characters' }, 400);
          const n = await env.DB.prepare('SELECT COUNT(*) n FROM resources WHERE lesson = ?').bind(key).first();
          if (n.n >= 100) return json({ error: 'This lesson already has 100 resources' }, 400);
          const res = await env.DB.prepare("INSERT INTO resources (lesson, title, url, note, created_by, created, kind) VALUES (?, ?, ?, ?, ?, ?, 'link')").bind(key, title, url, note || null, u.id, Date.now()).run();
          return json({ resource: { id: res.meta.last_row_id, title, url, note: note || null, kind: 'link' } });
        }
        {
          const mr = /^\/api\/admin\/resources\/(\d+)$/.exec(path);
          if (mr && m === 'PATCH') {
            const id = Number(mr[1]);
            const row = await env.DB.prepare('SELECT lesson, kind, file_key FROM resources WHERE id = ?').bind(id).first();
            if (!row) return json({ error: 'Not found' }, 404);
            const access = await lessonAccess(env, u, String(row.lesson));
            if (access !== 'ok') return accessError(access);
            const b = await req.json().catch(() => ({}));
            const title = String(b.title || '').trim();
            const note = String(b.note || '').trim();
            if (!title) return json({ error: 'Give the resource a title' }, 400);
            if (title.length > 120) return json({ error: 'Keep the title under 120 characters' }, 400);
            if (note.length > 300) return json({ error: 'Keep the note under 300 characters' }, 400);
            let url = '';
            if (row.kind !== 'pdf') {
              url = String(b.url || '').trim();
              if (!url || url.length > 800) return json({ error: 'Enter a link' }, 400);
              let parsed;
              try { parsed = new URL(url); } catch { return json({ error: 'Enter a valid http(s) link' }, 400); }
              if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return json({ error: 'Enter a valid http(s) link' }, 400);
              await env.DB.prepare('UPDATE resources SET title = ?, note = ?, url = ? WHERE id = ?').bind(title, note || null, url, id).run();
            } else {
              // A PDF's file is its file_key; a submitted url must never replace it.
              await env.DB.prepare('UPDATE resources SET title = ?, note = ? WHERE id = ?').bind(title, note || null, id).run();
            }
            return json({
              resource: {
                id,
                title,
                url: row.kind === 'pdf' ? String(row.file_key || '') : url,
                note: note || null,
                kind: row.kind === 'pdf' ? 'pdf' : 'link',
              },
            });
          }
          if (mr && m === 'DELETE') {
            const id = Number(mr[1]);
            const row = await env.DB.prepare('SELECT file_key FROM resources WHERE id = ?').bind(id).first();
            await env.DB.prepare('DELETE FROM resources WHERE id = ?').bind(id).run();
            if (row && row.file_key) {
              await env.RESOURCES.delete(row.file_key).catch(() => {});
              await env.DB.prepare('DELETE FROM pdf_notes WHERE lesson = ?').bind(row.file_key).run();
            }
            return json({ ok: true });
          }
        }
        if (path === '/api/admin/users' && m === 'GET') {
          const rows = (await env.DB.prepare('SELECT u.id, u.email, u.is_admin, (SELECT COUNT(*) FROM watched w WHERE w.user_id = u.id) AS watched, (u.google_sub IS NOT NULL) AS google FROM users u ORDER BY u.is_admin DESC, u.email').all()).results;
          const by = {};
          for (const e of (await env.DB.prepare('SELECT user_id, course FROM enrollments').all()).results) (by[e.user_id] ||= []).push(e.course);
          return json(rows.map((r) => ({ ...r, owner: isOwner(env, r.email), courses: by[r.id] || [] })));
        }
        if (path === '/api/admin/courses' && m === 'GET') {
          return json((await listCourse(env)).map((c) => c.title));
        }
        if (path === '/api/admin/youtube' && m === 'GET') {
          const rows = (await env.DB.prepare('SELECT id, yt FROM youtube_lessons ORDER BY id').all()).results;
          return json(rows.map((r) => {
            const parts = String(r.id).split('/').filter(Boolean);
            return { id: r.id, course: parts[0] || '', folder: parts.slice(1, -1).join(' / '), lesson: parts[parts.length - 1] || '', yt: r.yt };
          }));
        }
        if (path === '/api/admin/youtube' && m === 'POST') {
          const b = await req.json();
          const course = String(b.course || '').trim();
          const lesson = String(b.lesson || '').trim();
          const folder = String(b.folder || '').trim();
          const yt = ytId(b.link);
          if (!course || !lesson) return json({ error: 'Course and lesson name are required' }, 400);
          if (course.includes('/') || lesson.includes('/')) return json({ error: 'Course and lesson name cannot contain "/"' }, 400);
          if (!yt) return json({ error: 'That is not a YouTube link' }, 400);
          const parts = [course, ...folder.split('/').map((s) => s.trim()).filter(Boolean), lesson];
          const id = parts.join('/');
          await env.DB.prepare('INSERT INTO youtube_lessons (id, yt, created) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET yt = excluded.yt').bind(id, yt, Date.now()).run();
          invalidateCourse();
          const shadowed = !!(await env.RESOURCES.head(id));
          return json({ ok: true, id, yt, shadowed });
        }
        if (path === '/api/admin/youtube' && m === 'DELETE') {
          const b = await req.json();
          const id = String(b.id || '').trim();
          if (!id) return json({ error: 'Missing lesson' }, 400);
          const pdfs = (await env.DB.prepare('SELECT file_key FROM resources WHERE lesson = ? AND file_key IS NOT NULL').bind(id).all()).results;
          for (const row of pdfs) {
            await env.RESOURCES.delete(row.file_key).catch(() => {});
            await env.DB.prepare('DELETE FROM pdf_notes WHERE lesson = ?').bind(row.file_key).run();
          }
          await env.DB.prepare('DELETE FROM resources WHERE lesson = ?').bind(id).run();
          await env.DB.prepare('DELETE FROM youtube_lessons WHERE id = ?').bind(id).run();
          await env.DB.prepare('DELETE FROM content_order WHERE path = ?').bind(id).run();
          invalidateCourse();
          return json({ ok: true });
        }
        if (path === '/api/admin/users' && m === 'POST') {
          const b = await req.json();
          const email = String(b.email || '').trim().toLowerCase();
          if (!validEmail(email)) return json({ error: 'Enter a valid email' }, 400);
          if (!b.google_only && !validPw(b.password)) return json({ error: 'Password must be 8+ characters' }, 400);
          const pass = b.google_only ? await unusablePw() : await hashPw(b.password);
          await env.DB.prepare('INSERT INTO users (email, pass, is_admin) VALUES (?, ?, ?)').bind(email, pass, b.is_admin ? 1 : 0).run();
          await grant(env, [email], b.courses);
          return json({ ok: true });
        }
        if (path === '/api/admin/users/bulk' && m === 'POST') {
          const b = await req.json();
          const googleOnly = !!b.google_only;
          const max = googleOnly ? 500 : 20; // password hashing is CPU heavy, so password batches are small
          const seen = new Set(); const skipped = []; const todo = [];
          for (const raw of Array.isArray(b.emails) ? b.emails : []) {
            const email = String(raw).trim().toLowerCase();
            if (!email || seen.has(email)) continue;
            seen.add(email);
            if (!validEmail(email)) skipped.push({ email, reason: 'invalid email' }); else todo.push(email);
          }
          if (todo.length > max) return json({ error: `Send at most ${max} emails per request` }, 400);
          const ALPHA = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          const mkPw = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => ALPHA[x % ALPHA.length]).join('');
          const rows = [];
          for (const email of todo) {
            const password = googleOnly ? null : mkPw();
            rows.push({ email, password, hash: googleOnly ? await unusablePw() : await hashPw(password) });
          }
          const added = [];
          for (let i = 0; i < rows.length; i += 50) {
            const part = rows.slice(i, i + 50);
            const res = await env.DB.batch(part.map((r) => env.DB.prepare('INSERT OR IGNORE INTO users (email, pass, is_admin) VALUES (?, ?, ?)').bind(r.email, r.hash, b.is_admin ? 1 : 0)));
            part.forEach((r, j) => {
              if (res[j].meta.changes) added.push(googleOnly ? { email: r.email } : { email: r.email, password: r.password });
              else skipped.push({ email: r.email, reason: 'already exists' });
            });
          }
          await grant(env, added.map((a) => a.email), b.courses);
          return json({ added, skipped });
        }
        const mm = /^\/api\/admin\/users\/(\d+)(?:\/(password|role|courses))?$/.exec(path);
        if (mm) {
          const id = Number(mm[1]);
          const t = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(id).first();
          if (!t) return json({ error: 'User not found' }, 404);
          if (mm[2] === 'password' && m === 'POST') {
            // The Owner's credentials live in Cloudflare secrets, not in the panel: another
            // admin resetting it would be able to sign in as the Owner.
            if (isOwner(env, t.email)) return json({ error: 'The Owner password comes from the ADMIN_PASSWORD secret' }, 400);
            const b = await req.json();
            if (!validPw(b.password)) return json({ error: 'Password must be 8+ characters' }, 400);
            await env.DB.prepare('UPDATE users SET pass = ?, ver = ver + 1 WHERE id = ?').bind(await hashPw(b.password), id).run();
            return json({ ok: true });
          }
          if (mm[2] === 'courses' && m === 'POST') {
            const b = await req.json();
            await env.DB.prepare('DELETE FROM enrollments WHERE user_id = ?').bind(id).run();
            await grant(env, [t.email], b.courses);
            return json({ ok: true });
          }
          if (mm[2] === 'role' && m === 'POST') {
            const b = await req.json();
            if (isOwner(env, t.email) || t.id === u.id) return json({ error: 'You cannot change this admin' }, 400);
            await env.DB.prepare('UPDATE users SET is_admin = ?, ver = ver + 1 WHERE id = ?').bind(b.is_admin ? 1 : 0, id).run();
            return json({ ok: true });
          }
          if (!mm[2] && m === 'DELETE') {
            if (isOwner(env, t.email) || t.id === u.id) return json({ error: 'You cannot delete this admin' }, 400);
            await env.DB.batch([
              env.DB.prepare('DELETE FROM watched WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM pdf_notes WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM note_assets WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM video_notes WHERE user_id = ?').bind(id),
              // Their top-level comments take other students' replies with them, the same
              // way deleting a comment does, so no invisible orphan replies are left behind.
              env.DB.prepare('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE user_id = ?)').bind(id),
              env.DB.prepare('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE parent_id IN (SELECT id FROM comments WHERE user_id = ?))').bind(id),
              env.DB.prepare('DELETE FROM comments WHERE parent_id IN (SELECT id FROM comments WHERE user_id = ?)').bind(id),
              env.DB.prepare('DELETE FROM comments WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM comment_likes WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM enrollments WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
            ]);
            // Their pasted note images live under `_notes/<id>/`; take the folder with them.
            await sweepPrefix(env, `_notes/${id}/`).catch(() => {});
            return json({ ok: true });
          }
        }
        const handled = await handleFiles(req, env, path, m, new URL(req.url), { invalidate: invalidateCourse });
        if (handled) return handled;
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      // A path with a stray "%" (e.g. /api/media/%zz) makes decodeURIComponent throw. That is a
      // bad request, not a server fault, so it must not surface as a 500.
      if (e instanceof URIError) return json({ error: 'Bad request' }, 400);
      if (e && e.dbTimeout) return json({ error: 'Database temporarily unavailable' }, 503, { 'retry-after': '5' });
      const dup = String(e).includes('UNIQUE');
      return json({ error: dup ? 'That email already exists' : 'Server error' }, dup ? 409 : 500);
    }
  }
};
