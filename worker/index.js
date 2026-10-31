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
  const u = await env.DB.prepare('SELECT id, email, is_admin, ver FROM users WHERE id = ?').bind(d.uid).first();
  // 'ver' changes on password reset / role change, which signs the user out everywhere
  return u && (d.v || 0) === u.ver ? u : null;
}
// 'Secure' is only sent over HTTPS: browsers reject a Secure cookie on a plain-HTTP
// origin (e.g. the dev server over http://192.168.0.101:4200), which made the login
// appear to do nothing on a phone while localhost — treated as trustworthy — worked.
async function sessionCookie(u, env, secure) {
  const p = b64(enc.encode(JSON.stringify({ uid: u.id, v: u.ver || 0, exp: Date.now() + 7 * 864e5 })));
  return `s=${p}.${await hmac(env.SESSION_SECRET, p)}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict; Path=/; Max-Age=604800`;
}
function clearCookie(secure) {
  return `s=; HttpOnly${secure ? '; Secure' : ''}; SameSite=Strict; Path=/; Max-Age=0`;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS watched (user_id INTEGER NOT NULL, lesson TEXT NOT NULL, PRIMARY KEY (user_id, lesson))',
  'CREATE TABLE IF NOT EXISTS pdf_notes (user_id INTEGER NOT NULL, lesson TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, lesson))',
  'CREATE TABLE IF NOT EXISTS attempts (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson TEXT NOT NULL, user_id INTEGER NOT NULL, parent_id INTEGER, body TEXT NOT NULL, created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_comments_lesson ON comments(lesson, created)',
  'CREATE TABLE IF NOT EXISTS comment_likes (comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (comment_id, user_id))',
  'CREATE TABLE IF NOT EXISTS video_notes (user_id INTEGER NOT NULL, lesson TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, lesson))',
  'CREATE TABLE IF NOT EXISTS resources (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, note TEXT, created_by INTEGER NOT NULL, created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_resources_lesson ON resources(lesson, created)',
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
  const has = await env.DB.prepare("SELECT COUNT(*) c FROM pragma_table_info('users') WHERE name = 'google_sub'").first();
  if (!has.c) await env.DB.prepare('ALTER TABLE users ADD COLUMN google_sub TEXT').run();
  const hasVer = await env.DB.prepare("SELECT COUNT(*) c FROM pragma_table_info('users') WHERE name = 'ver'").first();
  if (!hasVer.c) await env.DB.prepare('ALTER TABLE users ADD COLUMN ver INTEGER NOT NULL DEFAULT 0').run();
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub)').run();
  const had = await env.DB.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = 'enrollments'").first();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS enrollments (user_id INTEGER NOT NULL, course TEXT NOT NULL, PRIMARY KEY (user_id, course))').run();
  if (!had.c) { // first deploy only: today's students keep access to every current course
    const courses = (await listCourse(env)).map((c) => c.title);
    const users = (await env.DB.prepare('SELECT id FROM users').all()).results;
    const st = users.flatMap((x) => courses.map((c) => env.DB.prepare('INSERT OR IGNORE INTO enrollments (user_id, course) VALUES (?, ?)').bind(x.id, c)));
    for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  }
}
const ensureSchema = (env) => (ready ||= env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).then(() => migrate(env)).then(() => seedAdmin(env)).catch((e) => { ready = null; throw e; }));

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

// Bucket structure:
//   <Course>/<file>                  → course with a flat lesson
//   <Course>/<Section>/<file>        → course with a section containing a lesson
//   <Course>/<Section>/<Sub>/...     → deeper sub-folders treated as nested sections
const VIDEO_EXT = /\.(mp4|webm|mkv|mov|avi|m4v|m3u8)$/i;
const MEDIA_TYPES = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo', m4v: 'video/mp4' };
let cache = { at: 0, data: null };
const NUM = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
async function listCourse(env) {
  if (cache.data && Date.now() - cache.at < 60000) return cache.data;
  const keys = []; let cursor;
  do {
    const r = await env.VIDEOS.list({ cursor, limit: 1000 });
    keys.push(...r.objects.map((o) => o.key)); cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);

  // courses: Map<courseName, Map<sectionName, lesson[]>>
  // files directly under course root go into section '' (no section)
  const courses = new Map();
  for (const key of keys) {
    if (/\.ts$/i.test(key)) continue; // skip HLS segments
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
    secs.get(sectionName).push({ id: key, title, kind: pdf ? 'pdf' : 'video' });
  }

  const data = [...courses].sort((a, b) => NUM.compare(a[0], b[0])).map(([courseName, secs]) => {
    const sections = [...secs].sort((a, b) => NUM.compare(a[0], b[0])).map(([sectionName, lessons]) => ({
      title: sectionName || null,
      lessons: lessons.sort((a, b) => NUM.compare(a.title, b.title)),
    }));
    return { title: courseName, sections };
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
// 2) Scraping a whole course touches many lessons quickly. Cap distinct lessons per user per hour (per Worker instance).
const seen = new Map();
const lessonOf = (key) => (/\.(m3u8|ts)$/i.test(key) ? key.slice(0, key.lastIndexOf('/')) : key);
function scraping(env, u, key) {
  if (u.is_admin) return false;
  const now = Date.now();
  let e = seen.get(u.id);
  if (!e || now - e.t > 36e5) { if (seen.size > 2000) seen.clear(); e = { t: now, s: new Set() }; seen.set(u.id, e); }
  e.s.add(lessonOf(key));
  return e.s.size > Number(env.MAX_LESSONS_PER_HOUR || 20);
}

// 3) Slow-down: video must be requested in ranges (browsers always do; a plain "download this URL" gets refused),
//    each answer is at most CHUNK bytes, and each student's total media speed is capped near normal playback
//    speed. Fast requests are delayed instead of rejected, so playback stays smooth but bulk downloading is slow.
const CHUNK = 4 * 1024 * 1024;
const VIDEO_FILE = /\.(mp4|webm|mkv|mov|avi|m4v)$/i;
const buckets = new Map();
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

async function serve(req, env, key, u) {
  const ok = /\.(m3u8|ts|pdf|mp4|webm|mkv|mov|avi|m4v)$/i.test(key);
  if (!ok || !mediaRequestOk(req, env)) return json({ error: 'Not allowed' }, 403);
  if (scraping(env, u, key)) return json({ error: 'Too many lessons opened. Please slow down.' }, 429);
  const isVideo = VIDEO_FILE.test(key);
  let range = req.headers;
  if (isVideo) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('range') || '');
    if (!req.headers.has('range')) return json({ error: 'Not allowed' }, 403);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] === '' ? Infinity : Number(m[2]);
      range = { offset: start, length: Math.min(end - start + 1, CHUNK) };
    }
  }
  const obj = await env.VIDEOS.get(key, { range });
  if (!obj) return json({ error: 'File not found' }, 404);
  const h = new Headers();
  h.set('content-type', MEDIA_TYPES[key.split('.').pop().toLowerCase()] || 'application/octet-stream');
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', /\.pdf$/i.test(key) ? 'private, max-age=3600' : 'private, no-store');
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
  if (!/\.pdf$/i.test(key)) {
    const wait = reserve(env, u, Number(h.get('content-length')) || 0);
    if (wait === null) return json({ error: 'Too fast. Please slow down.' }, 429, { 'retry-after': '30' });
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return new Response(obj.body, { status, headers: h });
}

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // CSRF defense in depth: state-changing API calls must come from this site
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.get('origin');
      const site = req.headers.get('sec-fetch-site');
      if ((origin && new URL(origin).host !== url.host) || (!origin && site && site !== 'same-origin' && site !== 'none')) {
        return json({ error: 'Forbidden' }, 403);
      }
    }
    const res = await handle(req, env);
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
    try {
      await ensureSchema(env);
      if (path === '/api/config') return json({ googleClientId: env.GOOGLE_CLIENT_ID || '' });
      if (path === '/api/login/google' && m === 'POST') {
        if (!env.GOOGLE_CLIENT_ID) return json({ error: 'Google sign-in is not set up' }, 503);
        const ip = ['i:' + ipOf(req), 40];
        if (await locked(env, [ip])) return tooMany();
        const { credential } = await req.json();
        const c = await verifyGoogle(String(credential || ''), env).catch(() => null);
        if (!c) { await noteFail(env, [ip]); return json({ error: 'Google sign-in failed' }, 401); }
        let u = await env.DB.prepare('SELECT id, email, google_sub, ver FROM users WHERE google_sub = ?').bind(c.sub).first();
        if (!u) {
          u = await env.DB.prepare('SELECT id, email, google_sub, ver FROM users WHERE email = ?').bind(c.email.toLowerCase()).first();
          if (!u) return json({ error: 'This Google account has not been invited' }, 403);
          if (u.google_sub && u.google_sub !== c.sub) return json({ error: 'This email is linked to a different Google account' }, 403);
          await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(c.sub, u.id).run();
        }
        return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(u, env, secure) });
      }
      if (path === '/api/login' && m === 'POST') {
        const { email, password } = await req.json();
        const em = String(email || '').trim().toLowerCase();
        const keys = [['ei:' + em + '|' + ipOf(req), 8], ['i:' + ipOf(req), 40]];
        if (await locked(env, keys)) return tooMany();
        const u = await env.DB.prepare('SELECT id, pass, ver FROM users WHERE email = ?').bind(em).first();
        if (!u || !(await checkPw(String(password || ''), u.pass))) { await noteFail(env, keys); return json({ error: 'Wrong email or password' }, 401); }
        return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(u, env, secure) });
      }
      if (path === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearCookie(secure) });

      const u = await getUser(req, env);
      if (!u) return json({ error: 'Not logged in' }, 401);

      if (path === '/api/me') return json({ id: u.id, email: u.email, is_admin: u.is_admin });
      if (path === '/api/course') {
        const w = new Set((await env.DB.prepare('SELECT lesson FROM watched WHERE user_id = ?').bind(u.id).all()).results.map((r) => r.lesson));
        const mine = await myCourses(env, u);
        return json((await listCourse(env)).filter((c) => !mine || mine.has(c.title)).map((c) => ({
          title: c.title,
          sections: c.sections.map((s) => ({
            title: s.title,
            lessons: s.lessons.map((l) => ({ ...l, done: w.has(l.id) })),
          })),
        })));
      }
      if (path.startsWith('/api/media/')) {
        const key = decodeURIComponent(path.slice(11));
        const mine = await myCourses(env, u);
        if (mine && !mine.has(courseOf(key))) return json({ error: 'Not allowed' }, 403);
        return serve(req, env, key, u);
      }
      if (path.startsWith('/api/notes/')) {
        // Private PDF notes: every query is scoped to the signed-in user, so nobody can read another student's notes.
        const lesson = decodeURIComponent(path.slice(11));
        if (lesson.length > 500 || !/\.pdf$/i.test(lesson)) return json({ error: 'Bad lesson' }, 400);
        const mineN = await myCourses(env, u);
        if (mineN && !mineN.has(courseOf(lesson))) return json({ error: 'Not allowed' }, 403);
        if (m === 'GET') {
          const r = await env.DB.prepare('SELECT data FROM pdf_notes WHERE user_id = ? AND lesson = ?').bind(u.id, lesson).first();
          return json({ data: r ? JSON.parse(r.data) : [] });
        }
        if (m === 'PUT') {
          const { data } = await req.json();
          if (!Array.isArray(data)) return json({ error: 'Bad notes' }, 400);
          const text = JSON.stringify(data);
          if (text.length > 1500000) return json({ error: 'Your notes on this PDF are too large to save' }, 413);
          if (!data.length) await env.DB.prepare('DELETE FROM pdf_notes WHERE user_id = ? AND lesson = ?').bind(u.id, lesson).run();
          else await env.DB.prepare('INSERT INTO pdf_notes (user_id, lesson, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, lesson) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(u.id, lesson, text, Date.now()).run();
          return json({ ok: true });
        }
        if (m === 'DELETE') {
          await env.DB.prepare('DELETE FROM pdf_notes WHERE user_id = ? AND lesson = ?').bind(u.id, lesson).run();
          return json({ ok: true });
        }
      }
      if (path === '/api/progress' && m === 'POST') {
        const { lesson, done } = await req.json();
        await env.DB.prepare(done ? 'INSERT OR IGNORE INTO watched (user_id, lesson) VALUES (?, ?)' : 'DELETE FROM watched WHERE user_id = ? AND lesson = ?').bind(u.id, lesson).run();
        return json({ ok: true });
      }
      // ---- Lesson discussion, private notes and admin resources (video lessons) ----
      if (path.startsWith('/api/lesson/') && path.endsWith('/comments')) {
        const key = decodeURIComponent(path.slice('/api/lesson/'.length, -'/comments'.length));
        const access = await lessonAccess(env, u, key);
        if (access !== 'ok') return accessError(access);
        if (m === 'GET') {
          const rows = (await env.DB.prepare('SELECT c.id, c.parent_id, c.body, c.created, c.user_id, u.email FROM comments c JOIN users u ON u.id = c.user_id WHERE c.lesson = ? ORDER BY c.created DESC LIMIT 500').bind(key).all()).results;
          const likes = (await env.DB.prepare('SELECT comment_id, COUNT(*) n FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE lesson = ?) GROUP BY comment_id').bind(key).all()).results;
          const mine = new Set((await env.DB.prepare('SELECT cl.comment_id id FROM comment_likes cl JOIN comments c ON c.id = cl.comment_id WHERE c.lesson = ? AND cl.user_id = ?').bind(key, u.id).all()).results.map((r) => r.id));
          const count = new Map(likes.map((r) => [r.comment_id, r.n]));
          return json({
            comments: rows.map((r) => {
              const name = String(r.email || '?').split('@')[0] || '?';
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
          const name = u.email.split('@')[0];
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
          const rows = (await env.DB.prepare('SELECT id, title, url, note FROM resources WHERE lesson = ? ORDER BY created ASC').bind(key).all()).results;
          return json({ resources: rows });
        }
      }
      if (path.startsWith('/api/admin/')) {
        if (!u.is_admin) return json({ error: 'Admins only' }, 403);
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
          const res = await env.DB.prepare('INSERT INTO resources (lesson, title, url, note, created_by, created) VALUES (?, ?, ?, ?, ?, ?)').bind(key, title, url, note || null, u.id, Date.now()).run();
          return json({ resource: { id: res.meta.last_row_id, title, url, note: note || null } });
        }
        {
          const mr = /^\/api\/admin\/resources\/(\d+)$/.exec(path);
          if (mr && m === 'DELETE') {
            await env.DB.prepare('DELETE FROM resources WHERE id = ?').bind(Number(mr[1])).run();
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
              env.DB.prepare('DELETE FROM video_notes WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM comments WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM comment_likes WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM enrollments WHERE user_id = ?').bind(id),
              env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
            ]);
            return json({ ok: true });
          }
        }
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      const dup = String(e).includes('UNIQUE');
      return json({ error: dup ? 'That email already exists' : 'Server error' }, dup ? 409 : 500);
    }
  }
};
