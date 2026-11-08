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
const courseOf = (key) => String(key).split('/')[0];

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const bad = (error, status = 400) => json({ error }, status);

/** The reserved folder whose files are shared with every lesson beneath it. */
export const RESOURCE_DIR = 'resource';

/** True when a single path segment names the reserved folder. */
export const isReservedDir = (name) => String(name).toLowerCase() === RESOURCE_DIR;

/** True when any `/`-separated segment of a key is the reserved folder. */
export const hasReservedSegment = (key) => String(key).split('/').some(isReservedDir);

/** A key's ancestor folder prefixes, nearest first and excluding the file name. */
export function ancestorScopes(key) {
  const parts = String(key).split('/');
  parts.pop(); // drop the file name
  const out = [];
  while (parts.length) {
    out.push(parts.join('/'));
    parts.pop();
  }
  return out;
}

/** A lesson is a video, PDF, text or Markdown key — the only keys that can carry comments, notes, progress. */
export function isLessonKey(key) {
  if (hasReservedSegment(key)) return false; // shared RESOURCE files are never lessons
  if (/\.ts$/i.test(key)) return false; // HLS segments belong to their index.m3u8
  return /\.(pdf|txt|md|markdown)$/i.test(key) || VIDEO_EXT.test(key);
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
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const entryName = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Folder paths directly under `parent` that exist only because of YouTube lessons. A lesson
 * id is <Course>/<Folder>/…/<name>; the segment right after `parent` is a folder only when
 * the id has at least one more segment after it. `_resources` is never a folder.
 */
export function childDirsFromIds(parent, ids) {
  const prefix = parent ? parent + '/' : '';
  const out = new Set();
  for (const raw of ids) {
    const id = String(raw);
    if (!id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue; // a lesson directly in `parent`, not a folder
    const seg = rest.slice(0, slash);
    if (seg === '_resources' || seg === '_notes' || isReservedDir(seg)) continue;
    out.add(parent ? parent + '/' + seg : seg);
  }
  return [...out];
}

async function orderPositions(env) {
  const rows = (await env.DB.prepare('SELECT path, position FROM content_order').all()).results || [];
  return new Map(rows.map((r) => [String(r.path), Number(r.position)]));
}

/**
 * Everything that shares one parent folder: sub-folders, files and YouTube lessons.
 * `rank` is the default order used when an item has no saved position: folders first,
 * then files, then YouTube lessons (each group by name).
 */
async function siblings(env, parent) {
  const prefix = base(parent);
  const out = [];
  const seen = new Set();
  let cursor;
  do {
    const r = await env.RESOURCES.list({ prefix, delimiter: '/', cursor, limit: 1000 });
    for (const p of r.delimitedPrefixes || []) {
      const full = p.replace(/\/$/, '');
      const name = entryName(full);
      if (!name || name === '_resources' || name === '_notes') continue;
      out.push({ path: full, name, rank: 0 });
      seen.add(full);
    }
    for (const o of r.objects) {
      const name = o.key.slice(prefix.length);
      if (!name || name.includes('/') || name === '.keep') continue;
      if (!parent) continue; // root-level strays are not course entries
      if (/\.(ts|vtt)$/i.test(name)) continue;
      out.push({ path: o.key, name, rank: 1 });
      seen.add(o.key);
    }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  const rows = (await env.DB.prepare('SELECT id FROM youtube_lessons').all()).results || [];
  for (const row of rows) {
    const id = String(row.id);
    if (seen.has(id) || parentOf(id) !== parent) continue;
    out.push({ path: id, name: entryName(id), rank: 2 });
    seen.add(id);
  }
  // Sections implied by YouTube lessons (rank 0: they are folders), so setEntryPosition
  // finds them and renumbers the whole folder including them.
  for (const path of childDirsFromIds(parent, rows.map((r) => String(r.id)))) {
    if (seen.has(path)) continue;
    out.push({ path, name: entryName(path), rank: 0 });
    seen.add(path);
  }
  return out;
}

const compareEntries = (positions) => (a, b) => {
  const pa = positions.get(a.path);
  const pb = positions.get(b.path);
  if (pa != null && pb != null) return pa - pb || a.rank - b.rank || NUM.compare(a.name, b.name);
  if (pa != null) return -1;
  if (pb != null) return 1;
  return a.rank - b.rank || NUM.compare(a.name, b.name);
};

/** One folder's contents: sub-folders and files, with .keep and HLS segments hidden. */
async function listFolder(env, prefix) {
  const dirs = [];
  const files = [];
  let cursor;
  do {
    const r = await env.RESOURCES.list({ prefix: base(prefix), delimiter: '/', cursor, limit: 1000 });
    for (const p of r.delimitedPrefixes || []) {
      const full = p.replace(/\/$/, '');
      const last = full.split('/').pop();
      if (!full || last === '_resources' || last === '_notes') continue;
      dirs.push({ name: last, path: full });
    }
    for (const o of r.objects) {
      const name = o.key.slice(base(prefix).length);
      if (!name || name.includes('/') || name === '.keep') continue;
      if (!prefix) continue; // root-level strays are not lessons and cannot be managed here
      if (/\.(ts|vtt)$/i.test(name)) continue; // parts of the HLS lesson, not rows of their own
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

  // Folders that exist only as YouTube lessons (no R2 prefix) still belong in the listing,
  // so the file view matches the student course view. A real R2 folder of the same path wins.
  const seen = new Set(dirs.map((d) => d.path));
  const ids = ((await env.DB.prepare('SELECT id FROM youtube_lessons').all()).results || []).map((r) => String(r.id));
  for (const path of childDirsFromIds(prefix, ids)) {
    if (seen.has(path)) continue;
    const name = entryName(path);
    if (!name) continue;
    dirs.push({ name, path });
    seen.add(path);
  }

  const positions = await orderPositions(env);
  const cmp = compareEntries(positions);
  dirs.sort((a, b) => cmp({ path: a.path, name: a.name, rank: 0 }, { path: b.path, name: b.name, rank: 0 }));
  files.sort((a, b) => cmp({ path: a.key, name: a.name, rank: 1 }, { path: b.key, name: b.name, rank: 1 }));

  // The admin UI merges folders, files and YouTube lessons into one positioned list, so
  // send the saved numbers for every entry in this folder (not just the R2 ones).
  const order = {};
  for (const d of dirs) if (positions.has(d.path)) order[d.path] = positions.get(d.path);
  for (const f of files) if (positions.has(f.key)) order[f.key] = positions.get(f.key);
  for (const row of (await env.DB.prepare('SELECT id FROM youtube_lessons').all()).results || []) {
    const id = String(row.id);
    if (parentOf(id) === prefix && positions.has(id)) order[id] = positions.get(id);
  }

  return {
    path: prefix,
    dirs: dirs.map((d) => ({ ...d, position: positions.get(d.path) ?? null })),
    files: files.map((f) => ({ ...f, position: positions.get(f.key) ?? null })),
    order,
  };
}

/**
 * Set one entry's position inside its folder. The whole folder is renumbered 1..N so
 * positions stay compact and there are never duplicate numbers. A null/empty position
 * clears just that entry and falls back to the default order.
 */
async function setEntryPosition(env, rawPath, rawPosition, hooks) {
  const path = cleanPath(rawPath);
  if (path === null || !path) return bad('That name is not valid');
  const parent = parentOf(path);
  const entries = await siblings(env, parent);
  const entry = entries.find((e) => e.path === path);
  if (!entry) return bad('That item no longer exists', 404);

  if (rawPosition === null || rawPosition === undefined || rawPosition === '') {
    await env.DB.prepare('DELETE FROM content_order WHERE path = ?').bind(path).run();
    hooks.invalidate();
    return json({ ok: true, path, position: null });
  }
  const position = Number(rawPosition);
  if (!Number.isInteger(position) || position < 1 || position > 9999) {
    return bad('Position must be a whole number from 1 to 9999');
  }

  const positions = await orderPositions(env);
  const ordered = entries.slice().sort(compareEntries(positions));
  const rest = ordered.filter((e) => e.path !== path);
  const at = Math.min(Math.max(position, 1), rest.length + 1) - 1;
  rest.splice(at, 0, entry);

  await runChunks(env, rest.map((e, i) => env.DB.prepare(
    'INSERT INTO content_order (path, position) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET position = excluded.position',
  ).bind(e.path, i + 1)));
  hooks.invalidate();
  return json({
    ok: true, path, position: at + 1,
    order: Object.fromEntries(rest.map((e, i) => [e.path, i + 1])),
  });
}

/** Keeps saved positions attached to entries when a file or folder is renamed/moved. */
async function orderMoveStatements(env, from, to, single) {
  const rows = (await env.DB.prepare('SELECT path, position FROM content_order').all()).results || [];
  const out = [];
  for (const row of rows) {
    const p = String(row.path);
    const inside = single ? p === from : (p === from || p.startsWith(from + '/'));
    if (!inside) continue;
    const next = to + p.slice(from.length);
    out.push(env.DB.prepare('INSERT OR REPLACE INTO content_order (path, position) VALUES (?, ?)').bind(next, Number(row.position)));
    out.push(env.DB.prepare('DELETE FROM content_order WHERE path = ?').bind(p));
  }
  // A number only means something among its siblings; after a real move (not a rename)
  // the entry falls back to the default order until the admin gives it a new number.
  if (parentOf(from) !== parentOf(to)) {
    out.push(env.DB.prepare('DELETE FROM content_order WHERE path = ?').bind(to));
  }
  return out;
}

/** A folder's YouTube lessons are D1 rows, so a folder move has to carry them too. */
async function youtubeMoveStatements(env, from, to) {
  // Match the folder's subtree as a plain range (from/ <= id < from0) instead of LIKE: D1
  // rejects a LIKE pattern longer than ~50 chars with "LIKE or GLOB pattern too complex", and
  // a long or unicode section name plus its parent prefix exceeds that easily.
  const rows = (await env.DB.prepare(
    'SELECT id, yt, created FROM youtube_lessons WHERE id >= ? AND id < ?',
  ).bind(from + '/', from + '0').all()).results || [];
  return rows.flatMap((row) => {
    const id = String(row.id);
    const next = to + id.slice(from.length);
    return [
      env.DB.prepare('INSERT OR REPLACE INTO youtube_lessons (id, yt, created) VALUES (?, ?, ?)')
        .bind(next, row.yt, row.created),
      env.DB.prepare('DELETE FROM youtube_lessons WHERE id = ?').bind(id),
    ];
  });
}

// ---- Moving and renaming ----
//
// Order matters: copy, rewrite the rows, then delete the originals. A failure after the old
// objects are gone would orphan student data, so the delete is last and the whole thing is
// safe to run twice (an identical copy at the target is treated as already done).

export const LESSON_ROWS = [
  'UPDATE comments SET lesson = ? WHERE lesson = ?',
  'UPDATE OR REPLACE video_notes SET lesson = ? WHERE lesson = ?',
  'UPDATE OR REPLACE pdf_notes SET lesson = ? WHERE lesson = ?',
  'UPDATE OR REPLACE note_assets SET lesson = ? WHERE lesson = ?',
  'UPDATE OR REPLACE watched SET lesson = ? WHERE lesson = ?',
  'UPDATE resources SET lesson = ? WHERE lesson = ?',
  'UPDATE resources SET file_key = ? WHERE file_key = ?',
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
  if (!objects.length) {
    // A folder can exist as YouTube lessons alone (no R2 objects). It is still movable: the
    // move carries its rows via youtubeMoveStatements / orderMoveStatements below. Anything
    // with neither objects nor YouTube rows is genuinely missing.
    const yt = await env.DB.prepare(
      'SELECT COUNT(*) n FROM youtube_lessons WHERE id >= ? AND id < ?',
    ).bind(from + '/', from + '0').first();
    if (!(yt && Number(yt.n) > 0)) return bad('Not found', 404);
  }
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

  // A destination that already holds unrelated objects would be merged into, not replaced.
  // A partial or complete copy left by an interrupted attempt is allowed, so running the
  // same move again simply finishes it; the per-object check below still refuses a
  // destination key whose copy differs.
  const destKeys = new Set(pairs.map((p) => p.to));
  // A resource PDF belongs to a course folder, so a lesson that crosses courses needs its
  // PDFs copied into the destination course's _resources folder too. Course renames already
  // carry them as ordinary objects, so destKeys keeps this from adding duplicates.
  for (const p of [...pairs]) {
    if (!isLessonKey(p.from) || !isLessonKey(p.to) || courseOf(p.from) === courseOf(p.to)) continue;
    const rows = await env.DB.prepare('SELECT file_key FROM resources WHERE lesson = ? AND file_key IS NOT NULL').bind(p.from).all();
    for (const row of rows.results || []) {
      const toKey = `${courseOf(p.to)}/_resources/${row.file_key.split('/').pop()}`;
      if (destKeys.has(toKey)) continue;
      pairs.push({ from: row.file_key, to: toKey });
      destKeys.add(toKey);
    }
  }
  const targetObjects = await listAll(env, to + '/');
  if (targetObjects.some((o) => !destKeys.has(o.key))) return bad('Something already exists at ' + to, 409);
  // YouTube lessons are rows, not objects, so the R2 check above cannot see them. A fresh
  // folder move into a folder that already holds lessons would overwrite/merge them; refuse.
  // A retry after the rows already moved has no source rows left, so it is allowed to finish
  // deleting the old objects.
  if (!single) {
    const sourceYt = await env.DB.prepare(
      'SELECT COUNT(*) n FROM youtube_lessons WHERE id >= ? AND id < ?',
    ).bind(from + '/', from + '0').first();
    const destYt = await env.DB.prepare(
      'SELECT COUNT(*) n FROM youtube_lessons WHERE id = ? OR (id >= ? AND id < ?)',
    ).bind(to, to + '/', to + '0').first();
    if (Number(sourceYt && sourceYt.n) > 0 && Number(destYt && destYt.n) > 0) {
      return bad('Something already exists at ' + to, 409);
    }
  }
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
      await env.RESOURCES.put(p.to, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
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
    statements.push(env.DB.prepare('UPDATE OR REPLACE course_meta SET course = ? WHERE course = ?').bind(to, from));
  }
  if (!single) statements.push(...(await youtubeMoveStatements(env, from, to)));
  statements.push(...(await orderMoveStatements(env, from, to, !!single)));
  try {
    await runChunks(env, statements);
  } catch (e) {
    // Some batches may have committed, so deleting the copies would detach the rows that
    // already point at them. Keep both copies and let the same move finish the work.
    hooks.invalidate();
    return bad('The files were copied, but some lesson records could not be updated. Run the same move again to finish it. ' + (e && e.message ? e.message : e), 500);
  }

  hooks.invalidate();
  // Delete every source, including ones whose target copy already existed (a retry after an
  // interrupted move), so the move really finishes instead of leaving two copies behind.
  const olds = pairs.map((p) => p.from);
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
  'DELETE FROM note_assets WHERE lesson = ?',
  'DELETE FROM watched WHERE lesson = ?',
  'DELETE FROM resources WHERE lesson = ?',
];

// The rows can outlive the objects if a delete is interrupted between the two steps, so a
// retry must find lesson keys in D1 as well as in the bucket. Table names are constants.
const LESSON_TABLES = ['comments', 'video_notes', 'pdf_notes', 'note_assets', 'watched', 'resources'];

async function lessonKeysUnder(env, p, single) {
  if (single) return isLessonKey(p) ? [p] : [];
  const seen = new Set();
  for (const table of LESSON_TABLES) {
    const r = await env.DB.prepare(`SELECT DISTINCT lesson FROM ${table}`).all();
    for (const row of r.results || []) {
      // `single` is unknown once a file's object is already gone, so match the key itself
      // as well as everything under a folder prefix.
      if (typeof row.lesson === 'string' && (row.lesson === p || row.lesson.startsWith(p + '/'))) seen.add(row.lesson);
    }
  }
  return [...seen];
}

async function deleteEntry(env, rawPath, hooks) {
  const p = cleanPath(rawPath);
  if (p === null || !p) return bad('That name is not valid');

  const single = await env.RESOURCES.head(p);
  const objects = single ? [single] : await listAll(env, p + '/');
  if (objects.length > 5000) return bad('That folder holds too many files to delete in one go', 413);

  const keys = objects.map((o) => o.key);
  const lessons = new Set([...keys.filter(isLessonKey), ...(await lessonKeysUnder(env, p, single))]);
  // Resource PDFs live outside the lesson keys, so deleting their lesson must take them too.
  for (const lessonKey of [...lessons]) {
    const rows = await env.DB.prepare('SELECT file_key FROM resources WHERE lesson = ? AND file_key IS NOT NULL').bind(lessonKey).all();
    for (const row of rows.results || []) {
      if (!keys.includes(row.file_key)) keys.push(row.file_key);
      lessons.add(row.file_key);
    }
  }
  // Pasted note images live under `_notes/<user>/<asset>`, outside the lesson keys. Remember
  // which ones these lessons reference so their R2 objects can be dropped after the rows go.
  const assetRows = [];
  for (const lessonKey of lessons) {
    const rows = await env.DB.prepare('SELECT user_id, asset_id FROM note_assets WHERE lesson = ?').bind(lessonKey).all();
    assetRows.push(...(rows.results || []));
  }
  // A folder that holds only YouTube lessons has no R2 keys and no student-data rows, so
  // the guard below would 404 it. Its `youtube_lessons` rows are the "something is here".
  const yt = await env.DB.prepare(
    'SELECT COUNT(*) n FROM youtube_lessons WHERE id = ? OR (id >= ? AND id < ?)',
  ).bind(p, p + '/', p + '0').first();
  if (!keys.length && !lessons.size && !yt.n) {
    if (p.includes('/') || single) return bad('Not found', 404);
    // A course row can outlive a partial cleanup: enrollments and course_meta are separate
    // batches, so a failed delete can leave one behind. Treat either as "something is still
    // here to clean" and let the statements below finish, instead of 404-ing on a retry.
    const known = await env.DB.prepare(
      'SELECT 1 FROM enrollments WHERE course = ? UNION SELECT 1 FROM course_meta WHERE course = ? LIMIT 1',
    ).bind(p, p).first();
    if (!known) return bad('Not found', 404);
  }

  try {
    for (let i = 0; i < keys.length; i += 1000) await env.RESOURCES.delete(keys.slice(i, i + 1000));
  } catch (e) {
    return bad('Could not delete the files: ' + (e && e.message ? e.message : e), 500);
  }

  const statements = [...lessons].flatMap((k) => LESSON_DELETES.map((sql) => env.DB.prepare(sql).bind(k)));
  // A deleted course must not keep granting access to nothing, nor keep a description.
  if (!single && !p.includes('/')) {
    statements.push(env.DB.prepare('DELETE FROM enrollments WHERE course = ?').bind(p));
    statements.push(env.DB.prepare('DELETE FROM course_meta WHERE course = ?').bind(p));
  }
  // Saved positions go with the entry and, for a folder, with everything under it.
  // A folder prefix is matched as a range (p/ <= path < p0) instead of LIKE: D1's batch
  // endpoint rejects an ESCAPE'd LIKE pattern with "LIKE or GLOB pattern too complex",
  // even though the identical statement runs fine on its own.
  statements.push(env.DB.prepare('DELETE FROM content_order WHERE path = ? OR (path >= ? AND path < ?)').bind(p, p + '/', p + '0'));
  // A folder's YouTube lessons are D1 rows too; leaving them behind would make the deleted
  // folder (or course) reappear with its lessons intact.
  statements.push(env.DB.prepare('DELETE FROM youtube_lessons WHERE id = ? OR (id >= ? AND id < ?)').bind(p, p + '/', p + '0'));
  try {
    await runChunks(env, statements);
  } catch (e) {
    return bad('The files are gone, but some records could not be cleaned up. Run the delete again to finish it. ' + (e && e.message ? e.message : e), 500);
  }

  // The note_assets rows are gone now; drop the images no other lesson of that user still uses.
  await dropNoteAssetObjects(env, assetRows).catch(() => {});
  hooks.invalidate();
  return json({ ok: true, deleted: keys.length, cleaned: lessons.size });
}

/** After note_assets rows are deleted, remove the R2 objects no other lesson still references. */
async function dropNoteAssetObjects(env, rows) {
  const keys = [];
  for (const row of rows) {
    const still = await env.DB.prepare('SELECT 1 x FROM note_assets WHERE user_id = ? AND asset_id = ? LIMIT 1').bind(row.user_id, row.asset_id).first();
    if (!still) keys.push(`_notes/${row.user_id}/${row.asset_id}`);
  }
  if (keys.length) await env.RESOURCES.delete([...new Set(keys)]);
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

const DESC_MAX = 2000;
/** Reads the stored description for one course, whether or not it is listed as a course yet. */
async function getCourseDescription(env, rawCourse) {
  const course = cleanPath(rawCourse);
  if (course === null || !course || course.includes('/')) return bad('That is not a course name');
  const row = await env.DB.prepare('SELECT description FROM course_meta WHERE course = ?').bind(course).first();
  return json({ course, description: row ? String(row.description) : '' });
}
/** Sets (or clears) the description shown for a course, keyed by its top-level folder name. */
async function setCourseDescription(env, rawCourse, rawDescription, hooks) {
  const course = cleanPath(rawCourse);
  if (course === null || !course || course.includes('/')) return bad('That is not a course name');
  const description = typeof rawDescription === 'string'
    ? rawDescription.replace(/\r\n/g, '\n').trim().slice(0, DESC_MAX)
    : '';
  await env.DB.prepare(
    'INSERT INTO course_meta (course, description) VALUES (?, ?) ON CONFLICT(course) DO UPDATE SET description = excluded.description',
  ).bind(course, description).run();
  hooks.invalidate();
  return json({ ok: true, course, description });
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

// A single PUT finishes in the browser with no callback of its own, so the client tells the
// Worker afterwards; otherwise the course tree could stay stale for the cache window.
async function uploadDone(env, rawKey, hooks) {
  const key = uploadKey(rawKey);
  if (!key) return bad('That file name is not valid');
  hooks.invalidate();
  return json({ ok: true });
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

  if (path === '/api/admin/files/order' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return setEntryPosition(env, b.path, b.position, hooks);
  }

  if (path === '/api/admin/files/description' && method === 'GET') {
    return getCourseDescription(env, url.searchParams.get('course'));
  }

  if (path === '/api/admin/files/description' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return setCourseDescription(env, b.course, b.description, hooks);
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
  if (path === '/api/admin/files/upload/done' && method === 'POST') {
    const b = await req.json().catch(() => ({}));
    return uploadDone(env, b.key, hooks);
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