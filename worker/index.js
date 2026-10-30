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
  return env.DB.prepare('SELECT id, email, is_admin FROM users WHERE id = ?').bind(d.uid).first();
}
async function sessionCookie(uid, env) {
  const p = b64(enc.encode(JSON.stringify({ uid, exp: Date.now() + 7 * 864e5 })));
  return `s=${p}.${await hmac(env.SESSION_SECRET, p)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS watched (user_id INTEGER NOT NULL, lesson TEXT NOT NULL, PRIMARY KEY (user_id, lesson))',
];
let ready;
const ensureSchema = (env) => (ready ||= env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => { ready = null; throw e; }));

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

async function serve(req, env, key) {
  const ok = /\.(m3u8|ts|pdf|mp4|webm|mkv|mov|avi|m4v)$/i.test(key);
  if (!ok || req.headers.get('sec-fetch-dest') === 'document') return json({ error: 'Not allowed' }, 403);
  const obj = await env.VIDEOS.get(key, { range: req.headers });
  if (!obj) return json({ error: 'File not found' }, 404);
  const h = new Headers();
  h.set('content-type', MEDIA_TYPES[key.split('.').pop().toLowerCase()] || 'application/octet-stream');
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', /\.pdf$/i.test(key) ? 'private, max-age=3600' : 'private, no-store');
  h.set('x-content-type-options', 'nosniff');
  h.set('content-disposition', 'inline');
  let status = 200;
  if (obj.range && req.headers.has('range')) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    h.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set('content-length', String(length));
    status = 206;
  } else h.set('content-length', String(obj.size));
  return new Response(obj.body, { status, headers: h });
}

export default {
  async fetch(req, env) {
    const { pathname: path } = new URL(req.url);
    const m = req.method;
    try {
      await ensureSchema(env);
      if (path === '/api/setup' && m === 'POST') {
        const n = await env.DB.prepare('SELECT COUNT(*) c FROM users').first();
        if (n.c > 0 || req.headers.get('x-setup-key') !== env.SETUP_KEY) return json({ error: 'Forbidden' }, 403);
        const { email, password } = await req.json();
        await env.DB.prepare('INSERT INTO users (email, pass, is_admin) VALUES (?, ?, 1)').bind(email.toLowerCase(), await hashPw(password)).run();
        return json({ ok: true });
      }
      if (path === '/api/login' && m === 'POST') {
        const { email, password } = await req.json();
        const u = await env.DB.prepare('SELECT id, pass FROM users WHERE email = ?').bind(String(email).toLowerCase()).first();
        if (!u || !(await checkPw(String(password), u.pass))) return json({ error: 'Wrong email or password' }, 401);
        return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(u.id, env) });
      }
      if (path === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': 's=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });

      const u = await getUser(req, env);
      if (!u) return json({ error: 'Not logged in' }, 401);

      if (path === '/api/me') return json(u);
      if (path === '/api/course') {
        const w = new Set((await env.DB.prepare('SELECT lesson FROM watched WHERE user_id = ?').bind(u.id).all()).results.map((r) => r.lesson));
        return json((await listCourse(env)).map((c) => ({
          title: c.title,
          sections: c.sections.map((s) => ({
            title: s.title,
            lessons: s.lessons.map((l) => ({ ...l, done: w.has(l.id) })),
          })),
        })));
      }
      if (path.startsWith('/api/media/')) return serve(req, env, decodeURIComponent(path.slice(11)));
      if (path === '/api/progress' && m === 'POST') {
        const { lesson, done } = await req.json();
        await env.DB.prepare(done ? 'INSERT OR IGNORE INTO watched (user_id, lesson) VALUES (?, ?)' : 'DELETE FROM watched WHERE user_id = ? AND lesson = ?').bind(u.id, lesson).run();
        return json({ ok: true });
      }
      if (path === '/api/admin/users' && m === 'POST') {
        if (!u.is_admin) return json({ error: 'Admins only' }, 403);
        const b = await req.json();
        await env.DB.prepare('INSERT INTO users (email, pass) VALUES (?, ?)').bind(b.email.toLowerCase(), await hashPw(b.password)).run();
        return json({ ok: true });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      const dup = String(e).includes('UNIQUE');
      return json({ error: dup ? 'That email already exists' : 'Server error' }, dup ? 409 : 500);
    }
  },
};
