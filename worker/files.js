// Admin file manager: the course tree seen as R2 keys.
//
// The key IS the site structure (see listCourse in index.js), so everything here works on
// keys and never on a separate folder table. Lessons are keys that carry student data;
// folders exist only because keys share a prefix.
//
// handleFiles is mounted inside the /api/admin/ guard, so every route is already admin-only.

const KEY_MAX = 500;
const VIDEO_EXT = /\.(mp4|webm|mkv|mov|avi|m4v|m3u8)$/i;
const NUM = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const bad = (error, status = 400) => json({ error }, status);

/** A lesson is a video or PDF key — the only keys that can carry comments, notes, progress. */
export function isLessonKey(key) {
  if (/\.ts$/i.test(key)) return false; // HLS segments belong to their index.m3u8
  return /\.pdf$/i.test(key) || VIDEO_EXT.test(key);
}

/** Validates a folder prefix. '' is the root; returns null when the path is not usable. */
export function cleanPath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!p) return '';
  if (p.length > KEY_MAX || /^[A-Za-z]:/.test(p)) return null;
  if (p.split('/').some((s) => !s || s === '.' || s === '..')) return null;
  return p;
}

/** Validates an object key: a path that also names a file, so it needs a course segment. */
export function cleanKey(raw) {
  const p = cleanPath(raw);
  if (!p || !p.includes('/')) return null;
  return p;
}

const base = (prefix) => (prefix ? prefix + '/' : '');

/** One folder's contents: sub-folders and files, with .keep and HLS segments hidden. */
async function listFolder(env, prefix) {
  const dirs = [];
  const files = [];
  let cursor;
  do {
    const r = await env.RESOURCES.list({ prefix: base(prefix), delimiter: '/', cursor, limit: 1000 });
    for (const p of r.delimitedPrefixes || []) {
      const full = p.replace(/\/$/, '');
      if (full) dirs.push({ name: full.split('/').pop(), path: full });
    }
    for (const o of r.objects) {
      const name = o.key.slice(base(prefix).length);
      if (!name || name.includes('/') || name === '.keep') continue;
      if (/\.ts$/i.test(name)) continue; // part of an HLS lesson, not its own row
      files.push({
        key: o.key,
        name,
        size: o.size || 0,
        modified: o.uploaded ? new Date(o.uploaded).getTime() : 0,
        lesson: isLessonKey(o.key),
        hls: name === 'index.m3u8',
      });
    }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  dirs.sort((a, b) => NUM.compare(a.name, b.name));
  files.sort((a, b) => NUM.compare(a.name, b.name));
  return { path: prefix, dirs, files };
}

export async function handleFiles(req, env, path, method, url, hooks) {
  if (!path.startsWith('/api/admin/files')) return null;

  if (path === '/api/admin/files' && method === 'GET') {
    const prefix = cleanPath(url.searchParams.get('prefix') || '');
    if (prefix === null) return bad('That folder name is not valid');
    return json(await listFolder(env, prefix));
  }

  return bad('Not found', 404);
}