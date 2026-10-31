# Lesson discussion, notes and resources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every video lesson a panel with threaded comments, private autosaving notes, and admin-authored resources.

**Architecture:** D1 tables + nine Worker routes behind the existing session/enrolment check; an Angular `LessonPanel` mounted under `<app-player>` (videos only) with notes owned by the panel and Discussion/Resources as child components.

**Tech Stack:** Angular 20 standalone components + signals, Cloudflare Workers, D1, plain CSS in `src/styles.css`.

**Spec:** `docs/superpowers/specs/2026-10-31-lesson-discussion-design.md`

## Global Constraints

- Videos only: the panel must not render for `kind === 'pdf'`.
- Comments, likes, notes and resources require a session and course access; admins bypass enrolment.
- Show the email local part to students; full email stays admin-only.
- Comment 1–1000 chars; note ≤ 20 000; resource title 1–120, URL 1–800 http(s), note ≤ 300.
- 10 comments per user per 5 minutes; 500-comment response cap.
- Replies are one level deep; deleting a top-level comment removes its replies and all their likes.
- No bordered surfaces: fill + `var(--shadow)`, 14px radius, 44px touch targets on phones.
- No test runner exists: verification is `curl` against `wrangler dev` plus browser checks.

## Review Focus

- A pending note autosave firing against the *next* lesson's key (wrong-data write) — Task 6 tests switching lessons mid-edit.
- Autosave beating the initial GET and blanking a saved note — Task 6 tests open-then-type.
- A student reaching another course's comments by hand-editing a key — Task 2 tests 403 for an unenrolled key.
- Deleting a comment leaving orphaned likes/replies — Task 2 tests the count afterwards.
- A student seeing admin resource controls — Task 8 tests the DOM has no add form for a student.

---

### Task 1: Schema and cleanup

**Files:**
- Modify: `worker/index.js:47-50` (SCHEMA), `worker/index.js:477-483` (delete user)

**Interfaces:**
- Produces: tables `comments`, `comment_likes`, `video_notes`, `resources` as defined in the spec.

- [ ] **Step 1:** Append the four `CREATE TABLE` statements and two `CREATE INDEX` statements from the spec to `SCHEMA`.
- [ ] **Step 2:** In the admin delete-user batch add `DELETE FROM comments WHERE user_id = ?`, `DELETE FROM video_notes WHERE user_id = ?`, and `DELETE FROM comment_likes WHERE user_id = ?` (bind `id`). Do not touch `resources`.
- [ ] **Step 3:** Run `cd /tmp/opencode/course-site && npx wrangler dev --port 8787 --local` and confirm the log has no D1 errors; `curl -s -b cj.txt http://127.0.0.1:8787/api/me` returns the user.
- [ ] **Step 4:** Commit `feat: add tables for lesson comments, notes and resources`.

### Task 2: Comments API

**Files:**
- Modify: `worker/index.js` (helpers near `courseOf`, routes after the `/api/progress` block)

**Interfaces:**
- Consumes: `myCourses(env,u)`, `listCourse(env)`, `courseOf(key)`.
- Produces: `lessonAccess(env, u, key)` → `'ok' | 'missing' | 'denied'`; routes
  - `GET /api/lesson/:key/comments` → `{ comments: CommentRow[] }`
  - `POST /api/lesson/:key/comments` `{ body, parent? }` → `{ comment: CommentRow }`
  - `POST /api/comments/:id/like` → `{ liked: boolean, likes: number }`
  - `DELETE /api/comments/:id` → `{ ok: true }`

`CommentRow` = `{ id, parent_id, body, created, name, initial, likes, liked, own, can_delete }` (spec shows the shape).

- [ ] **Step 1:** Implement `lessonAccess` by finding the key in the cached `listCourse()` tree (404 when absent) and, for non-admins, checking `myCourses` contains `courseOf(key)` (403 otherwise).
- [ ] **Step 2:** Implement `GET` with `SELECT c.*, u.email FROM comments c JOIN users u ON u.id = c.user_id WHERE c.lesson = ? ORDER BY c.created DESC LIMIT 500`, then a second query for like counts and the caller's likes; map to `CommentRow` with `name = email.split('@')[0]`, `initial = name[0].toUpperCase()`.
- [ ] **Step 3:** Implement `POST`: trim/strip control chars, enforce 1–1000, reject a `parent` that is not a top-level comment on the same lesson, enforce the 10-per-5-minutes limit (`SELECT COUNT(*) FROM comments WHERE user_id = ? AND created > ?`), insert, and return the row.
- [ ] **Step 4:** Implement like toggle (`INSERT OR IGNORE` / `DELETE`) returning the fresh count, and delete: author or admin only (`403`), top-level deletes replies plus likes of the comment and replies in one `batch`.
- [ ] **Step 5:** Verify with curl: post as admin, list, like, unlike, reply, delete parent, then `SELECT COUNT(*)` for leftover rows (expect 0).
- [ ] **Step 6:** Commit `feat: add lesson comment API`.

### Task 3: Notes API

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Produces: `GET /api/lesson/:key/notes` → `{ body: string }`; `PUT /api/lesson/:key/notes` `{ body }` → `{ ok: true }`.

- [ ] **Step 1:** Reuse `lessonAccess`; scope both queries to `u.id` and the key.
- [ ] **Step 2:** `PUT` trims trailing whitespace only, rejects `> 20000` with `413`, deletes the row when the body is empty, else upserts with `updated = Date.now()`.
- [ ] **Step 3:** Verify two different users' notes stay separate and that an unenrolled key returns `403`.
- [ ] **Step 4:** Commit `feat: add private video notes API`.

### Task 4: Resources API

**Files:**
- Modify: `worker/index.js`

**Interfaces:**
- Produces: `GET /api/lesson/:key/resources` → `{ resources: [{ id, title, url, note }] }`; `POST /api/admin/lesson/:key/resources` → `{ resource }`; `DELETE /api/admin/resources/:id` → `{ ok: true }`.

- [ ] **Step 1:** `GET` ordered by `created ASC`, available to anyone with access.
- [ ] **Step 2:** `POST`/`DELETE` under the existing `if (path.startsWith('/api/admin/'))` admin gate: validate title/url/note, parse the URL with `new URL` and require `http:`/`https:`, cap 100 per lesson.
- [ ] **Step 3:** Verify a student POST returns `403`, an invalid URL returns `400`, admin add/list/delete works.
- [ ] **Step 4:** Commit `feat: add admin lesson resources API`.

### Task 5: Client API methods

**Files:**
- Modify: `src/app/api.ts`

**Interfaces:**
- Produces:
  - `interface Comment { id: number; parent_id: number | null; body: string; created: number; name: string; initial: string; likes: number; liked: boolean; own: boolean; can_delete: boolean }`
  - `interface ResourceItem { id: number; title: string; url: string; note: string | null }`
  - `comments(key: string): Promise<{ comments: Comment[] }>`
  - `postComment(key: string, body: string, parent?: number): Promise<{ comment: Comment }>`
  - `likeComment(id: number): Promise<{ liked: boolean; likes: number }>`
  - `deleteComment(id: number): Promise<unknown>`
  - `videoNotes(key: string): Promise<{ body: string }>`
  - `saveVideoNotes(key: string, body: string): Promise<unknown>`
  - `resources(key: string): Promise<{ resources: ResourceItem[] }>`
  - `addResource(key: string, r: { title: string; url: string; note?: string }): Promise<{ resource: ResourceItem }>`
  - `deleteResource(id: number): Promise<unknown>`

- [ ] **Step 1:** Add the interfaces and methods using `encodeURIComponent(key)` (mirroring `getNotes`).
- [ ] **Step 2:** `npm run build` passes.
- [ ] **Step 3:** Commit `feat: add lesson discussion API client`.

### Task 6: `LessonPanel` with Notes

**Files:**
- Create: `src/app/lesson-panel.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `Api.videoNotes/saveVideoNotes`, `Lesson` from `api.ts`.
- Produces: `<app-lesson-panel [lesson]="lesson" />`; renders `<app-discussion [lesson]="lesson" (count)="commentCount.set($event)" />` and `<app-lesson-resources [lesson]="lesson" (count)="resourceCount.set($event)" />` (Tasks 7–8).

- [ ] **Step 1:** Create the component with `input.required<Lesson>()`, `active = signal<'discussion'|'notes'|'resources'>('discussion')`, counts, and the tab bar (`role="tab"`, `aria-selected`, accent fill when active).
- [ ] **Step 2:** Notes state: `notes = signal('')`, `status = signal<'idle'|'saving'|'saved'|'error'>('idle')`, `loadedKey`, `dirty`, a debounce timer, and `effect` on `lesson().id` that (a) flushes the previous key's pending body, (b) loads the new key before allowing saves.
- [ ] **Step 3:** Autosave 800 ms after input; flush on `DestroyRef`; never save before the key's GET resolved or when the body is unchanged.
- [ ] **Step 4:** Render the notes tab: lock line, textarea, status text; placeholder "Your notes for this lesson. Only you can see them."
- [ ] **Step 5:** Verify in the browser: type, wait, reload the lesson (text persists); switch lessons mid-typing (old lesson keeps its text, new lesson is not overwritten); open a second user's session and confirm different text.
- [ ] **Step 6:** Commit `feat: add lesson panel with private notes`.

### Task 7: Discussion component

**Files:**
- Create: `src/app/discussion.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `Api.comments/postComment/likeComment/deleteComment`.
- Produces: `<app-discussion [lesson]="lesson" (count)="…" />`, emits `count` after every load/mutation.

- [ ] **Step 1:** Load on init and when `lesson().id` changes; group flat rows: top-level newest first, replies per parent oldest first.
- [ ] **Step 2:** Composer with avatar initial, char counter past 900, Post disabled when empty/posting, `Ctrl/Cmd+Enter`.
- [ ] **Step 3:** Items: avatar, name, relative time (`now`, `5m`, `2h`, `3d`, else date), body (interpolation), like toggle with count, Reply, delete for `can_delete` with `confirm()`; show replies collapsed behind "Show N replies"; inline reply composer.
- [ ] **Step 4:** Empty, loading, and error states (`Retry`).
- [ ] **Step 5:** Verify: post, reply, like/unlike, delete parent removes replies; a student cannot delete another's comment; the count badge updates.
- [ ] **Step 6:** Commit `feat: add lesson discussion UI`.

### Task 8: Resources component

**Files:**
- Create: `src/app/lesson-resources.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `Api.resources/addResource/deleteResource`, `Api.me()`.
- Produces: `<app-lesson-resources [lesson]="lesson" (count)="…" />`.

- [ ] **Step 1:** Load list on init/key change; rows link out with `target="_blank" rel="noopener noreferrer"`, hostname muted, note below.
- [ ] **Step 2:** When `api.me()?.is_admin`, render the add form (title, URL, note) and a delete icon per row with confirmation.
- [ ] **Step 3:** Empty state "No resources for this lesson yet."; inline form validation message from the server.
- [ ] **Step 4:** Verify as admin (add, delete) and as a student (no form, links open).
- [ ] **Step 5:** Commit `feat: add lesson resources tab`.

### Task 9: Mount in the player and style

**Files:**
- Modify: `src/app/course.ts:73-82` (player view)
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `LessonPanel` (Task 6).

- [ ] **Step 1:** In the `@else` branch of the player body add `<app-lesson-panel [lesson]="l" />` and register the import.
- [ ] **Step 2:** Style `.lp-*` classes: panel surface, tab bar, composer, comment rows, reply indentation, notes textarea, resource rows, status text. Phone block at `≤760px`: full-width tabs, 44px Post, panel gutter `.8rem`.
- [ ] **Step 3:** Verify video lessons show the panel and scroll inside `.player-body`; PDF lessons show nothing new.
- [ ] **Step 4:** Verify at 393px and 320px: no horizontal overflow, tabs fit, composer usable.
- [ ] **Step 5:** Commit `feat: show discussion, notes and resources under video lessons`.

### Task 10: End-to-end pass and ship

**Files:** none

- [ ] **Step 1:** With `wrangler dev` + `ng serve`, run the curl suite from Tasks 2–4 once more on a clean DB.
- [ ] **Step 2:** Browser: admin and a student in two sessions; post/reply/like/delete, notes isolation, resource add/delete, PDF regression.
- [ ] **Step 3:** `npm run build`, commit any fixes, push `main`.
- [ ] **Step 4:** Poll `npx wrangler deployments list` for a new `Created:`; confirm the live asset hashes match `dist/web/browser`.
- [ ] **Step 5:** Copy changed files to `/tmp/opencode/deliverable/`.