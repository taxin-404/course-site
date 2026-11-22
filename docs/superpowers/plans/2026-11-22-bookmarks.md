# Lesson Bookmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each signed-in user save whole lessons and find them again from a Bookmarks page opened by the shared options menu.

**Architecture:** A `bookmarks(user_id, lesson, created)` table mirrors `watched`. `/api/course` carries the current user's `bookmarked` / `bookmarkedAt` on each lesson, and `POST /api/bookmarks` toggles one lesson behind the existing `lessonAccess` check. The lesson bar gets a toggle, and a lazy `/bookmarks` page derives its newest-first rows from the course payload already in `Api.courses()`.

**Tech Stack:** Angular 22 (standalone components, signals), TypeScript 6, Cloudflare Workers, D1, the repo's Node test runner (`node --experimental-strip-types --test`).

**Spec:** `docs/superpowers/specs/2026-11-22-bookmarks-design.md`

## Global Constraints

- Bookmarks are private per user. Every read and write binds the signed-in `u.id`; the client never supplies a user id.
- Whole lessons only: no media timestamps, PDF pages, notes or folders.
- No new dependencies, no component styles: templates plus `src/styles.css`.
- The only new API endpoint is `POST /api/bookmarks`; there is no `GET /api/bookmarks`.
- The DDL change requires `SCHEMA_VERSION = '2'` and the pinned hash
  `2e20272e514de6605a76d2d25af7f17bb861065445f545d5aa534b5c92eba2dc`.
- Copy stays sentence case: **Bookmark**, **Bookmarked**, **Remove bookmark**, and
  **No bookmarks yet. Open a lesson and use the bookmark button.**
- Verification for every task: `npm test`, `npm run typecheck`, `npm run build`.
  The repo has no Angular component test harness; pure helpers get `.mjs` tests,
  components are gated by typecheck/build.

## Review Focus

- **Two users bookmarking the same lesson must stay independent:** each sees only
  their own flag, and removing one must not remove the other's row.
- **Revoked course access hides a bookmark without deleting it:** the locked course
  has no sections, and re-enrolling brings the same bookmark back.
- **Renaming a lesson onto a key where the same user already has a bookmark must
  not violate the primary key:** `UPDATE OR REPLACE` is required, not plain `UPDATE`.
- **Every delete path removes bookmarks:** file/lesson delete, admin YouTube delete,
  course delete (through its lessons), and user delete.
- **Stale rows for missing or locked lessons must never appear or break the page:**
  `/api/course` only maps rows onto lessons it actually lists.

---

## File Structure

- `worker/index.js` — schema version and `bookmarks` DDL; bookmarks in
  `/api/course`; the `POST /api/bookmarks` route; YouTube delete and user-delete
  cleanup.
- `worker/limits.js` — `publicLesson()` gains the bookmark fields.
- `worker/files.js` — `LESSON_ROWS`, `LESSON_DELETES`, `LESSON_TABLES`.
- `src/app/api.ts` — `Lesson` fields and `setBookmark()`.
- `src/app/course.ts` — the lesson-bar bookmark toggle.
- `src/app/bookmark-rows.ts` — pure row builder for the page (typed, testable).
- `src/app/bookmarks.ts` — the `/bookmarks` page component.
- `src/app/app.routes.ts` — the lazy `/bookmarks` route.
- `src/app/options-menu.ts` — the Bookmarks menu item.
- `src/styles.css` — lesson-bar button and page row styles.
- Tests: `worker/schema.test.mjs`, `worker/limits.test.mjs`,
  `worker/security.test.mjs`, `worker/youtube-rename.test.mjs`,
  `src/app/bookmark-rows.test.mjs`.

### Setup: Commit the approved spec and this plan

- [ ] **Step 1: Commit the documents**

```bash
git add docs/superpowers/specs/2026-11-22-bookmarks-design.md docs/superpowers/plans/2026-11-22-bookmarks.md
git commit -m "docs: add the lesson bookmarks design and plan"
```

---

### Task 1: Schema

**Files:**
- Modify: `worker/index.js:75` (`SCHEMA_VERSION`), `worker/index.js:82` (after `watched`)
- Test: `worker/schema.test.mjs:176` (table-presence test), `worker/schema.test.mjs:319` (hash test)

**Interfaces:**
- Produces: a `bookmarks` table with columns `user_id INTEGER`, `lesson TEXT`,
  `created INTEGER`, primary key `(user_id, lesson)`.
- Produces: `SCHEMA_VERSION === '2'`, which later tasks rely on for fresh databases.

- [ ] **Step 1: Make the schema test require the new table**

In `worker/schema.test.mjs` change the table-presence query and count:

```js
const tables = await DB.prepare(
  "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'resources', 'youtube_lessons', 'enrollments', 'bookmarks')",
).first();
assert.equal(tables.c, 5, 'the full schema was created');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test worker/schema.test.mjs`
Expected: the "missing version runs the full path" test fails with `4 !== 5`.

- [ ] **Step 3: Add the DDL and bump the version**

In `worker/index.js`, change line 75 to:

```js
export const SCHEMA_VERSION = '2';
```

Immediately after the `watched` entry in `SCHEMA` (line 82), add:

```js
'CREATE TABLE IF NOT EXISTS bookmarks (user_id INTEGER NOT NULL, lesson TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (user_id, lesson))',
```

Do not add a `MIGRATIONS` entry: the version bump runs the full idempotent
`SCHEMA` path once, and an extra migration would change the pinned hash again.

- [ ] **Step 4: Update the pinned hash**

The insertion position and exact DDL above produce this hash. Replace the pinned
value in `worker/schema.test.mjs:324` with:

```js
'2e20272e514de6605a76d2d25af7f17bb861065445f545d5aa534b5c92eba2dc'
```

If the actual hash differs, the DDL text or position differs; fix the DDL rather
than inventing a hash.

- [ ] **Step 5: Run the schema tests to verify they pass**

Run: `node --experimental-strip-types --test worker/schema.test.mjs`
Expected: all schema tests pass.

- [ ] **Step 6: Commit**

```bash
git add worker/index.js worker/schema.test.mjs
git commit -m "feat: add the bookmarks table"
```

---

### Task 2: Bookmark state in the course payload

**Files:**
- Modify: `worker/limits.js:36`
- Modify: `worker/index.js:1144-1167`
- Test: `worker/limits.test.mjs`, `worker/security.test.mjs` (add one test after the progress test)

**Interfaces:**
- Consumes: the `bookmarks` table from Task 1.
- Produces: `publicLesson(lesson, done, bookmarkedAt)` returning
  `{ id, title, kind, done: boolean, bookmarked: boolean, bookmarkedAt?: number }`.
- Produces: `/api/course` lessons carrying `bookmarked` for the signed-in user.

- [ ] **Step 1: Write the failing tests**

In `worker/limits.test.mjs`, replace the existing `publicLesson` expectations so
every lesson now has `bookmarked`, and add the timestamp case:

```js
test('publicLesson never exposes the YouTube id but keeps what a student needs', () => {
  const yt = publicLesson({ id: 'Course/Sec/Clip', title: 'Clip', kind: 'youtube', yt: 'dQw4w9WgXcQ' }, true);
  assert.deepEqual(yt, { id: 'Course/Sec/Clip', title: 'Clip', kind: 'youtube', done: true, bookmarked: false });
  assert.ok(!('yt' in yt));

  const hls = publicLesson({ id: 'Course/Sec/V', title: 'V', kind: 'video', subtitles: [{ key: 'k', lang: 'en' }] }, false);
  assert.deepEqual(hls, {
    id: 'Course/Sec/V', title: 'V', kind: 'video', done: false, bookmarked: false,
    subtitles: [{ key: 'k', lang: 'en' }],
  });

  const saved = publicLesson({ id: 'Course/Sec/V', title: 'V', kind: 'video' }, false, 1730000000000);
  assert.deepEqual(saved, {
    id: 'Course/Sec/V', title: 'V', kind: 'video', done: false,
    bookmarked: true, bookmarkedAt: 1730000000000,
  });
});
```

In `worker/security.test.mjs`, after the existing `/api/progress` test, add:

```js
test('/api/course reports only the signed-in student’s bookmarks', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const uid = raw.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

  raw.prepare('INSERT INTO bookmarks (user_id, lesson, created) VALUES (?, ?, ?)').run(uid, 'Course/notes.pdf', 111);
  raw.prepare('INSERT INTO bookmarks (user_id, lesson, created) VALUES (?, ?, ?)').run(uid, 'Other/hidden.pdf', 222);
  raw.prepare('INSERT INTO bookmarks (user_id, lesson, created) VALUES (?, ?, ?)').run(uid, 'Course/gone.pdf', 333);

  const courses = await (await call('/api/course', { headers: { cookie } })).json();
  const lessons = courses.flatMap((c) => c.sections.flatMap((s) => s.lessons));
  const notes = lessons.find((l) => l.id === 'Course/notes.pdf');
  assert.equal(notes.bookmarked, true);
  assert.equal(notes.bookmarkedAt, 111);
  assert.equal(lessons.find((l) => l.id === 'Course/clip.mp4').bookmarked, false);
  assert.ok(!lessons.some((l) => l.id === 'Other/hidden.pdf'), 'locked course lessons stay withheld');
  assert.ok(!lessons.some((l) => l.id === 'Course/gone.pdf'), 'a stale row is not resurrected');

  await enroll(email, 'Other');
  const restored = await (await call('/api/course', { headers: { cookie } })).json();
  const hidden = restored.flatMap((c) => c.sections.flatMap((s) => s.lessons)).find((l) => l.id === 'Other/hidden.pdf');
  assert.equal(hidden.bookmarked, true, 'the row survived the lock and is visible again');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`node --experimental-strip-types --test worker/limits.test.mjs worker/security.test.mjs`
Expected: `publicLesson` lacks `bookmarked`, and the new course test fails because
`bookmarked` is `undefined`.

- [ ] **Step 3: Implement the payload**

In `worker/limits.js` replace `publicLesson` with:

```js
export const publicLesson = (lesson, done, bookmarkedAt) => {
  const out = { id: lesson.id, title: lesson.title, kind: lesson.kind, done: !!done, bookmarked: !!bookmarkedAt };
  if (bookmarkedAt) out.bookmarkedAt = bookmarkedAt;
  if (lesson.subtitles) out.subtitles = lesson.subtitles;
  return out;
};
```

In `worker/index.js` `/api/course`, replace the single `watched` read with one
batch and pass the timestamp through:

```js
const [watchedRows, bookmarkRows] = await env.DB.batch([
  env.DB.prepare('SELECT lesson FROM watched WHERE user_id = ?').bind(u.id),
  env.DB.prepare('SELECT lesson, created FROM bookmarks WHERE user_id = ?').bind(u.id),
]);
const w = new Set(watchedRows.results.map((r) => r.lesson));
const bookmarks = new Map(bookmarkRows.results.map((r) => [r.lesson, Number(r.created)]));
```

and change the lesson mapping to:

```js
lessons: s.lessons.map((l) => publicLesson(l, w.has(l.id), bookmarks.get(l.id))),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`node --experimental-strip-types --test worker/limits.test.mjs worker/security.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add worker/limits.js worker/limits.test.mjs worker/index.js worker/security.test.mjs
git commit -m "feat: include bookmarks in the course payload"
```

---

### Task 3: The toggle endpoint

**Files:**
- Modify: `worker/index.js` (after the `/api/progress` route, line 1304)
- Test: `worker/security.test.mjs` (add after the new course test)

**Interfaces:**
- Consumes: `lessonAccess(env, u, lesson)` and `accessError(access)` from the Worker.
- Produces: `POST /api/bookmarks` with body `{ lesson: string, bookmarked: boolean }`
  and response `{ ok: true, bookmarked: boolean }`.
- Produces: `INSERT OR IGNORE` on add, delete on remove, scoped to `u.id`.

- [ ] **Step 1: Write the failing test**

Add to `worker/security.test.mjs`:

```js
test('/api/bookmarks toggles one private row and only accepts accessible lessons', async () => {
  const email = await addUser();
  await enroll(email, 'Course');
  const { cookie } = await login(email);
  const headers = { cookie, origin: ORIGIN, 'content-type': 'application/json' };
  const send = (lesson, bookmarked, c = cookie) => call('/api/bookmarks', {
    method: 'POST',
    headers: { ...headers, cookie: c },
    body: JSON.stringify({ lesson, bookmarked }),
  });

  const signedOut = await call('/api/bookmarks', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ lesson: 'Course/notes.pdf', bookmarked: true }),
  });
  assert.equal(signedOut.status, 401, 'must be signed in');
  assert.equal((await send('Course/missing.pdf', true)).status, 404, 'unknown lesson');
  assert.equal((await send('Other/hidden.pdf', true)).status, 403, 'unenrolled course');
  assert.equal((await send('Course/notes.pdf', true)).status, 200);

  const uid = raw.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const row = () => raw.prepare('SELECT created FROM bookmarks WHERE user_id = ? AND lesson = ?').get(uid, 'Course/notes.pdf');
  assert.ok(row(), 'the bookmark was stored');
  const created = row().created;

  await send('Course/notes.pdf', true);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ? AND lesson = ?').get(uid, 'Course/notes.pdf').n, 1);
  assert.equal(row().created, created, 'adding twice keeps the first timestamp');

  const email2 = await addUser();
  await enroll(email2, 'Course');
  const { cookie: cookie2 } = await login(email2, { ip: '10.0.0.2' });
  await send('Course/notes.pdf', true, cookie2);
  const uid2 = raw.prepare('SELECT id FROM users WHERE email = ?').get(email2).id;
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ? AND lesson = ?').get(uid2, 'Course/notes.pdf').n, 1);

  await send('Course/notes.pdf', false, cookie2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ? AND lesson = ?').get(uid2, 'Course/notes.pdf').n, 0, 'user 2 removed only their own row');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ? AND lesson = ?').get(uid, 'Course/notes.pdf').n, 1, 'user 1 is untouched');

  await send('Course/notes.pdf', false);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ? AND lesson = ?').get(uid, 'Course/notes.pdf').n, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test worker/security.test.mjs`
Expected: the new test fails (the route does not exist yet).

- [ ] **Step 3: Implement the route**

After the `/api/progress` block in `worker/index.js`, add:

```js
if (path === '/api/bookmarks' && m === 'POST') {
  const { lesson, bookmarked } = await req.json();
  // Same rule as progress: a real lesson in a course the student is granted.
  const access = await lessonAccess(env, u, lesson);
  if (access !== 'ok') return accessError(access);
  if (bookmarked) {
    await env.DB.prepare('INSERT OR IGNORE INTO bookmarks (user_id, lesson, created) VALUES (?, ?, ?)')
      .bind(u.id, lesson, Date.now()).run();
  } else {
    await env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ? AND lesson = ?')
      .bind(u.id, lesson).run();
  }
  return json({ ok: true, bookmarked: !!bookmarked });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test worker/security.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/security.test.mjs
git commit -m "feat: add the bookmark toggle endpoint"
```

---

### Task 4: Lifecycle cleanup

**Files:**
- Modify: `worker/files.js:308` (`LESSON_ROWS`), `worker/files.js:474`
  (`LESSON_DELETES`), `worker/files.js:486` (`LESSON_TABLES`)
- Modify: `worker/index.js:1574-1588` (YouTube delete), `worker/index.js:1702`
  (user-delete batch)
- Test: `worker/security.test.mjs:655` and `:672`, `worker/youtube-rename.test.mjs`

**Interfaces:**
- Consumes: the `bookmarks` table and its `(user_id, lesson)` key.
- Produces: moves/renames carry rows; lesson, course and user deletes remove rows.
- Produces: the YouTube rename test's seed helper has a bookmark row, so its
  existing moved-tables loop covers bookmarks.

- [ ] **Step 1: Write the failing lifecycle tests**

In `worker/security.test.mjs`, in the user-delete test (`deleting a user removes
their note images from R2`), after `const uid = ...`, seed a bookmark:

```js
raw.prepare('INSERT OR REPLACE INTO bookmarks (user_id, lesson, created) VALUES (?, ?, ?)').run(uid, 'Course/notes.pdf', 1);
```

and after the `note_assets` assertion add:

```js
assert.equal(raw.prepare('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ?').get(uid).n, 0);
```

In the lesson-delete test (`deleting a lesson removes the note images attached to
it`), after `const uid = ...`, seed a bookmark:

```js
raw.prepare('INSERT OR REPLACE INTO bookmarks (user_id, lesson, created) VALUES (?, ?, ?)').run(uid, 'Course/deleteme.pdf', 1);
```

and after the `note_assets` assertion add:

```js
assert.equal(raw.prepare('SELECT COUNT(*) n FROM bookmarks WHERE lesson = ?').get('Course/deleteme.pdf').n, 0, 'the bookmark is gone');
```

In `worker/youtube-rename.test.mjs`, add a bookmark to `seedLesson()` after `uid`
is obtained:

```js
raw.prepare('INSERT OR REPLACE INTO bookmarks (user_id, lesson, created) VALUES (?, ?, ?)').run(uid, id, 1);
```

Add `'bookmarks'` to that test's moved-tables loop:

```js
for (const table of ['watched', 'pdf_notes', 'video_notes', 'note_assets', 'comments', 'resources', 'bookmarks']) {
```

Add two new tests at the end of `worker/youtube-rename.test.mjs`:

```js
test('renaming keeps bookmark keys unique when the target already has one', async () => {
  const oldId = 'MERN Stack/bookmark-old';
  const newId = 'MERN Stack/bookmark-new';
  const uid = seedLesson(oldId);
  raw.prepare('INSERT OR REPLACE INTO bookmarks (user_id, lesson, created) VALUES (?, ?, ?)').run(uid, newId, 2);

  const res = await post('/api/admin/youtube/rename', { id: oldId, name: 'bookmark-new' }, adminCookie);
  assert.equal(res.status, 200);
  assert.equal(count('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ? AND lesson = ?', uid, newId), 1);
  assert.equal(count('SELECT COUNT(*) n FROM bookmarks WHERE lesson = ?', oldId), 0);
});

test('deleting a YouTube lesson removes its bookmarks', async () => {
  const id = 'MERN Stack/bookmark-delete';
  seedLesson(id);
  const res = await call('/api/admin/youtube', {
    method: 'DELETE',
    headers: { ...browser(adminCookie), 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  assert.equal(res.status, 200);
  assert.equal(count('SELECT COUNT(*) n FROM bookmarks WHERE lesson = ?', id), 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
`node --experimental-strip-types --test worker/security.test.mjs worker/youtube-rename.test.mjs`
Expected: bookmarks remain after user, lesson and YouTube deletes; the rename
collision test fails on the primary key; bookmarks stay on the old rename key.

- [ ] **Step 3: Add the cleanup statements**

In `worker/files.js`, add to `LESSON_ROWS` after the `watched` line:

```js
'UPDATE OR REPLACE bookmarks SET lesson = ? WHERE lesson = ?',
```

Add to `LESSON_DELETES` after the `watched` line:

```js
'DELETE FROM bookmarks WHERE lesson = ?',
```

and add `'bookmarks'` to `LESSON_TABLES`.

In `worker/index.js`, in the admin YouTube delete block, after the
`DELETE FROM resources` line, add:

```js
await env.DB.prepare('DELETE FROM bookmarks WHERE lesson = ?').bind(id).run();
```

In the user-delete batch, next to the notes deletes, add:

```js
env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ?').bind(id),
```

A folder/course delete will reach the same `LESSON_DELETES` statements through
`lessonKeysUnder`; adding `bookmarks` to `LESSON_TABLES` is what lets an
interrupted delete find the key after the R2 object is already gone.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
`node --experimental-strip-types --test worker/security.test.mjs worker/youtube-rename.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add worker/files.js worker/index.js worker/security.test.mjs worker/youtube-rename.test.mjs
git commit -m "feat: clean up bookmarks with lessons and users"
```

---

### Task 5: Lesson-bar toggle

**Files:**
- Modify: `src/app/api.ts:5` (`Lesson`), `src/app/api.ts:191-206` (after `setDone`)
- Modify: `src/app/course.ts:94-108` (lesson bar), `src/app/course.ts:362` (methods)
- Modify: `src/styles.css:216-219` and the phone block near `src/styles.css:567-576`

**Interfaces:**
- Consumes: `bookmarked` / `bookmarkedAt` from `/api/course`.
- Produces: `Api.setBookmark(id: string, bookmarked: boolean): Promise<void>`.
- Produces: a `.bookmark-btn` in the lesson bar calling `setBookmark`.

- [ ] **Step 1: Extend the client type and API**

In `src/app/api.ts`, change `Lesson` to:

```ts
export interface Lesson { id: string; title: string; kind: 'video' | 'pdf' | 'txt' | 'md' | 'youtube'; done: boolean; bookmarked: boolean; bookmarkedAt?: number; subtitles?: Subtitle[] }
```

After `setDone()`, add:

```ts
async setBookmark(id: string, bookmarked: boolean): Promise<void> {
  const before = this.courses()
    .flatMap((c) => c.sections)
    .flatMap((s) => s.lessons)
    .find((l) => l.id === id);
  const at = bookmarked ? Date.now() : undefined;
  const apply = (value: boolean, when: number | undefined) => this.courses.update((courses) => courses.map((c) => ({
    ...c,
    sections: c.sections.map((s) => ({
      ...s,
      lessons: s.lessons.map((l) => (l.id === id ? { ...l, bookmarked: value, bookmarkedAt: when } : l)),
    })),
  })));
  apply(bookmarked, at); // optimistic: update the UI first
  try {
    await this.req('bookmarks', { lesson: id, bookmarked });
  } catch (e) {
    apply(before?.bookmarked ?? !bookmarked, before?.bookmarkedAt); // roll back
    throw e;
  }
}
```

- [ ] **Step 2: Add the button to the lesson bar**

In `src/app/course.ts`, between the PDF notes controls and the done button, add:

```html
<button type="button" class="bookmark-btn" [class.is-on]="l.bookmarked"
  [attr.aria-pressed]="l.bookmarked"
  [attr.aria-label]="l.bookmarked ? 'Remove bookmark' : 'Bookmark lesson'"
  [title]="l.bookmarked ? 'Remove bookmark' : 'Bookmark lesson'" (click)="bookmark(l)">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21z" /></svg>
  <span class="lbl">{{ l.bookmarked ? 'Bookmarked' : 'Bookmark' }}</span>
</button>
```

Next to `toggle()` at the end of the class, add:

```ts
protected bookmark(l: Lesson): void { void this.api.setBookmark(l.id, !l.bookmarked); }
```

- [ ] **Step 3: Style the button**

In `src/styles.css`, after the `.done-btn.is-done:hover` rule, add:

```css
.bookmark-btn{flex:none;min-height:32px;padding:0 .8rem;font-weight:500;white-space:nowrap;border-radius:var(--r-ctl);color:var(--muted)}
.bookmark-btn svg{width:15px;height:15px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.bookmark-btn.is-on{color:var(--primary);background:transparent}
.bookmark-btn.is-on svg{fill:currentColor}
```

In the `max-width:760px` block, next to the `.done-btn` phone rules, add:

```css
.player-bar .bookmark-btn .lbl{display:none}
.player-bar .bookmark-btn{flex:0 0 auto;width:40px;min-height:40px;padding:0;justify-content:center}
```

- [ ] **Step 4: Verify the frontend**

Run: `npm run typecheck`
Expected: pass.
Run: `npm run build`
Expected: pass.
Run: `npm test`
Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api.ts src/app/course.ts src/styles.css
git commit -m "feat: add the lesson bookmark toggle"
```

---

### Task 6: Bookmarks page, route and menu item

**Files:**
- Create: `src/app/bookmark-rows.ts`, `src/app/bookmarks.ts`,
  `src/app/bookmark-rows.test.mjs`
- Modify: `src/app/app.routes.ts`, `src/app/options-menu.ts`, `src/styles.css`

**Interfaces:**
- Consumes: `Lesson.bookmarked` / `Lesson.bookmarkedAt` from Task 5 and
  `Api.setBookmark()`.
- Produces: `bookmarkRows(courses: CourseData[]): BookmarkRow[]`, where
  `BookmarkRow` is `{ lesson, title, kind, course, section, bookmarkedAt }`,
  newest first.
- Produces: the `Bookmarks` component and `/bookmarks` route.

- [ ] **Step 1: Write the failing row-builder test**

Create `src/app/bookmark-rows.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkRows } from './bookmark-rows.ts';

const lesson = (id, title, bookmarked, bookmarkedAt) => ({
  id, title, kind: 'video', done: false, bookmarked,
  ...(bookmarkedAt ? { bookmarkedAt } : {}),
});
const course = (title, sections) => ({ title, description: '', sections });

test('bookmarkRows keeps only bookmarked lessons and labels their section', () => {
  const rows = bookmarkRows([
    course('Course', [
      { title: null, lessons: [lesson('Course/root', 'Root', true, 10), lesson('Course/plain', 'Plain', false)] },
      { title: 'Week 1', lessons: [lesson('Course/Week 1/one', 'One', true, 30)] },
    ]),
    course('Other', [{ title: 'Hidden', lessons: [lesson('Other/hidden', 'Hidden', true, 20)] }]),
  ]);
  assert.deepEqual(rows.map((r) => [r.lesson, r.course, r.section]), [
    ['Course/Week 1/one', 'Course', 'Week 1'],
    ['Other/hidden', 'Other', 'Hidden'],
    ['Course/root', 'Course', ''],
  ]);
});

test('bookmarkRows gives equal timestamps a stable course/section/title order', () => {
  const rows = bookmarkRows([
    course('B', [{ title: 'S', lessons: [lesson('B/S/b', 'B lesson', true, 0)] }]),
    course('A', [{ title: 'S', lessons: [lesson('A/S/b', 'B lesson', true, 0), lesson('A/S/a', 'A lesson', true, 0)] }]),
  ]);
  assert.deepEqual(rows.map((r) => r.lesson), ['A/S/a', 'A/S/b', 'B/S/b']);
});

test('bookmarkRows shows nothing from a locked course payload', () => {
  assert.deepEqual(bookmarkRows([{ title: 'Locked', description: '', locked: true, sections: [] }]), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test src/app/bookmark-rows.test.mjs`
Expected: fails because `./bookmark-rows.ts` does not exist.

- [ ] **Step 3: Implement the pure row builder**

Create `src/app/bookmark-rows.ts`:

```ts
import type { CourseData, Lesson } from './api';

export interface BookmarkRow {
  lesson: string;
  title: string;
  kind: Lesson['kind'];
  course: string;
  section: string;
  bookmarkedAt: number;
}

const NAME = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The bookmarks page rows: every bookmarked lesson the user can currently see, newest first. */
export function bookmarkRows(courses: CourseData[]): BookmarkRow[] {
  const rows: BookmarkRow[] = [];
  for (const course of courses) {
    for (const section of course.sections) {
      for (const lesson of section.lessons) {
        if (!lesson.bookmarked) continue;
        rows.push({
          lesson: lesson.id,
          title: lesson.title,
          kind: lesson.kind,
          course: course.title,
          section: section.title || '',
          bookmarkedAt: lesson.bookmarkedAt || 0,
        });
      }
    }
  }
  return rows.sort((a, b) =>
    b.bookmarkedAt - a.bookmarkedAt ||
    NAME.compare(a.course, b.course) ||
    NAME.compare(a.section, b.section) ||
    NAME.compare(a.title, b.title) ||
    NAME.compare(a.lesson, b.lesson));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --experimental-strip-types --test src/app/bookmark-rows.test.mjs`
Expected: pass.

- [ ] **Step 5: Create the page component**

Create `src/app/bookmarks.ts` with the same component style as `course.ts`
(`ChangeDetectionStrategy.Eager`, inline template, no component styles). The
component imports `ChangeDetectionStrategy`, `Component`, `computed`, `inject`,
`signal` from `@angular/core`, `Router` from `@angular/router`, `Api` from
`./api`, `bookmarkRows` and `type BookmarkRow` from `./bookmark-rows`, and
`lessonUrl` from `./course-route`. The class signatures are:

```ts
export class Bookmarks {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly rows = computed(() => bookmarkRows(this.api.courses()));
  protected readonly error = signal('');

  protected open(b: BookmarkRow): void;
  protected remove(b: BookmarkRow): Promise<void>;
  protected home(): void;
}
```

`open()` navigates with `lessonUrl(b.course, b.lesson)`, `home()` navigates to
`/`, and `remove()` clears the error, awaits `api.setBookmark(b.lesson, false)`,
and on failure sets `Could not update the bookmark. Please try again.` It renders:

```html
<main data-scroll-top>
  <div class="list">
    <nav class="breadcrumb" aria-label="Location">
      <button class="bc-btn" (click)="home()">Courses</button>
      <span class="bc-sep">/</span>
      <span>Bookmarks</span>
    </nav>
    <h1 class="page-title">Bookmarks</h1>
    @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    @for (b of rows(); track b.lesson) {
      <div class="bm-row">
        <button type="button" class="bm-open" (click)="open(b)">
          <span class="row-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z" /></svg>
          </span>
          <span class="bm-text">
            <span class="row-name">{{ b.title }}</span>
            <span class="bm-path">{{ b.course }}{{ b.section ? ' / ' + b.section : '' }}</span>
          </span>
        </button>
        <button type="button" class="icon-btn bm-remove"
          [attr.aria-label]="'Remove bookmark: ' + b.title" title="Remove bookmark" (click)="remove(b)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
        </button>
      </div>
    } @empty {
      <p class="empty">No bookmarks yet. Open a lesson and use the bookmark button.</p>
    }
  </div>
</main>
```

`open(row)` calls `router.navigate(lessonUrl(row.course, row.lesson))`; `home()`
calls `router.navigateByUrl('/')`; `remove(row)` clears `error`, awaits
`api.setBookmark(row.lesson, false)`, and on failure sets
`Could not update the bookmark. Please try again.`

- [ ] **Step 6: Add the route and the menu item**

In `src/app/app.routes.ts`, before the `admin` route, add:

```ts
{ path: 'bookmarks', loadComponent: () => import('./bookmarks').then((m) => m.Bookmarks) },
```

In `src/app/options-menu.ts`, inject `Router`, add
`openBookmarks()` that closes the menu and runs
`void this.router.navigateByUrl('/bookmarks')`, and put this first inside the
`role="menu"` element:

```html
<button type="button" role="menuitem" (click)="openBookmarks()">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21z" /></svg>
  Bookmarks
</button>
```

- [ ] **Step 7: Style the page rows**

In `src/styles.css`, after the course-list block, add:

```css
/* Bookmarks page */
.bm-row{display:flex;align-items:center;gap:.25rem;border-bottom:1px solid var(--border)}
.bm-row:last-child{border-bottom:0}
.bm-open{flex:1;min-width:0;display:flex;align-items:center;gap:.6rem;padding:.55rem .5rem;text-align:left}
.bm-text{display:grid;gap:.08rem;min-width:0}
.bm-path{font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bm-remove{flex:none;opacity:0}
.bm-row:hover .bm-remove,.bm-row:focus-within .bm-remove{opacity:1}
@media(hover:none){.bm-remove{opacity:1}}
```

- [ ] **Step 8: Verify the frontend**

Run: `npm run typecheck`
Expected: pass.
Run: `npm run build`
Expected: pass.
Run: `npm test`
Expected: all tests pass, including `src/app/bookmark-rows.test.mjs`.

- [ ] **Step 9: Commit**

```bash
git add src/app/bookmark-rows.ts src/app/bookmark-rows.test.mjs src/app/bookmarks.ts src/app/app.routes.ts src/app/options-menu.ts src/styles.css
git commit -m "feat: add the bookmarks page and menu item"
```
