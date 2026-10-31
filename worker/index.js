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
// The first admin comes from Cloudflare secrets ADMIN_EMAIL + ADMIN_PASSWORD.
// It is created on the first request if missing, and always kept as an admin.
async function seedAdmin(env) {
  const email = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email || !env.ADMIN_PASSWORD) return;
  const u = await env.DB.prepare('SELECT id, is_admin FROM users WHERE email = ?').bind(email).first();
  if (!u) await env.DB.prepare('INSERT INTO users (email, pass, is_admin) VALUES (?, ?, 1)').bind(email, await hashPw(String(env.ADMIN_PASSWORD))).run();
  else if (!u.is_admin) await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(u.id).run();
}
async function migrate(env) {
  const has = await env.DB.prepare("SELECT COUNT(*) c FROM pragma_table_info('users') WHERE name = 'google_sub'").first();
  if (!has.c) await env.DB.prepare('ALTER TABLE users ADD COLUMN google_sub TEXT').run();
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub)').run();
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
      if (path === '/api/config') return json({ googleClientId: env.GOOGLE_CLIENT_ID || '' });
      if (path === '/api/login/google' && m === 'POST') {
        if (!env.GOOGLE_CLIENT_ID) return json({ error: 'Google sign-in is not set up' }, 503);
        const { credential } = await req.json();
        const c = await verifyGoogle(String(credential || ''), env).catch(() => null);
        if (!c) return json({ error: 'Google sign-in failed' }, 401);
        let u = await env.DB.prepare('SELECT id, email, google_sub FROM users WHERE google_sub = ?').bind(c.sub).first();
        if (!u) {
          u = await env.DB.prepare('SELECT id, email, google_sub FROM users WHERE email = ?').bind(c.email.toLowerCase()).first();
          if (!u) return json({ error: 'This Google account has not been invited' }, 403);
          if (u.google_sub && u.google_sub !== c.sub) return json({ error: 'This email is linked to a different Google account' }, 403);
          await env.DB.prepare('UPDATE users SET google_sub = ? WHERE id = ?').bind(c.sub, u.id).run();
        }
        return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(u.id, env) });
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
      if (path.startsWith('/api/admin/')) {
        if (!u.is_admin) return json({ error: 'Admins only' }, 403);
        if (path === '/api/admin/users' && m === 'GET') {
          const rows = (await env.DB.prepare('SELECT u.id, u.email, u.is_admin, (SELECT COUNT(*) FROM watched w WHERE w.user_id = u.id) AS watched, (u.google_sub IS NOT NULL) AS google FROM users u ORDER BY u.is_admin DESC, u.email').all()).results;
          return json(rows.map((r) => ({ ...r, owner: isOwner(env, r.email) })));
        }
        if (path === '/api/admin/users' && m === 'POST') {
          const b = await req.json();
          const email = String(b.email || '').trim().toLowerCase();
          if (!validEmail(email)) return json({ error: 'Enter a valid email' }, 400);
          if (!b.google_only && !validPw(b.password)) return json({ error: 'Password must be 8+ characters' }, 400);
          const pass = b.google_only ? await unusablePw() : await hashPw(b.password);
          await env.DB.prepare('INSERT INTO users (email, pass, is_admin) VALUES (?, ?, ?)').bind(email, pass, b.is_admin ? 1 : 0).run();
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
          return json({ added, skipped });
        }
        const mm = /^\/api\/admin\/users\/(\d+)(?:\/(password|role))?$/.exec(path);
        if (mm) {
          const id = Number(mm[1]);
          const t = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(id).first();
          if (!t) return json({ error: 'User not found' }, 404);
          if (mm[2] === 'password' && m === 'POST') {
            const b = await req.json();
            if (!validPw(b.password)) return json({ error: 'Password must be 8+ characters' }, 400);
            await env.DB.prepare('UPDATE users SET pass = ? WHERE id = ?').bind(await hashPw(b.password), id).run();
            return json({ ok: true });
          }
          if (mm[2] === 'role' && m === 'POST') {
            const b = await req.json();
            if (isOwner(env, t.email) || t.id === u.id) return json({ error: 'You cannot change this admin' }, 400);
            await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(b.is_admin ? 1 : 0, id).run();
            return json({ ok: true });
          }
          if (!mm[2] && m === 'DELETE') {
            if (isOwner(env, t.email) || t.id === u.id) return json({ error: 'You cannot delete this admin' }, 400);
            await env.DB.batch([
              env.DB.prepare('DELETE FROM watched WHERE user_id = ?').bind(id),
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
  },
};
