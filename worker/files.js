// Admin file manager: the course tree seen as R2 keys.
//
// The key IS the site structure (see listCourse in index.js), so everything here works on
// keys and never on a separate folder table. Lessons are keys that carry student data;
// folders exist only because keys share a prefix.
//
// handleFiles is mounted inside the /api/admin/ guard, so every route is already admin-only.
import { presign, r2Config, s3Fetch } from './s3.js';

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

// ---- Moving and renaming ----
//
// Order matters: copy, rewrite the rows, then delete the originals. A failure after the old
// objects are gone would orphan student data, so the delete is last and the whole thing is
// safe to run twice (an identical copy at the target is treated as already done).

const LESSON_ROWS = [
  'UPDATE comments SET lesson = ? WHERE lesson = ?',
  'UPDATE OR REPLACE video_notes SET lesson = ? WHERE lesson = ?',
  'UPDATE OR REPLACE pdf_notes SET lesson = ? WHERE lesson = ?',
  'UPDATE OR REPLACE watched SET lesson = ? WHERE lesson = ?',
  'UPDATE resources SET lesson = ? WHERE lesson = ?',
];

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await env.RESOURCES.list({ prefix, cursor, limit: 1000 });
    out.push(...r.objects);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}

async function runChunks(env, statements, size = 50) {
  for (let i = 0; i < statements.length; i += size) {
    await env.DB.batch(statements.slice(i, i + size));
  }
}

async function moveEntry(env, rawFrom, rawTo, hooks) {
  const from = cleanPath(rawFrom);
  const to = cleanPath(rawTo);
  if (from === null || !from || to === null || !to) return bad('That name is not valid');
  if (from === to) return bad('That is the same place');

  const single = await env.RESOURCES.head(from);
  const objects = single ? [single] : await listAll(env, from + '/');
  if (!objects.length) return bad('Not found', 404);
  if (objects.length > 1000) return bad('That folder holds too many files to move in one go', 413);

  if (single) {
    if (!to.includes('/')) return bad('A file must stay inside a course');
    // Moving a lesson to a key the site will not show would hide its notes, comments and
    // progress for good. Deleting is the honest way to remove a lesson.
    if (isLessonKey(from) && !isLessonKey(to)) {
      return bad('A lesson cannot be renamed to a file the site will not show. Delete it instead.');
    }
  } else {
    if (from.includes('/') && !to.includes('/')) return bad('A section must stay inside a course');
    if (!from.includes('/') && to.includes('/')) return bad('A course cannot be moved into another course');
    if (to.startsWith(from + '/')) return bad('A folder cannot move inside itself');
  }

  const pairs = objects.map((o) => ({ from: o.key, to: to + o.key.slice(from.length) }));
  const copies = [];
  for (const p of pairs) {
    const [src, dst] = await Promise.all([env.RESOURCES.head(p.from), env.RESOURCES.head(p.to)]);
    if (!src) return bad('Not found: ' + p.from, 404);
    if (dst) {
      if (dst.size === src.size && dst.etag === src.etag) { p.skip = true; continue; } // a retry
      return bad('Something already exists at ' + p.to, 409);
    }
    copies.push(p);
  }

  const written = [];
  try {
    for (const p of copies) {
      const obj = await env.RESOURCES.get(p.from);
      if (!obj) return bad('Not found: ' + p.from, 404);
      await env.RESOURCES.put(p.to, obj.body, { httpMetadata: obj.httpMetadata });
      written.push(p.to);
    }
  } catch (e) {
    if (written.length) await env.RESOURCES.delete(written).catch(() => {});
    return bad('Could not copy the files: ' + (e && e.message ? e.message : e), 500);
  }

  // Student data follows the lesson key. A course rename takes its enrollments with it;
  // moving a lesson to another course leaves enrollments alone (they are per course).
  const statements = pairs
    .filter((p) => isLessonKey(p.from) && isLessonKey(p.to))
    .flatMap((p) => LESSON_ROWS.map((sql) => env.DB.prepare(sql).bind(p.to, p.from)));
  if (!single && !from.includes('/')) {
    statements.push(env.DB.prepare('UPDATE OR REPLACE enrollments SET course = ? WHERE course = ?').bind(to, from));
  }
  try {
    await runChunks(env, statements);
  } catch (e) {
    if (written.length) await env.RESOURCES.delete(written).catch(() => {});
    return bad('Could not update the lesson records: ' + (e && e.message ? e.message : e), 500);
  }

  hooks.invalidate();
  const olds = pairs.filter((p) => !p.skip).map((p) => p.from);
  try {
    for (let i = 0; i < olds.length; i += 1000) await env.RESOURCES.delete(olds.slice(i, i + 1000));
  } catch {
    // Both copies exist, which the site survives; running the same move again finishes it.
    return json({ ok: true, warning: 'Moved, but the old files could not be removed yet. Run it again.' });
  }
  return json({ ok: true, moved: pairs.length });
}

// ---- Deleting ----

// Replies are rows in `comments` with the same lesson, so one DELETE takes the whole thread.
const LESSON_DELETES = [
  'DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE lesson = ?)',
  'DELETE FROM comments WHERE lesson = ?',
  'DELETE FROM video_notes WHERE lesson = ?',
  'DELETE FROM pdf_notes WHERE lesson = ?',
  'DELETE FROM watched WHERE lesson = ?',
  'DELETE FROM resources WHERE lesson = ?',
];

async function deleteEntry(env, rawPath, hooks) {
  const p = cleanPath(rawPath);
  if (p === null || !p) return bad('That name is not valid');

  const single = await env.RESOURCES.head(p);
  const objects = single ? [single] : await listAll(env, p + '/');
  if (!objects.length) return bad('Not found', 404);
  if (objects.length > 5000) return bad('That folder holds too many files to delete in one go', 413);

  const keys = objects.map((o) => o.key);
  const lessons = keys.filter(isLessonKey);

  for (let i = 0; i < keys.length; i += 1000) await env.RESOURCES.delete(keys.slice(i, i + 1000));

  const statements = lessons.flatMap((k) => LESSON_DELETES.map((sql) => env.DB.prepare(sql).bind(k)));
  // A deleted course must not keep granting access to nothing.
  if (!single && !p.includes('/')) statements.push(env.DB.prepare('DELETE FROM enrollments WHERE course = ?').bind(p));
  try {
    await runChunks(env, statements);
  } catch (e) {
    return bad('The files are gone, but their records could not be cleaned up: ' + (e && e.message ? e.message : e), 500);
  }

  hooks.invalidate();
  return json({ ok: true, deleted: keys.length });
}

// ---- Folders ----
// R2 has no folders: a folder is the shared prefix of keys. A zero-byte `.keep` gives an empty
// one something to exist by; listCourse() ignores it because it is not a video or PDF.
async function createFolder(env, rawPath, hooks) {
  const p = cleanPath(rawPath);
  if (p === null || !p) return bad('That name is not valid');
  const existing = await env.RESOURCES.list({ prefix: p + '/', limit: 1 });
  if (existing.objects.length) return bad('That folder already exists', 409);
  await env.RESOURCES.put(p + '/.keep', new Uint8Array());
  hooks.invalidate();
  return json({ ok: true });
}

// ---- Uploads ----
// The browser uploads straight to R2 with presigned URLs; only the signing and the final
// bookkeeping happen here, so a multi-gigabyte video never passes through the Worker.

const SINGLE_MAX = 16 * 1024 * 1024; // above this the browser must use multipart
const MAX_UPLOAD = 500 * 1024 ** 3;

const unxml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml || '');
  return m ? unxml(m[1]) : '';
};
const escxml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const errText = (xml) => (tag(xml, 'Message') || String(xml || '').replace(/<[^>]*>/g, ' ')).trim().slice(0, 200) || 'no detail';

function uploadKey(rawKey) {
  const key = cleanKey(rawKey);
  return key || null;
}

function uploadSize(raw, max = MAX_UPLOAD) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > max) return null;
  return n;
}

function uploadIdOk(id) {
  // R2 upload ids are long (about 250 characters), so the cap is generous but still bounded.
  return typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[<>&"'\s]/.test(id);
}

async function uploadStart(env, rawKey, rawSize, overwrite) {
  const key = uploadKey(rawKey);
  if (!key) return bad('That file name is not valid');
  if (uploadSize(rawSize) === null) return bad('That file size is not supported');
  if (!r2Config(env)) return bad('Uploads are not configured on this server', 503);
  if (!overwrite && (await env.RESOURCES.head(key))) return bad('A file with that name already exists', 409);

  const r = await s3Fetch(env, 'POST', key, { query: 'uploads' });
  if (!r) return bad('Uploads are not configured on this server', 503);
  const xml = await r.text();
  if (!r.ok) return bad('Could not start the upload: ' + errText(xml), 502);
  const uploadId = tag(xml, 'UploadId');
  if (!uploadId) return bad('R2 did not return an upload id', 502);
  return json({ uploadId, key });
}

async function uploadPartUrl(env, rawKey, uploadId, rawPart) {
  const key = uploadKey(rawKey);
  if (!key) return bad('That file name is not valid');
  if (!uploadIdOk(uploadId)) return bad('That upload is not valid');
  const part = Number(rawPart);
  if (!Number.isInteger(part) || part < 1 || part > 10000) return bad('That part number is not valid');
  const url = await presign(env, 'PUT', key, { query: `partNumber=${part}&uploadId=${encodeURIComponent(uploadId)}` });
  if (!url) return bad('Uploads are not configured on this server', 503);
  return json({ url });
}

async function uploadSingleUrl(env, rawKey, rawSize, overwrite) {
  const key = uploadKey(rawKey);
  if (!key) return bad('That file name is not valid');
  if (uploadSize(rawSize, SINGLE_MAX) === null) return bad('That file is too big for a single request');
  if (!r2Config(env)) return bad('Uploads are not configured on this server', 503);
  if (!overwrite && (await env.RESOURCES.head(key))) return bad('A file with that name already exists', 409);
  const url = await presign(env, 'PUT', key);
  if (!url) return bad('Uploads are not configured on this server', 503);
  return json({ url });
}

async function uploadComplete(env, rawKey, uploadId, parts, hooks) {
  const key = uploadKey(rawKey);
  if (!key) return bad('That file name is not valid');
  if (!uploadIdOk(uploadId)) return bad('That upload is not valid');
  if (!Array.isArray(parts) || !parts.length) return bad('No parts were uploaded');

  const xml = '<CompleteMultipartUpload>' + parts.map((p) => {
    const n = Number(p.partNumber);
    return `<Part><PartNumber>${Number.isInteger(n) ? n : 0}</PartNumber><ETag>${escxml(p.etag)}</ETag></Part>`;
  }).join('') + '</CompleteMultipartUpload>';

  const r = await s3Fetch(env, 'POST', key, {
    query: `uploadId=${encodeURIComponent(uploadId)}`,
    body: xml,
    headers: { 'content-type': 'application/xml' },
  });
  if (!r) return bad('Uploads are not configured on this server', 503);
  const text = await r.text();
  if (!r.ok) return bad('Could not finish the upload: ' + errText(text), 502);
  hooks.invalidate();
  return json({ ok: true });
}

async function uploadAbort(env, rawKey, uploadId) {
  const key = uploadKey(rawKey);
  if (!key) return bad('That file name is not valid');
  if (!uploadIdOk(uploadId)) return bad('That upload is not valid');
  const r = await s3Fetch(env, 'DELETE', key, { query: `uploadId=${encodeURIComponent(uploadId)}` });
  if (!r) return bad('Uploads are not configured on this server', 503);
  if (!r.ok) return bad('Could not cancel the upload', 502);
  return json({ ok: true });
}

async function uploadParts(env, rawKey, url, method) {
  const key = uploadKey(url.searchParams.get('key') || '');
  const uploadId = url.searchParams.get('uploadId') || '';
  if (!key) return bad('That file name is not valid');
  if (!uploadIdOk(uploadId)) return bad('That upload is not valid');
  const r = await s3Fetch(env, 'GET', key, { query: `uploadId=${encodeURIComponent(uploadId)}` });
  if (!r) return bad('Uploads are not configured on this server', 503);
  const xml = await r.text();
  if (!r.ok) {
    // A missing upload is how a reload learns it must start over.
    return bad('That upload no longer exists', 404);
  }
  const parts = [...xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
    partNumber: Number(tag(m[1], 'PartNumber')),
    etag: tag(m[1], 'ETag'),
    size: Number(tag(m[1], 'Size')),
  }));
  return json({ parts });
}

export async function handleFiles(req, env, path, method, url, hooks) {
  if (!path.startsWith('/api/admin/files')) return null;

  if (path === '/api/admin/files' && method === 'GET') {
    const prefix = cleanPath(url.searchParams.get('prefix') || '');
    if (prefix === null) return bad('That folder name is not valid');
    return json(await listFolder(env, prefix));
  }

  if (path === '/api/admin/files/move' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return moveEntry(env, b.from, b.to, hooks);
  }

  if (path === '/api/admin/files/delete' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return deleteEntry(env, b.path, hooks);
  }

  if (path === '/api/admin/files/folder' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return createFolder(env, b.path, hooks);
  }

  if (path === '/api/admin/files/upload/start' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return uploadStart(env, b.key, b.size, b.overwrite);
  }
  if (path === '/api/admin/files/upload/part' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return uploadPartUrl(env, b.key, b.uploadId, b.partNumber);
  }
  if (path === '/api/admin/files/upload/url' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return uploadSingleUrl(env, b.key, b.size, b.overwrite);
  }
  if (path === '/api/admin/files/upload/complete' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return uploadComplete(env, b.key, b.uploadId, b.parts, hooks);
  }
  if (path === '/api/admin/files/upload/abort' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return uploadAbort(env, b.key, b.uploadId);
  }
  if (path === '/api/admin/files/upload/parts' && method === 'GET') {
    return uploadParts(env, null, url, method);
  }

  return bad('Not found', 404);
}