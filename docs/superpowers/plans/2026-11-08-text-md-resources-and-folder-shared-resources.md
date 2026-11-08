# Text/Markdown support and folder-wide shared resources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support `.txt`/`.md` files as both lesson resources and lessons, show the Discussion/Notes/Resources panel on every lesson kind, and add a reserved `RESOURCE` folder at any depth whose files are shared with every lesson beneath it.

**Architecture:** Broaden the existing `resources.kind` model (`link`/`pdf` → `link`/`pdf`/`txt`/`md`) and the lesson-kind model on the Worker; reuse the current resource/PDF infrastructure and add a small text/Markdown viewer on the SPA. A reserved R2 folder (`RESOURCE`, matched case-insensitively per path segment) is derived at read time from the lesson's ancestor paths — no new table or admin screen; it is managed through the existing Admin → Files uploader.

**Tech Stack:** Cloudflare Worker (ES modules) + D1 + R2; Angular 22 standalone components + signals; Node's built-in test runner (`node --test`, `--experimental-strip-types`).

**Spec:** `docs/superpowers/specs/2026-11-08-text-md-resources-and-folder-shared-resources-design.md`

## Global Constraints

- **No new dependencies.** Implement the Markdown subset by hand; do not add a Markdown library, a sanitizer library or any runtime package.
- **Deploy to `dev` only** until the owner explicitly says "main now". `main` is production; `dev` is the test environment.
- **Never touch secrets.** Do not read or write `.dev.vars`, Worker secrets, or any credential material.
- Keep `npm test`, `npm run typecheck`, `npm run build` and `npm run check:scripts` green after every task.
- Update `docs/CHANGELOG.md` and `docs/HANDOFF.md` (Task 11).
- **Caps:** PDF resources 25 MB; TXT/MD resources 2 MB. (Text *lessons* are not capped — the spec caps only resources, §5/§11. Ruling F11.)
- **Reserved folder name is exactly `RESOURCE`, matched case-insensitively per path segment.** `resource` and `Resource` also match; `my-resources`, `RESOURCES2` do not.
- **`.markdown` is treated as kind `md` everywhere** (resources, lessons, serving). `.text` is treated as `txt`.
- **Every PDF is annotatable** — lesson PDFs, uploaded resource PDFs, and shared `RESOURCE` PDFs. TXT/MD are view-only.
- **Shared resources are read-only for metadata** in the lesson panel (edited in Admin → Files); title is the file name without extension; no per-file note or order.
- **Ordering:** a lesson's own resources first (by `created` ascending), then shared ones nearest-scope-first, natural key order within a scope.
- **Picker note (reconciliation):** spec §7.1 says the resource toggle becomes "Link · File". The owner's original requirement was a **four-kind picker (Link · PDF · TXT · MD)**. Implement the four-kind picker: functionally it still uploads one file and derives its kind, but each file kind narrows the input's `accept` and the server validates the extension. This is the only intentional deviation from the spec wording; note it in `docs/HANDOFF.md` (Task 11).

## Review Focus

Inputs/conditions the spec implies but does not spell out. Each gets a test in the owning task.

1. **A folder name that merely contains a reserved word** (`my-resources/`, `RESOURCES/`, `resource2/`) is ordinary content and shares nothing — matching is per whole segment, case-insensitive. Test in Task 5.
2. **An unenrolled student** requesting a shared `RESOURCE` PDF through `/api/media/.../RESOURCE/x.pdf` must get 403 from the existing enrollment gate. Test in Task 7.
3. **An invented key** (`<Course>/RESOURCE/does-not-exist.pdf`) must not become an annotation target — `/api/notes` and `/api/note-asset` return 404 unless the object really exists; a real one round-trips notes for an enrolled student. Test in Task 7.
4. **Hostile or oversized "text"** — a body containing a NUL byte, a body over 2 MB, and a `.markdown` file all behave predictably (reject, reject, map to `md`); rendered Markdown must escape a `<script>` in file content. Tests in Task 1 and Task 4.
5. **`RESOURCE` files never become lessons** — `listCourse`, `isLessonKey` and the file-manager listing must not surface a shared file as a lesson carrying comments/notes/progress. Tests in Tasks 2, 3 and 6.
6. **A stalled D1 query** during the resources read must answer 503 and log `dbTimeout` — the read path added here must stay under the existing per-query deadline instead of hanging the request. Test in Task 5.

---

### Task 1: Safe Markdown renderer

**Files:**
- Create: `src/app/markdown.ts`
- Test: `src/app/markdown.test.mjs`

**Interfaces:**
- Produces: `export function renderMarkdown(src: string): string` — returns an HTML string, escaping all HTML first, then rendering a small subset. Pure, no dependency, no raw-HTML passthrough.

- [ ] **Step 1: Write the failing test**

`src/app/markdown.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.ts';

test('markdown escapes HTML before rendering anything', () => {
  const out = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!out.includes('<script'));
  assert.match(out, /&lt;script&gt;/);
});

test('markdown renders headings, lists, fences and emphasis', () => {
  const out = renderMarkdown('# Title\n\n- one\n- two\n\n```\ncode & <b>\n```\n\n**bold** and *italic* and `x<y`');
  assert.match(out, /<h1[^>]*>Title<\/h1>/);
  assert.match(out, /<ul>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>[\s\S]*<\/ul>/);
  assert.match(out, /<pre><code>[\s\S]*code &amp; &lt;b&gt;[\s\S]*<\/code><\/pre>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
  assert.match(out, /<code>x&lt;y<\/code>/);
});

test('markdown links allow only http/https and set rel/target', () => {
  const ok = renderMarkdown('[site](https://example.com/a)');
  assert.match(ok, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">site<\/a>/);
  const bad = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!bad.includes('href') && !bad.includes('<a '));
  assert.match(bad, /\[x\]\(javascript:alert\(1\)\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test src/app/markdown.test.mjs`
Expected: FAIL — cannot resolve `./markdown.ts` / `renderMarkdown is not a function`.

- [ ] **Step 3: Implement `renderMarkdown` in `src/app/markdown.ts`**

Escape `& < > "` first, then operate on escaped text line by line. Required subset (the floor, per spec §7.2): ATX headings `#`–`######`; fenced code blocks (```); unordered (`-`, `*`, `+`) and ordered (`1.`) lists; blockquotes (`>`); horizontal rules (`---`, `***`); inline `**bold**`, `*italic*`/`_italic_`, `` `code` ``; links `[text](url)` where `url` passes `/^https?:\/\//i` (else leave the literal text). Wrap consecutive non-block lines in `<p>`. Group headings with a `<hN>` tag; add no `id`. No raw-HTML passthrough and no images.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test src/app/markdown.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/markdown.ts src/app/markdown.test.mjs
git commit -m "feat: add a small safe Markdown renderer"
```

---

### Task 2: Reserved-folder helpers and lesson-key kinds

**Files:**
- Modify: `worker/files.js` (exports beside `isLessonKey`, currently ~line 19)
- Test: `worker/files.test.mjs`

**Interfaces:**
- Produces:
  - `export const RESOURCE_DIR = 'resource'`
  - `export const isReservedDir = (name: string): boolean` — `String(name).toLowerCase() === RESOURCE_DIR`
  - `export const hasReservedSegment = (key: string): boolean` — any `/`-separated segment passes `isReservedDir`
  - `export function ancestorScopes(key: string): string[]` — the key's ancestor folder prefixes, **nearest first, excluding the file name**; `ancestorScopes('A/B/C/x.pdf')` → `['A/B/C', 'A/B', 'A']`
  - `isLessonKey(key)` updated: `false` whenever `hasReservedSegment(key)`; otherwise `true` for `.pdf`, `.txt`, `.md`, `.markdown` and video extensions; `false` for `.ts`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `worker/files.test.mjs`:

```js
import { isLessonKey, hasReservedSegment, ancestorScopes, childDirsFromIds } from './files.js';

test('isLessonKey accepts text and markdown lessons but never a shared RESOURCE file', () => {
  assert.equal(isLessonKey('C/lesson.txt'), true);
  assert.equal(isLessonKey('C/lesson.md'), true);
  assert.equal(isLessonKey('C/lesson.markdown'), true);
  assert.equal(isLessonKey('C/clip.ts'), false);
  assert.equal(isLessonKey('C/RESOURCE/syllabus.pdf'), false);
  assert.equal(isLessonKey('C/Module/RESOURCE/x.md'), false);
});

test('hasReservedSegment matches RESOURCE case-insensitively per whole segment', () => {
  assert.equal(hasReservedSegment('C/RESOURCE/x.pdf'), true);
  assert.equal(hasReservedSegment('C/Resource/x.pdf'), true);
  assert.equal(hasReservedSegment('C/resource/x.pdf'), true);
  assert.equal(hasReservedSegment('C/my-resources/x.pdf'), false);
  assert.equal(hasReservedSegment('C/RESOURCES/x.pdf'), false);
});

test('ancestorScopes lists folder prefixes nearest first', () => {
  assert.deepEqual(ancestorScopes('A/B/C/x.pdf'), ['A/B/C', 'A/B', 'A']);
});

test('childDirsFromIds never invents a RESOURCE folder from a YouTube id', () => {
  assert.deepEqual(childDirsFromIds('C', ['C/RESOURCE/x']), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test worker/files.test.mjs`
Expected: FAIL — `hasReservedSegment`/`ancestorScopes` are not exported, and `.txt` is `false`.

- [ ] **Step 3: Implement the helpers and update `isLessonKey` in `worker/files.js`**

Add the four exports near `isLessonKey`. In `isLessonKey`, return `false` first for `hasReservedSegment(key)`, then keep the `.ts` guard, then return `true` for `/\.(pdf|txt|md|markdown)$/i` or `VIDEO_EXT`. In `childDirsFromIds` (currently ~line 55), also skip a segment that `isReservedDir` matches.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test worker/files.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/files.js worker/files.test.mjs
git commit -m "feat: reserved RESOURCE helpers and text lesson keys"
```

---

### Task 3: Text lessons and reserved-folder exclusion in the Worker

**Files:**
- Modify: `worker/index.js` (`MEDIA_TYPES` ~line 384; `serve` ~line 892; `listCourse` ~line 399)
- Test: `worker/resources.test.mjs` (create; this file grows through Tasks 3–4)

**Interfaces:**
- Consumes: `hasReservedSegment` from `./files.js`.
- Produces: `listCourse` emits `{ id, title, kind: 'txt' | 'md' }` for text files; skips any key with a `RESOURCE` segment (and skips it before course registration, like `_notes`).

- [ ] **Step 1: Write the failing test**

`worker/resources.test.mjs` — mirror `worker/security.test.mjs`'s harness (fake `db()`/`r2()`, `worker.fetch`, a seeded owner, `addUser`, `enroll`, `login`, `browser`, `call`). Seed `FILES` with a course:

```js
const FILES = {
  'Course/RESOURCE/syllabus.pdf': '%PDF-1.4\nsyllabus',
  'Course/Module 01/Module 01 - Intro.mp4': new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  'Course/Module 01/guide.md': '# Guide\n\nRead me.',
  'Course/Module 01/notes.txt': 'plain notes',
  'Course/Module 01/clip.ts': new Uint8Array([1, 2, 3]), // HLS segment
};
```

Tests (create a student, `enroll(student, 'Course')` and log in for `cookie`; the catalog route is `/api/course`):

```js
test('listCourse lists text/markdown lessons and skips the RESOURCE folder', async () => {
  const data = await call('/api/course', { headers: { cookie } }).then((r) => r.json());
  const course = data.find((c) => c.title === 'Course');
  const lessons = course.sections.flatMap((s) => s.lessons);
  assert.deepEqual(lessons.filter((l) => l.kind === 'md').map((l) => l.id), ['Course/Module 01/guide.md']);
  assert.deepEqual(lessons.filter((l) => l.kind === 'txt').map((l) => l.id), ['Course/Module 01/notes.txt']);
  assert.ok(!lessons.some((l) => l.id.includes('RESOURCE')), 'shared files are not lessons');
  assert.ok(!lessons.some((l) => l.id.endsWith('clip.ts')), 'HLS segments are not lessons');
});

test('serve returns text and markdown with the right content type', async () => {
  const md = await call('/api/media/Course/Module%2001/guide.md', { headers: browser(cookie) });
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.match(md.headers.get('x-content-type-options'), /nosniff/);
  const txt = await call('/api/media/Course/Module%2001/notes.txt', { headers: browser(cookie) });
  assert.equal(txt.status, 200);
  assert.match(txt.headers.get('content-type'), /text\/plain/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test worker/resources.test.mjs`
Expected: FAIL — text lessons are absent and `.md` is refused by the media allow-list.

- [ ] **Step 3: Implement in `worker/index.js`**

- `MEDIA_TYPES`: add `txt: 'text/plain; charset=utf-8'`, `md: 'text/markdown; charset=utf-8'`, `markdown: 'text/markdown; charset=utf-8'`.
- `serve`: add `txt|md|markdown` to the `ok` regex. Text/Markdown are not video, so they keep the current non-PDF path (no Range required).
- `listCourse`: import and use `hasReservedSegment`; `continue` for such keys **before** the course-registration block (next to the `_notes` skip). Change the file classifier to also accept `/\.(txt|md|markdown)$/i`; set `kind` to `'md'` for `md`/`markdown` and `'txt'` for `txt`/`text`, still `'pdf'`/`'video'` otherwise. In the YouTube-lessons loop, `continue` when `hasReservedSegment(id)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test worker/resources.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/resources.test.mjs
git commit -m "feat: serve txt/md and list text lessons, hide RESOURCE folders"
```

---

### Task 4: File resources become kind-aware

**Files:**
- Modify: `worker/index.js` (resource routes ~lines 1358–1458)
- Test: `worker/resources.test.mjs` (extend)

**Interfaces:**
- Produces:
  - `POST /api/admin/lesson/<key>/resources/file` — accepts `.pdf`, `.txt`, `.md`, `.markdown`; the legacy `.../resources/pdf` stays an alias.
  - `GET /api/lesson/<key>/resources` returns each row's real `kind` (`'link'|'pdf'|'txt'|'md'`) and `url = file_key` for file kinds.
  - `PATCH /api/admin/resources/<id>` edits a URL only when `kind === 'link'`.
  - `DELETE /api/admin/resources/<id>` deletes the object for any file kind and the `pdf_notes` row only for `pdf`.
- Helper: `resourceKindOf(filename: string): 'pdf'|'txt'|'md'|null` (`.text`→`txt`, `.markdown`→`md`).
- Note: the cross-course resource copy in `worker/files.js moveEntry` already names its destination from `row.file_key.split('/').pop()`, so a `.txt`/`.md` resource keeps its extension there — no change needed.

- [ ] **Step 1: Write the failing test**

Extend `worker/resources.test.mjs` (log in as the admin owner to hit `/api/admin/...`):

```js
function fileForm(name, body) {
  const form = new FormData();
  form.append('file', new File([body], name));
  return form;
}

test('a txt resource uploads with kind txt and a .txt file_key', async () => {
  const res = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('cheat.txt', 'plain text') });
  assert.equal(res.status, 200);
  const { resource } = await res.json();
  assert.equal(resource.kind, 'txt');
  assert.match(resource.url, /^Course\/_resources\/[0-9a-f-]+\.txt$/);
});

test('a .markdown resource maps to kind md; the legacy /pdf route still works', async () => {
  const md = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('doc.markdown', '# Doc') });
  assert.equal((await md.json()).resource.kind, 'md');
  const pdf = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/pdf',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('slides.pdf', '%PDF-1.4\nx') });
  assert.equal(pdf.status, 200);
  assert.equal((await pdf.json()).resource.kind, 'pdf');
});

test('text resources reject a NUL byte, an oversized body and an unknown extension', async () => {
  const nul = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('bad.txt', new Uint8Array([65, 0, 66])) });
  assert.equal(nul.status, 400);
  const big = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('big.txt', 'x'.repeat(2 * 1024 * 1024 + 1)) });
  assert.equal(big.status, 413);
  const exe = await call('/api/admin/lesson/Course%2FModule%2001%2Fguide.md/resources/file',
    { method: 'POST', headers: { cookie: adminCookie, origin: ORIGIN }, body: fileForm('run.exe', 'x') });
  assert.equal(exe.status, 400);
});

test('GET reports real kinds; PATCH ignores a url on a file row; DELETE removes the object', async () => {
  const listed = await call('/api/lesson/Course%2FModule%2001%2Fguide.md/resources', { headers: { cookie } });
  const kinds = (await listed.json()).resources.map((r) => r.kind);
  assert.ok(kinds.includes('txt') && kinds.includes('md') && kinds.includes('pdf'));
  const txt = (await listed.json()).resources.find((r) => r.kind === 'txt');
  const patched = await call(`/api/admin/resources/${txt.id}`,
    { method: 'PATCH', headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Cheat sheet', url: 'https://evil.example' }) });
  assert.equal((await patched.json()).resource.url, txt.url, 'the file_key survives a url in the body');
  const key = txt.url;
  const del = await call(`/api/admin/resources/${txt.id}`, { method: 'DELETE', headers: { cookie: adminCookie, origin: ORIGIN } });
  assert.equal(del.status, 200);
  assert.equal(env.RESOURCES.has(key), false, 'the R2 object is gone');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test worker/resources.test.mjs`
Expected: FAIL — `/resources/file` is unrouted, kinds collapse to `'pdf'`/`'link'`, and unknown extensions are rejected only as PDFs.

- [ ] **Step 3: Implement in `worker/index.js`**

- Add `RES_KINDS`/`resourceKindOf` helper.
- Match the upload route on `path.endsWith('/resources/file') || path.endsWith('/resources/pdf')` and slice off the matched suffix. Keep the coarse `content-length > 26 MB` guard. After `formData`, derive `kind` from the file name; reject `null` with `{ error: 'Choose a PDF, text or Markdown file' }` (400). PDF: size cap 25 MB and the `%PDF-` head check. TXT/MD: size cap 2 MB (413) and reject a body containing a NUL byte (400). Title defaults to the file name minus extension, capped 120. Note capped 300. 100-resource cap unchanged. `fileKey = \`${courseOf(key)}/_resources/${crypto.randomUUID()}.${kind}\``; `contentType` per kind (`application/pdf`, `text/plain; charset=utf-8`, `text/markdown; charset=utf-8`). Insert with the real `kind`.
- GET: map `kind` (`pdf`/`txt`/`md`, else `link`) and set `url` to `file_key` for non-`link`.
- PATCH: branch on `row.kind === 'link'` instead of `!== 'pdf'`; response kind mapped the same way.
- DELETE: `SELECT file_key, kind FROM resources WHERE id = ?`; delete the object when `file_key`; `DELETE FROM pdf_notes WHERE lesson = ?` only when `kind === 'pdf'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test worker/resources.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/resources.test.mjs
git commit -m "feat: resource files support pdf, txt and md"
```

---

### Task 5: Shared resources read path

**Files:**
- Modify: `worker/index.js` (`GET /api/lesson/<key>/resources` ~line 1340)
- Test: `worker/shared-resources.test.mjs` (create; grows through Tasks 5–7)

**Interfaces:**
- Consumes: `ancestorScopes`, `hasReservedSegment`, `isReservedDir`, `resourceKindOf`.
- Produces: synthetic shared rows appended after the lesson's own rows:
  `{ id: 'shared:' + fileKey, title: <file name without extension>, url: fileKey, note: null, kind: 'pdf'|'txt'|'md', shared: true, scope: <last segment of the RESOURCE folder's parent> }`, nearest scope first.

- [ ] **Step 1: Write the failing test**

`worker/shared-resources.test.mjs` (same harness). Seed:

```js
const FILES = {
  'Course/RESOURCE/syllabus.pdf': '%PDF-1.4\nsyllabus',
  'Course/Module 01/RESOURCE/cheatsheet.md': '# Cheat',
  'Course/Module 01/Sub/RESOURCE/notes.txt': 'deep notes',
  'Course/Module 01/Sub/01 - Intro.mp4': new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  'Course/Module 02/02 - Setup.mp4': new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
  'Course/Module 01/guide.md': '# Guide\n\nRead me.',   // ordinary (non-shared) lesson file
  'Course/not-resources/local.txt': 'local',            // must NOT be treated as shared (F2)
  'Course/not-resources/guide.pdf': '%PDF-1.4\nnope',
};
```

```js
test('a lesson inherits every ancestor RESOURCE folder, nearest scope first', async () => {
  const res = await call('/api/lesson/Course%2FModule%2001%2FSub%2F01%20-%20Intro.mp4/resources', { headers: { cookie } });
  const shared = (await res.json()).resources.filter((r) => r.shared);
  assert.deepEqual(shared.map((r) => [r.title, r.kind, r.scope]), [
    ['notes', 'txt', 'Sub'],
    ['cheatsheet', 'md', 'Module 01'],
    ['syllabus', 'pdf', 'Course'],
  ]);
});

test('a sibling module inherits only the course-level RESOURCE folder', async () => {
  const res = await call('/api/lesson/Course%2FModule%2002%2F02%20-%20Setup.mp4/resources', { headers: { cookie } });
  const shared = (await res.json()).resources.filter((r) => r.shared);
  assert.deepEqual(shared.map((r) => r.title), ['syllabus']);
});

test('a folder named not-resources is not a RESOURCE folder (F2)', async () => {
  const res = await call('/api/lesson/Course%2Fnot-resources%2Fguide.pdf/resources', { headers: { cookie } });
  const shared = (await res.json()).resources.filter((r) => r.shared);
  // The lesson sits under Course, so it correctly inherits the course-level RESOURCE file.
  // The point: `not-resources` itself is NOT a RESOURCE folder, so nothing from it (local.txt,
  // guide.pdf) is shared and no row carries scope `not-resources`.
  assert.deepEqual(shared.map((r) => [r.title, r.kind, r.scope]), [['syllabus', 'pdf', 'Course']]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test worker/shared-resources.test.mjs`
Expected: FAIL — no shared rows are returned (the lesson's own query returns `[]`).

- [ ] **Step 3: Implement `sharedResourcesFor(env, key)` in `worker/index.js`**

For each `scope` in `ancestorScopes(key)` (nearest first): list `scope + '/'` with `delimiter: '/'`; find the immediate child prefix whose last segment passes `isReservedDir`; recursively list that prefix (`cursor`-paged); for each object whose `resourceKindOf(o.key)` is `pdf`/`txt`/`md`, push a synthetic row. Skip scopes that themselves contain a reserved segment. Append the results to the own rows in `GET /api/lesson/<key>/resources`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test worker/shared-resources.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add a regression test for a D1 timeout on the resources read**

The Worker already runs every query under `guardEnv`/`withDeadline`, so this should pass against the existing guard; the test pins it for the new read path. Using the harness's `db()` adapter as `DB`, import `guardDb` from `./index.js` and build an env whose `DB` stalls only on `FROM resources`:

```js
test('a D1 timeout on the resources read fails cleanly, it does not hang', async () => {
  const { guardDb } = await import('./index.js');
  const hang = () => new Promise(() => {});
  const broken = {
    prepare: (sql) => {
      if (!/FROM resources/.test(sql)) return DB.prepare(sql);
      const stmt = { first: hang, all: hang, run: hang, bind: () => stmt };
      return stmt;
    },
    batch: (stmts) => DB.batch(stmts), // schema bootstrap must still succeed
  };
  const res = await call('/api/lesson/Course%2FModule%2001%2FSub%2F01%20-%20Intro.mp4/resources', {
    headers: { cookie },
    e: { ...env, DB: guardDb(broken, 25) },
  });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'Database temporarily unavailable' });
});
```

- [ ] **Step 6: Run the new test and confirm it passes**

Run: `node --experimental-strip-types --test worker/shared-resources.test.mjs`
Expected: PASS. If it hangs, the read path escaped the deadline — fix that rather than the test.

- [ ] **Step 7: Commit**

```bash
git add worker/index.js worker/shared-resources.test.mjs
git commit -m "feat: share RESOURCE-folder files with every lesson beneath"
```

---

### Task 6: `RESOURCE` is reserved on writes

**Files:**
- Modify: `worker/index.js` (`POST /api/admin/youtube` ~line 1476), `worker/files.js` (`moveEntry` ~line 307; `listFolder` ~line 132)
- Test: `worker/shared-resources.test.mjs` (extend), `worker/files.test.mjs`

**Interfaces:**
- Consumes: `hasReservedSegment`.
- Produces: `/api/admin/youtube` refuses a resulting id with a reserved segment (400); `moveEntry` refuses a destination with a reserved segment unless the source already has one (400); `listFolder` marks files under a `RESOURCE` folder `lesson: false` (already implied by `isLessonKey`) while still listing the folder and its files.

- [ ] **Step 1: Write the failing test**

Extend `worker/shared-resources.test.mjs`:

```js
test('a YouTube lesson cannot be created under RESOURCE', async () => {
  const res = await call('/api/admin/youtube', {
    method: 'POST',
    headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ course: 'Course', folder: 'Module 01/RESOURCE', lesson: 'Extra', link: 'dQw4w9WgXcQ' }),
  });
  assert.equal(res.status, 400);
});

test('moving an entry into RESOURCE is refused, but editing within RESOURCE is allowed', async () => {
  const move = (from, to) => call('/api/admin/files/move', {
    method: 'POST',
    headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  // A lesson file moved into RESOURCE is refused (today by the "must stay a lesson" guard).
  assert.equal((await move('Course/Module 01/guide.md', 'Course/Module 01/RESOURCE/guide.md')).status, 400);
  // F8: a whole section moved into RESOURCE must also be refused by the new reserved-name rule.
  // A folder move skips the lesson guard, so this case genuinely exercises the new guard (and is
  // the real RED: it succeeds today).
  assert.equal((await move('Course/Module 02', 'Course/RESOURCE/Module 02')).status, 400);
  // F7: seed a file inside RESOURCE at test time (the fake R2 bucket has put()) so Task 5's
  // per-scope ordering assertions are not polluted by a second course-level file.
  await env.RESOURCES.put('Course/RESOURCE/extra.txt', 'extra');
  assert.equal((await move('Course/RESOURCE/extra.txt', 'Course/RESOURCE/extra-v2.txt')).status, 200);
});
```

Add to `worker/files.test.mjs`:

```js
test('isLessonKey keeps every RESOURCE file out of lesson handling', () => {
  assert.equal(isLessonKey('C/RESOURCE/syllabus.txt'), false);
  assert.equal(isLessonKey('C/RESOURCE/syllabus.md'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test worker/shared-resources.test.mjs worker/files.test.mjs`
Expected: FAIL — the YouTube POST and the move both succeed today.

- [ ] **Step 3: Implement**

- `worker/index.js` `POST /api/admin/youtube`: after building `id`, `if (hasReservedSegment(id)) return json({ error: 'RESOURCE is a reserved folder name' }, 400);`.
- `worker/files.js` `moveEntry`: after `from`/`to` are validated, `if (hasReservedSegment(to) && !hasReservedSegment(from)) return bad('RESOURCE is a reserved folder name');`. Do not touch folder creation (`cleanPath`), so the owner can still create `RESOURCE`.
- Confirm `listFolder` still shows the `RESOURCE` directory (the `_resources`/`_notes` skip does not include it) and that files inside it come back `lesson: false` via `isLessonKey`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test worker/shared-resources.test.mjs worker/files.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/files.js worker/shared-resources.test.mjs worker/files.test.mjs
git commit -m "feat: reserve the RESOURCE folder name on writes"
```

---

### Task 7: Annotations on shared PDFs

**Files:**
- Modify: `worker/index.js` (`/api/note-asset/` ~line 1157; `/api/notes/` ~line 1205), `worker/files.js` (`moveEntry`, `deleteEntry` ~line 464)
- Test: `worker/shared-resources.test.mjs` (extend)

**Interfaces:**
- Consumes: `hasReservedSegment`.
- Produces: `/api/notes/<key>` and `/api/note-asset/<key>/<id>` accept a `.pdf` key under a `RESOURCE` segment when the R2 object exists; a folder move/rename of a `RESOURCE` PDF carries its `pdf_notes` and `note_assets`; deleting one removes them.

- [ ] **Step 1: Write the failing test**

```js
test('notes round-trip on a real shared PDF and 404 on an invented key', async () => {
  const key = 'Course/RESOURCE/syllabus.pdf';
  const url = '/api/notes/' + encodeURIComponent(key);
  const put = await call(url, {
    method: 'PUT',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ data: [{ id: 'a', page: 1 }] }),
  });
  assert.equal(put.status, 200);
  const get = await call(url, { headers: { cookie } });
  assert.deepEqual((await get.json()).data, [{ id: 'a', page: 1 }]);

  const invented = '/api/notes/' + encodeURIComponent('Course/RESOURCE/does-not-exist.pdf');
  assert.equal((await call(invented, { headers: { cookie } })).status, 404);
});

test('an unenrolled student cannot fetch a shared PDF', async () => {
  const stranger = await addUser();
  const { cookie: strangerCookie } = await login(stranger);
  const res = await call('/api/media/Course/RESOURCE/syllabus.pdf', { headers: browser(strangerCookie) });
  assert.equal(res.status, 403);
});

test('a shared PDF keeps its notes when it is renamed inside RESOURCE', async () => {
  const from = 'Course/RESOURCE/syllabus.pdf';
  await call('/api/notes/' + encodeURIComponent(from), {
    method: 'PUT',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ data: [{ id: 'z', page: 2 }] }),
  });
  const mv = await call('/api/admin/files/move', {
    method: 'POST',
    headers: { cookie: adminCookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: 'Course/RESOURCE/renamed.pdf', kind: 'file' }),
  });
  assert.equal(mv.status, 200);
  const after = await call('/api/notes/' + encodeURIComponent('Course/RESOURCE/renamed.pdf'), { headers: { cookie } });
  assert.deepEqual((await after.json()).data, [{ id: 'z', page: 2 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test worker/shared-resources.test.mjs`
Expected: FAIL — the notes PUT returns 404 (no resource row, not a lesson) and the unenrolled case may not exist yet.

- [ ] **Step 3: Implement**

- `worker/index.js`: add `async function sharedFileExists(env, key)` returning `hasReservedSegment(key) && await env.RESOURCES.head(key)`. Widen both guards:
  - note-asset: `if (!realA && !(await sharedFileExists(env, lesson)) && (await lessonAccess(env, u, lesson)) !== 'ok') return json({ error: 'Not found' }, 404);`
  - notes: same shape with `realFile`.
  The existing `myCourses`/403 checks above each guard already enforce enrollment.
- `worker/files.js` `moveEntry`: for pairs where both keys have a reserved segment and the source is a `.pdf`, push `UPDATE OR REPLACE pdf_notes SET lesson = ? WHERE lesson = ?` and the same for `note_assets` (skip `isLessonKey` pairs, which `LESSON_ROWS` already covers).
- `worker/files.js` `deleteEntry`: after computing `keys`, add each reserved-segment `.pdf` key to the `lessons` set so `LESSON_DELETES` removes its `pdf_notes`/`note_assets` rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test worker/shared-resources.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/files.js worker/shared-resources.test.mjs
git commit -m "feat: annotate shared RESOURCE PDFs"
```

---

### Task 8: API types and the text viewer

**Files:**
- Modify: `src/app/api.ts` (~line 5, 16, 265)
- Create: `src/app/text-viewer.ts`
- Verify: `npm run typecheck`, `npm run build`

**Interfaces:**
- Produces:
  - `export type ResourceKind = 'link' | 'pdf' | 'txt' | 'md'`
  - `export interface ResourceItem { id: number | string; title: string; url: string; note: string | null; kind: ResourceKind; shared?: boolean; scope?: string }`
  - `Lesson.kind: 'video' | 'pdf' | 'txt' | 'md' | 'youtube'`
  - `Api.uploadResourceFile(key, file, title?, note?): Promise<{ resource: ResourceItem }>` posting to `.../resources/file` (replaces `uploadResourcePdf`).
  - `#TextViewer` component: requires `key: string` and `md: boolean`; fetches `api.mediaUrl(key)`, renders `<pre>` for text or `[innerHTML]="renderMarkdown(body)"` for Markdown; shows loading and an error + Retry.
- Consumes: `renderMarkdown` (Task 1), `ResourceKind`/`ResourceItem` (this task).

- [ ] **Step 1: Update `src/app/api.ts`**

Rename the method and its URL tail (`resources/file`); broaden `ResourceItem` and `Lesson`; allow `id` to be `number | string`. Update `LessonHit.kind` in `src/app/app.ts` (~line 12) to add `'txt' | 'md'` so typecheck stays green.

- [ ] **Step 2: Create `src/app/text-viewer.ts`**

Standalone component, `ChangeDetectionStrategy.Eager`, importing nothing new. On `key` change (and on trace of `key`), fetch the media URL; on success store the text body; on failure set an error state with a Retry button. Guard against a stale response with a request sequence, matching `lesson-resources.ts`'s pattern. Escape-first rendering is provided by `renderMarkdown`; the `<pre>` path uses Angular's default text interpolation.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/app/api.ts src/app/app.ts src/app/text-viewer.ts
git commit -m "feat: add API kinds and the text/markdown viewer"
```

---

### Task 9: Resource panel — four-kind picker and shared rows

**Files:**
- Modify: `src/app/lesson-resources.ts`
- Verify: `npm run typecheck`, `npm run build`

**Interfaces:**
- Consumes: `ResourceItem`, `ResourceKind`, `uploadResourceFile` (Task 8), `TextViewer` (Task 8).
- Produces: the resource form and list handle `link`/`pdf`/`txt`/`md` and read-only shared rows.

- [ ] **Step 1: Implement the form and rows**

- Replace the `Link`/`PDF` toggle with a four-kind `seg` group: **Link · PDF · TXT · MD** (`mode: 'link' | 'pdf' | 'txt' | 'md'`). For each file kind, set the file input's `accept` (`pdf` → `application/pdf,.pdf`; `txt` → `text/plain,.txt`; `md` → `text/markdown,.md,.markdown`) and validate the chosen file's extension matches before uploading. Keep the title/note inputs; default the title from the file name minus extension for every file kind.
- `upload()`: choose the cap and message by extension (`pdf` → 25 MB, `txt`/`md` → 2 MB) and call `api.uploadResourceFile(...)`.
- Rows: render by `kind` — `link` → `<a target="_blank">`; `pdf` → the existing `open()` PDF modal; `txt`/`md` → `open()` a modal that renders `TextViewer` instead of `PdfViewer`. A small type label (`PDF`/`TXT`/`MD`) and the matching icon per kind.
- Shared rows (`r.shared`): read-only. Hide the pencil/trash; show a `Shared · {{ r.scope }}` tag; keep the same open behaviour by kind. The `count` emitted already counts the full `rows()` length, so it includes shared rows.
- The Edit dialog: show the URL field only for `kind === 'link'`; for every file kind show the "delete and re-upload to replace" note (generalize the current PDF-only copy).

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/app/lesson-resources.ts
git commit -m "feat: four-kind resource picker and read-only shared rows"
```

---

### Task 10: Text lessons and the panel on every lesson

**Files:**
- Modify: `src/app/course.ts`
- Verify: `npm run typecheck`, `npm run build`

**Interfaces:**
- Consumes: `TextViewer` (Task 8), `Lesson.kind` (Task 8).
- Produces: text lessons render the viewer + the shared lesson panel; the panel appears for PDF and text lessons too.

- [ ] **Step 1: Implement lesson rendering**

- Widen the browser `Row`/lesson kind unions in `course.ts` (~line 253) to include `'txt' | 'md'`; give those rows a text/page icon.
- Player body: render `app-pdf-viewer` for `pdf`, `app-text-viewer [key]="l.id" [md]="l.kind === 'md'"` for text lessons, and the player/YouTube branch otherwise. For the PDF and text branches, render `app-lesson-panel [lesson]="l"` **below** the viewer (single column, per spec §7.3 and its CSS note).
- The lesson bar's `app-notes-controls` stays gated to `l.kind === 'pdf'`. Text lessons keep the standard bar (Back, title, Mark complete).

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add src/app/course.ts
git commit -m "feat: text lessons and the resource panel on every lesson"
```

---

### Task 11: Docs and full verification

**Files:**
- Modify: `docs/CHANGELOG.md`, `docs/HANDOFF.md`
- Verify: full suite

- [ ] **Step 1: Update `docs/CHANGELOG.md`**

Add an entry covering: txt/md resources and lessons; the four-kind picker; the text/Markdown viewer and renderer; the panel now shown on all lesson kinds; the reserved `RESOURCE` folder (global/per-module, recursive, managed in Admin → Files); shared PDFs are annotatable; `.markdown` = `md`.

- [ ] **Step 2: Update `docs/HANDOFF.md`**

Record the same, plus the picker reconciliation (four-kind picker vs spec §7.1's "Link · File"), the caps, the reserved-name rule, and the deploy status (dev only until "main now").

- [ ] **Step 3: Run the full suite**

Run: `npm test && npm run typecheck && npm run build && npm run check:scripts`
Expected: all green; the test count is the previous 118 plus the new cases.

- [ ] **Step 4: Commit**

```bash
git add docs/CHANGELOG.md docs/HANDOFF.md
git commit -m "docs: text resources, RESOURCE folders and the all-lesson panel"
```

- [ ] **Step 5: Live E2E smoke on `dev` (after the branch is pushed)**

This is the realtime end-to-end check: it must confirm the new features work **and** that the rest of the site is not broken. Run it on `https://course-site.tes1ing.workers.dev`, signed in as the owner. Keep the browser devtools open and watch for any 5xx or uncaught errors.

New features:
- [ ] On a video lesson, add a link, upload a PDF, a TXT and an MD resource; open each one (link in a new tab, PDF in the reader, TXT/MD in the text viewer). Markdown renders; a `.md` containing `<script>alert(1)</script>` shows as text, not a prompt.
- [ ] Drop a `.txt` and a `.md` file into a course folder in **Admin → Files**; confirm each now appears as a lesson, opens, and can be marked complete and commented on.
- [ ] Open a PDF lesson: the **Discussion / Notes / Resources** panel is present below the reader; highlight/annotate it and confirm the annotations persist after reload.
- [ ] Create a `RESOURCE` folder inside a module (and one at the course root); upload a PDF and an `.md` into it. Confirm the files appear on **every** lesson in that module and its subfolders, and the course-level one on every lesson in the course, with the shared tag and scope. Annotate a shared PDF and reopen it from a sibling lesson — the highlights are there.
- [ ] Confirm the `RESOURCE` folder does **not** appear as a section or a lesson in the student course view, and that a file inside it is not treated as a lesson in **Admin → Files**.

Existing pages still work (regression):
- [ ] Site home / course catalog loads; a locked course still shows its lesson count without leaking lessons.
- [ ] A normal video lesson plays, progress marks complete, discussion posts, and private notes save.
- [ ] An existing YouTube lesson opens and plays; the Admin → Files list still renders and its move/rename/delete controls work.
- [ ] Rename a `RESOURCE` file inside `RESOURCE` (allowed) and confirm a move *into* `RESOURCE` from outside is refused with a clear message.

Cleanup:
- [ ] Remove every test resource, text lesson and `RESOURCE` file created above; confirm the course looks as it did before the smoke and no orphaned rows/files remain.
