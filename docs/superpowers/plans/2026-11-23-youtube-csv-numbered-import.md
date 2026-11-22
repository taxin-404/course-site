# YouTube CSV Numbered Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `"no.","name","link"` the supported YouTube CSV shape: `no.` sets the lesson order, the import is one request, and the dialog offers a template.

**Architecture:** The parser reads a numbering column and sorts rows; a bulk form of `POST /api/admin/youtube` inserts all rows in one D1 batch and appends new lessons to the folder's `content_order` in one pass; the admin dialog sends one request and offers a downloadable header.

**Tech Stack:** Angular 22 signals, Cloudflare Worker + D1 + R2, `node:test` for parser/worker tests.

**Spec:** `docs/superpowers/specs/2026-11-23-youtube-csv-numbered-import-design.md`

## Global Constraints

- Single-lesson `POST /api/admin/youtube` keeps returning `{ ok, id, yt, shadowed: boolean }`; existing callers and tests must not change.
- A `no.` problem (missing, duplicate, out of range) never rejects a row; it only disables ordering.
- Ordering appends newly created lessons after everything already in the folder; existing entries keep their relative order.
- Re-importing an existing lesson name updates its link and must not move it.
- `setEntryPosition` semantics stay untouched.
- `npm test`, `npm run typecheck`, `npm run build` must pass.
- Use existing patterns: `json`/`bad` helpers in the Worker, `this.req` in `Api`, plain buttons (`button.link` for the template).

## Review Focus

- **Hand-edited file with one blank `no.` cell:** all rows still import, in file order; nothing is dropped.
- **Year or date column:** never chosen as the order column (a repeated year or a `2026-01-05` value must not scramble the folder).
- **Folder that already has hand-positioned files:** the imported block lands after them and their numbers do not change.
- **Same file imported twice:** links update in place, no duplicates, no reordering.
- **One bad link in a batch:** the whole batch is refused with `row N` in the message and nothing is inserted.
- **Names with commas or quotes:** still parse, and still order correctly.

---

### Task 1: Read `no.` and return rows in its order

**Files:**
- Modify: `src/app/youtube-csv.ts`
- Test: `src/app/youtube-csv.test.mjs` (create)

**Interfaces:**
- Consumes: existing `splitCsv`, `ytId`, `isYoutubeUrl`, `parseYoutubeCsv` behaviour.
- Produces:
  - `interface CsvRow { name: string; link: string; yt: string; no: number | null }`
  - `parseYoutubeCsv(text: string): { rows: CsvRow[]; rejected: CsvReject[] }` — `rows` sorted by `no` when a usable numbering column exists.

- [ ] **Step 1: Write the failing tests**

```js
// src/app/youtube-csv.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYoutubeCsv } from './youtube-csv.ts';

const A = 'https://youtu.be/aaaaaaaaaa';
const B = 'https://youtu.be/bbbbbbbbbb';

test('reads "no.","name","link" and returns the rows in no. order', () => {
  const csv = `"no.","name","link"\n"2","Fractions","${B}"\n"1","Algebra","${A}"`;
  const { rows, rejected } = parseYoutubeCsv(csv);
  assert.deepEqual(rows.map((r) => [r.no, r.name]), [[1, 'Algebra'], [2, 'Fractions']]);
  assert.deepEqual(rejected, []);
});

test('a headerless column of unique numbers orders the rows too', () => {
  const csv = `2,Fractions,${B}\n1,Algebra,${A}`;
  assert.deepEqual(parseYoutubeCsv(csv).rows.map((r) => r.name), ['Algebra', 'Fractions']);
});

test('a repeated, blank or out-of-range number keeps file order and clears no', () => {
  const dup = `"no.","name","link"\n"1","A","${A}"\n"1","B","${B}"`;
  assert.deepEqual(parseYoutubeCsv(dup).rows.map((r) => [r.name, r.no]), [['A', null], ['B', null]]);
  const blank = `"no.","name","link"\n"1","A","${A}"\n"","B","${B}"`;
  assert.deepEqual(parseYoutubeCsv(blank).rows.map((r) => [r.name, r.no]), [['A', null], ['B', null]]);
  const big = `"no.","name","link"\n"10000","A","${A}"\n"2","B","${B}"`;
  assert.deepEqual(parseYoutubeCsv(big).rows.map((r) => [r.name, r.no]), [['A', null], ['B', null]]);
});

test('dates and a repeated year are never read as the order', () => {
  const dates = `2026-01-05,B,${B}\n2026-01-08,A,${A}`;
  assert.deepEqual(parseYoutubeCsv(dates).rows.map((r) => [r.name, r.no]), [['B', null], ['A', null]]);
  const years = `2026,B,${B}\n2026,A,${A}`;
  assert.deepEqual(parseYoutubeCsv(years).rows.map((r) => [r.name, r.no]), [['B', null], ['A', null]]);
});

test('a quoted name with a comma keeps its place in the order', () => {
  const csv = `"no.","name","link"\n"2","Fractions, part 2","${B}"\n"1","Algebra","${A}"`;
  assert.deepEqual(parseYoutubeCsv(csv).rows.map((r) => r.name), ['Algebra', 'Fractions, part 2']);
});

test('the rejection rules are unchanged', () => {
  const csv = `"no.","name","link"\n"1","A/B","${A}"\n"2","","${B}"\n"3","C","https://example.com/x"`;
  const { rows, rejected } = parseYoutubeCsv(csv);
  assert.deepEqual(rows, []);
  assert.deepEqual(rejected.map((r) => r.line), [2, 3, 4]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test src/app/youtube-csv.test.mjs`
Expected: FAIL — `r.no` is `undefined` and the first test's order is `Fractions, Algebra`.

- [ ] **Step 3: Implement the numbering column**

In `src/app/youtube-csv.ts`:

1. Add `no: number | null` to `CsvRow`.
2. Add `const NO_HEADERS = new Set(['no', 'nr', 'number', '#', 'order', 'position', 'pos', 'sn', 's.no', 'sr.no'])` and `const headerName = (cell: string) => cell.trim().toLowerCase().replace(/\s+/g, '').replace(/\.+$/, '')`.
3. Add `const orderAt = (cells: string[], col: number): number | null` returning a whole number from 1 to 9999 or `null`.
4. Choose the column after `linkCol`/`nameCol` are known:
   - with a header row, the first data column whose `headerName` is in `NO_HEADERS`;
   - without one, the leftmost column that is neither `linkCol` nor `nameCol`;
   - in both cases keep it only when every data row has an `orderAt` value and all values differ.
5. When a column was chosen, set `no` per row and return `rows` sorted ascending by it (numbers are unique, so the sort is total); otherwise set `no: null` for every row and keep file order.

Do not touch link/name detection, quoting, or the rejection rules.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test src/app/youtube-csv.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/youtube-csv.ts src/app/youtube-csv.test.mjs docs/superpowers/specs/2026-11-23-youtube-csv-numbered-import-design.md
git commit -m "feat: read the no. column and order YouTube CSV rows by it"
```

---

### Task 2: Bulk import endpoint with one-pass ordering

**Files:**
- Modify: `worker/files.js` (export a new helper beside `setEntryPosition`, around line 261)
- Modify: `worker/index.js:1583-1599`
- Test: `worker/youtube-bulk.test.mjs` (create)

**Interfaces:**
- Consumes: `siblings`, `orderPositions`, `compareEntries`, `runChunks` inside `worker/files.js`; `ytId`, `invalidateCourse`, `hasReservedSegment` in `worker/index.js`.
- Produces:
  - `export async function appendToFolderOrder(env, parent: string, paths: string[]): Promise<Record<string, number>>` in `worker/files.js`
  - `POST /api/admin/youtube` accepts `{ course, folder, lessons: [{ lesson, link }], order: boolean }` and answers `{ ok: true, added: number, order: boolean, shadowed: string[] }`
  - the existing object form still answers `{ ok: true, id, yt, shadowed: boolean }`

- [ ] **Step 1: Write the failing route tests**

```js
// worker/youtube-bulk.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { db, r2, rate } from './harness.mjs';

const SECRET = 'S'.repeat(40);
const OWNER = 'owner@example.com';
const OWNER_PW = 'owner-pass-123';
const ORIGIN = 'https://s.example';

const { raw, DB } = db();
const RATE = rate();
const env = { DB, RESOURCES: r2(), SESSION_SECRET: SECRET, ADMIN_EMAIL: OWNER, ADMIN_PASSWORD: OWNER_PW, RATE: RATE.RATE };
const call = (path, { method = 'GET', headers = {}, body } = {}) =>
  worker.fetch(new Request(ORIGIN + path, { method, headers, body }), env);
const post = (path, body) =>
  call(path, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

let adminCookie = '';
before(async () => {
  const res = await call('/api/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'cf-connecting-ip': '10.0.0.1', 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER, password: OWNER_PW }),
  });
  adminCookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
});

const ids = (prefix) => raw.prepare('SELECT id FROM youtube_lessons WHERE id LIKE ? ORDER BY id').all(prefix + '/%').map((r) => r.id);
const positions = () => raw.prepare('SELECT path, position FROM content_order ORDER BY position').all();

test('one request adds every lesson', async () => {
  const res = await post('/api/admin/youtube', {
    course: 'Bulk1', folder: 'Section',
    lessons: [
      { lesson: 'One', link: 'https://youtu.be/aaaaaaaaaa' },
      { lesson: 'Two', link: 'bbbbbbbbbb' },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added, 2);
  assert.deepEqual(body.shadowed, []);
  assert.deepEqual(ids('Bulk1'), ['Bulk1/Section/One', 'Bulk1/Section/Two']);
});

test('numbered rows are appended after what is already in the folder', async () => {
  raw.prepare("INSERT INTO youtube_lessons (id, yt, created) VALUES ('Order/Existing', 'cccccccccc', 1)").run();
  const res = await post('/api/admin/youtube', {
    course: 'Order', folder: '',
    lessons: [
      { lesson: 'Second', link: 'https://youtu.be/bbbbbbbbbb' },
      { lesson: 'First', link: 'https://youtu.be/aaaaaaaaaa' },
    ],
    order: true,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).order, true);
  assert.deepEqual(positions().filter((r) => r.path.startsWith('Order/')), [
    { path: 'Order/Existing', position: 1 },
    { path: 'Order/Second', position: 2 },
    { path: 'Order/First', position: 3 },
  ]);
});

test('an existing name is updated in place and not moved', async () => {
  raw.prepare("INSERT INTO youtube_lessons (id, yt, created) VALUES ('Again/Pinned', 'dddddddddd', 1)").run();
  raw.prepare("INSERT INTO content_order (path, position) VALUES ('Again/Pinned', 1)").run();
  const res = await post('/api/admin/youtube', {
    course: 'Again', folder: '',
    lessons: [
      { lesson: 'Pinned', link: 'https://youtu.be/zzzzzzzzzz' },
      { lesson: 'New', link: 'https://youtu.be/yyyyyyyyyy' },
    ],
    order: true,
  });
  assert.equal(res.status, 200);
  assert.equal(raw.prepare("SELECT yt FROM youtube_lessons WHERE id = 'Again/Pinned'").get().yt, 'zzzzzzzzzz');
  assert.deepEqual(positions().filter((r) => r.path.startsWith('Again/')), [
    { path: 'Again/Pinned', position: 1 },
    { path: 'Again/New', position: 2 },
  ]);
});

test('one bad row refuses the whole batch', async () => {
  const res = await post('/api/admin/youtube', {
    course: 'BadBatch', folder: '',
    lessons: [
      { lesson: 'Good', link: 'https://youtu.be/aaaaaaaaaa' },
      { lesson: 'Bad', link: 'https://example.com/x' },
    ],
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /row 2/i);
  assert.deepEqual(ids('BadBatch'), []);
});

test('a non-admin cannot use the bulk form', async () => {
  const res = await call('/api/admin/youtube', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ course: 'Nope', folder: '', lessons: [{ lesson: 'X', link: 'https://youtu.be/aaaaaaaaaa' }] }),
  });
  assert.ok([401, 403].includes(res.status));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test worker/youtube-bulk.test.mjs`
Expected: FAIL — the bulk form inserts nothing, `added` is `undefined`, and no positions are written.

- [ ] **Step 3: Add `appendToFolderOrder` in `worker/files.js`**

Signature and rules (place it after `setEntryPosition`):

```js
export async function appendToFolderOrder(env, parent, paths) { ... }
```

- `const entries = await siblings(env, parent)` and `const saved = await orderPositions(env)`.
- `const ordered = entries.slice().sort(compareEntries(saved))`.
- `const byPath = new Map(entries.map((e) => [e.path, e]))`.
- `const wanted = new Set(paths)`; `const rest = ordered.filter((e) => !wanted.has(e.path))`.
- `const tail = paths.map((p) => byPath.get(p)).filter(Boolean)` — the new lessons, in the order given.
- `const final = [...rest, ...tail]`.
- Write `position = i + 1` for every entry in `final` with `runChunks` and one upsert statement per entry (`INSERT INTO content_order ... ON CONFLICT(path) DO UPDATE SET position = excluded.position`).
- Return `Object.fromEntries(final.map((e, i) => [e.path, i + 1]))`.

- [ ] **Step 4: Accept the bulk form in `worker/index.js`**

Replace the POST handler body with:

1. Read `course`, `folder`, and `list = Array.isArray(b.lessons) ? b.lessons : [b]`.
2. Validate `course`; then per row (index `i`): lesson name required, no `/`, `ytId(link)` must resolve, the joined id must not contain a reserved segment and the folder must not either. Collect messages as `row ${i + 1}: <reason>`; if any, answer `400 { error: messages.slice(0, 3).join('; ') }` and insert nothing.
3. Build `id = [course, ...folderSegments, lesson].join('/')` and `now = Date.now()`.
4. Ask which ids already exist (`SELECT id FROM youtube_lessons WHERE id IN (...)` in chunks of 50) before inserting.
5. `await env.DB.batch(rows.map(... upsert ...))`.
6. When `b.order === true`, call `appendToFolderOrder(env, [course, ...folderSegments].join('/'), newIdsInGivenOrder)` — only the ids that did not exist.
7. `invalidateCourse()`.
8. Shadow check: `await env.RESOURCES.head(id)` for each id in chunks of 20 (`Promise.all` per chunk).
9. Bulk response: `{ ok: true, added: rows.length, order: b.order === true, shadowed: shadowedNames }`. Object form: keep `{ ok: true, id, yt, shadowed: shadowedNames.length > 0 }`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test worker/youtube-bulk.test.mjs worker/youtube-rename.test.mjs worker/shared-resources.test.mjs worker/files.test.mjs`
Expected: PASS for all four files.

- [ ] **Step 6: Commit**

```bash
git add worker/files.js worker/index.js worker/youtube-bulk.test.mjs
git commit -m "feat: import YouTube lessons in one request and order them once"
```

---

### Task 3: Client sends one bulk request

**Files:**
- Modify: `src/app/youtube-csv.ts` (add `csvPayload`)
- Modify: `src/app/youtube-csv.test.mjs`
- Modify: `src/app/api.ts` (add `importYoutubeLessons`)
- Modify: `src/app/admin-files.ts` (`importCsv`, import line 3)

**Interfaces:**
- Consumes: `CsvRow` from Task 1; the bulk response shape from Task 2.
- Produces:
  - `interface CsvRequest { lessons: { lesson: string; link: string }[]; ordered: boolean }`
  - `csvPayload(rows: CsvRow[]): CsvRequest`
  - `Api.importYoutubeLessons(course: string, folder: string, lessons: { lesson: string; link: string }[], ordered: boolean): Promise<{ ok: boolean; added: number; order: boolean; shadowed: string[] }>`

- [ ] **Step 1: Write the failing tests**

Append to `src/app/youtube-csv.test.mjs` (import `csvPayload` too):

```js
test('csvPayload sends the numbered batch as ordered', () => {
  const csv = `"no.","name","link"\n"1","A","${A}"\n"2","B","${B}"`;
  const { lessons, ordered } = csvPayload(parseYoutubeCsv(csv).rows);
  assert.equal(ordered, true);
  assert.deepEqual(lessons, [{ lesson: 'A', link: A }, { lesson: 'B', link: B }]);
});

test('csvPayload keeps file order when the numbers are unusable', () => {
  const csv = `B,${B}\nA,${A}`;
  const { lessons, ordered } = csvPayload(parseYoutubeCsv(csv).rows);
  assert.equal(ordered, false);
  assert.deepEqual(lessons.map((l) => l.lesson), ['B', 'A']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --test src/app/youtube-csv.test.mjs`
Expected: FAIL — `csvPayload is not a function`.

- [ ] **Step 3: Add `csvPayload`**

In `src/app/youtube-csv.ts`: the two interfaces above and

```ts
export function csvPayload(rows: CsvRow[]): CsvRequest {
  return { lessons: rows.map((r) => ({ lesson: r.name, link: r.link })), ordered: rows.length > 0 && rows.every((r) => r.no !== null) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test src/app/youtube-csv.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the API method and use it in `importCsv`**

`src/app/api.ts`, next to `addYoutubeLesson`:

```ts
importYoutubeLessons(course: string, folder: string, lessons: { lesson: string; link: string }[], ordered: boolean): Promise<{ ok: boolean; added: number; order: boolean; shadowed: string[] }> {
  return this.req('admin/youtube', { course, folder, lessons, order: ordered });
}
```

`src/app/admin-files.ts`:

- Import `csvPayload` from `./youtube-csv` (line 3).
- Replace the per-row loop in `importCsv` with one call; on success close the dialog and toast `Added ${res.added} lesson(s)`, appending `· ${res.shadowed.length} hidden by a file with the same path` when any are shadowed (bad toast only then). On failure set `ytError` from `message(e)`. Keep `void this.api.init()` and `await this.load()`.
- Delete the now-unused `added`, `shadowed` counters and the `failed` list.

- [ ] **Step 6: Verify types and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed, no unused-symbol errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/youtube-csv.ts src/app/youtube-csv.test.mjs src/app/api.ts src/app/admin-files.ts
git commit -m "feat: send the YouTube CSV import as one request"
```

---

### Task 4: Template, dialog copy and docs

**Files:**
- Modify: `src/app/youtube-csv.ts` (add `CSV_TEMPLATE`)
- Modify: `src/app/youtube-csv.test.mjs`
- Modify: `src/app/admin-files.ts` (dialog markup around lines 298-311, new `downloadTemplate`)
- Modify: `README.md:115`

**Interfaces:**
- Consumes: `parseYoutubeCsv` from Task 1; the dialog state already in `AdminFiles`.
- Produces: `CSV_TEMPLATE: string` in `src/app/youtube-csv.ts`; `AdminFiles.downloadTemplate(): void`.

- [ ] **Step 1: Write the failing test**

```js
test('CSV_TEMPLATE is the exact header the importer reads', () => {
  assert.equal(CSV_TEMPLATE, '\ufeff"no.","name","link"\n');
  assert.deepEqual(parseYoutubeCsv(CSV_TEMPLATE).rows, []);
});
```

Import `CSV_TEMPLATE` in the test file.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test src/app/youtube-csv.test.mjs`
Expected: FAIL — `CSV_TEMPLATE is not exported`.

- [ ] **Step 3: Add the constant and wire the dialog**

In `src/app/youtube-csv.ts`:

```ts
/** What the dialog offers as a starting point; the BOM keeps Excel on UTF-8. */
export const CSV_TEMPLATE = '\ufeff"no.","name","link"\n';
```

In `src/app/admin-files.ts`:

- Extend the import from `./youtube-csv` with `CSV_TEMPLATE`.
- Change the CSV field label to `...or import a CSV · "no.","name","link"`.
- Under the file input, add:

```html
<p class="adm-muted sm">
  The no. column sets the order in this folder; leave it blank to keep the file order.
  <button type="button" class="link" (click)="downloadTemplate()">Download template</button>
</p>
```

- Add the method, mirroring `Admin.download` (`src/app/admin.ts:1061`):

```ts
protected downloadTemplate(): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv' }));
  a.download = 'youtube-lessons.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
```

`README.md` line 115: state the shape as `"no.","name","link"` (header optional, extra columns fine), that `no.` sets the order inside the folder and any missing/duplicate number keeps file order, and that **Download template** produces that header. Keep the existing note that the file is read in the browser and the destination is the open folder.

- [ ] **Step 4: Run the test and the full gates**

Run: `npm test`
Expected: all tests pass, including the new ones.

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src/app/youtube-csv.ts src/app/youtube-csv.test.mjs src/app/admin-files.ts README.md
git commit -m "feat: offer a no./name/link CSV template and document the order column"
```

---

## Manual check (after all tasks)

With `npm start` and an admin session: Admin panel → Files → open a course → YouTube → **Download template** saves `youtube-lessons.csv`; paste two rows with `2` before `1`, import, and the folder lists them in `no.` order with the two lessons at the end of any existing ones. Re-import with a changed link and confirm the row stays in place.
