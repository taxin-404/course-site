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

// The course structure comes from the bucket: folders = sections, lessons = HLS folders (index.m3u8)
let cache = { at: 0, data: null };
const NUM = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const mp4Ok = (env, key) => env.ALLOW_MP4 === '1' && /\.(mp4|webm)$/i.test(key);
async function listCourse(env) {
  if (cache.data && Date.now() - cache.at < 60000) return cache.data;
  const keys = []; let cursor;
  do {
    const r = await env.VIDEOS.list({ cursor, limit: 1000 });
    keys.push(...r.objects.map((o) => o.key)); cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  const secs = new Map();
  for (const key of keys) {
    const hls = key.endsWith('.m3u8'), pdf = /\.pdf$/i.test(key);
    if (!hls && !pdf && !mp4Ok(env, key)) continue;
    const parts = key.split('/'); const file = parts.pop();
    const title = hls ? parts.pop() || 'Lesson' : file.replace(/\.[^.]+$/, '');
    const section = parts.join(' / ') || 'Lessons';
    if (!secs.has(section)) secs.set(section, []);
    secs.get(section).push({ id: key, title, kind: pdf ? 'pdf' : 'video' });
  }
  const data = [...secs].sort((a, b) => NUM.compare(a[0], b[0])).map(([title, lessons]) => ({ title, lessons: lessons.sort((a, b) => NUM.compare(a.title, b.title)) }));
  cache = { at: Date.now(), data };
  return data;
}

async function serve(req, env, key) {
  const ok = /\.(m3u8|ts|pdf)$/i.test(key) || mp4Ok(env, key);
  if (!ok || req.headers.get('sec-fetch-dest') === 'document') return json({ error: 'Not allowed' }, 403);
  const obj = await env.VIDEOS.get(key, { range: req.headers });
  if (!obj) return json({ error: 'File not found' }, 404);
  const types = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm' };
  const h = new Headers();
  h.set('content-type', types[key.split('.').pop().toLowerCase()]);
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'private, no-store');
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
        return json((await listCourse(env)).map((s) => ({ title: s.title, lessons: s.lessons.map((l) => ({ ...l, done: w.has(l.id) })) })));
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
