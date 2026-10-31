# Course File Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner an admin-only file manager on the course site: upload any file (large videos included) straight into the course tree, and rename, move, delete, and create folders — with student notes, comments, progress, resources, and enrollments following every structural change.

**Architecture:** The Worker signs R2 S3 requests (`aws4fetch`); the browser uploads parts directly to R2 with presigned URLs, so nothing large passes through the Worker. Structural edits copy objects with the R2 binding (streaming, no size ceiling), rewrite the D1 rows in the same operation, then delete the originals — in that order, idempotently. A new admin view (`app-admin-files`) drives the tree and an uploader that mostly lives in plain TypeScript.

**Tech Stack:** Angular 21 signals (standalone components, no router), Cloudflare Worker (single entry, ES modules), D1, R2 (binding + S3 API), `aws4fetch`, Python stdlib for API verification, CDP for browser checks.

**Spec:** `docs/superpowers/specs/2026-10-31-course-file-manager-design.md`

## Global Constraints

- Admin-only. Every new route lives under `/api/admin/` and is reached after the existing `if (!u.is_admin) return json({ error: 'Admins only' }, 403)` guard in `worker/index.js`.
- R2 binding is renamed `VIDEOS` → `RESOURCES` (owner's request). Bucket name stays `course-sourse`.
- Secrets are never committed: real values only in `.dev.vars` (gitignored); `.dev.vars.example` gets placeholders.
- New env vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (optional, default `course-sourse`).
- Object keys: at least one `/`, ≤ 500 characters, no `..`, no leading `/`, no backslashes, no control characters.
- A lesson key is a `.pdf`, or a video extension (`.mp4|.webm|.mkv|.mov|.avi|.m4v|.m3u8`) that is not a `.ts` segment. Only lesson keys carry student data.
- Multipart: parts ≥ 5 MiB except the last, ≤ 10,000 parts, 8 MiB default and scaled up so 10,000 is never exceeded. Files ≤ 16 MiB use a single presigned PUT.
- Presigned URLs expire in 3600 s.
- D1 batches are chunked at 50 statements, matching existing code.
- UI: existing theme tokens, fill + soft shadow, **no 1-px strokes**, inline stroke SVG icons only (no emoji or text glyphs), usable at 320 / 393 / 1200 px.
- No new dependency in the Angular bundle. `aws4fetch` is imported only by the Worker.
- Every commit is pushed to `main`; Workers Builds deploys automatically.

## Review Focus

1. **Course and lesson names that are real in this bucket** — spaces, `&`, `#`, parentheses (`Web_Design_&_Development-1_(Record_Class)/3_Chapter_#_04.mp4`). A `#` or `&` must survive the query string, the JSON body, `encodeURIComponent`, and the presigned URL without truncation.
2. **A rename or move that would detach student data** — a lesson may not become a non-lesson, and a course rename must take its enrollments along. Expect: the operation either keeps the data attached or refuses.
3. **A move whose destination already exists, or that targets its own descendant** — expect a refusal with the tree unchanged, never a half-copied folder.
4. **An upload interrupted mid-part or by a page reload** — expect only the missing parts to be re-sent, and a clear restart when the upload no longer exists.
5. **Deleting a lesson or course that students have used** — expect the rows to go with it, and for a course, its enrollments.

---

## Task 1: Configuration, binding rename, cache invalidation

**Files:**
- Modify: `wrangler.toml`
- Modify: `.dev.vars.example`
- Modify: `worker/index.js`
- Modify: `.dev.vars` (local only, never committed)

**Interfaces:**
- Consumes: nothing.
- Produces: `env.RESOURCES` (R2 binding), `invalidateCourse(): void` exported from `worker/index.js`, and `r2Config(env)` in `worker/s3.js` returning `{ accountId, accessKeyId, secretAccessKey, bucket }` or `null` when unset.

- [ ] **Step 1: Record the baseline.** Run `python3 /tmp/opencode/verify-discussion.py` against the running `wrangler dev` on :8787. Expect `35 passed, 0 failed`. This is the regression guard for the binding rename.

- [ ] **Step 2: Rename the binding and wire the config**

In `wrangler.toml`, `binding = "VIDEOS"` → `binding = "RESOURCES"`. In `worker/index.js`, replace both `env.VIDEOS` uses (lines ~141 `list` and ~278 `get`) with `env.RESOURCES`. Export the cache reset:

```js
export function invalidateCourse() { cache = { at: 0, data: null }; }
```

- [ ] **Step 3: Add the secrets.** Put the four values in `.dev.vars` (real R2 token values, plus `R2_ACCOUNT_ID=2ee4cb2f8d4de267cc9e18ae77430723`). Add the same four keys to `.dev.vars.example` with placeholder text and a comment pointing at the bucket CORS requirement.

- [ ] **Step 4: Verify nothing regressed.** Re-run `python3 /tmp/opencode/verify-discussion.py` → `35 passed, 0 failed`. Then `curl -s -b /tmp/opencode/cj.txt http://127.0.0.1:8787/api/course | head -c 200` returns the course JSON (proves `env.RESOURCES` reads the bucket).

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml .dev.vars.example worker/index.js
git commit -m "refactor: rename the R2 binding to RESOURCES and add S3 config"
```

## Task 2: Listing API

**Files:**
- Create: `worker/files.js`
- Modify: `worker/index.js` (dispatch)
- Create: `/tmp/opencode/verify-files.py`

**Interfaces:**
- Consumes: `env.RESOURCES`, `invalidateCourse` passed in by the dispatcher.
- Produces: `handleFiles(req, env, path, method, url, hooks): Promise<Response | null>` in `worker/files.js`, where `hooks = { invalidate: () => void }`; `null` means "not a file route". Also `cleanKey(raw): string | null`, `isLessonKey(key): boolean`.

- [ ] **Step 1: Seed fixtures into the local bucket**

```bash
npx wrangler r2 object put "course-sourse/Test Course & Co/Intro #1.mp4" --file /tmp/opencode/dummy.mp4 --local
npx wrangler r2 object put "course-sourse/Test Course & Co/Section A/notes.pdf" --file /tmp/opencode/audit.pdf --local
npx wrangler r2 object put "course-sourse/Test Course & Co/Section A/.keep" --file /dev/null --local
```

- [ ] **Step 2: Write the failing checks** in `/tmp/opencode/verify-files.py`, reusing the `Client`/`check` harness from `verify-discussion.py`:

```python
# admin only
check("anonymous cannot list files", anon.req("GET", "/api/admin/files")[0] == 401)
check("student cannot list files", student.req("GET", "/api/admin/files")[0] == 403)
# real-world names survive
st, body = admin.req("GET", "/api/admin/files?prefix=" + urllib.parse.quote("Test Course & Co/Section A"))
check("listing returns the section", st == 200 and [d["name"] for d in body["files"]] == ["notes.pdf"], body)
check("hidden .keep is not listed", all(e["name"] != ".keep" for e in body["files"]))
st, body = admin.req("GET", "/api/admin/files")
check("root lists courses", "Test Course & Co" in [d["name"] for d in body["dirs"]], body)
```

- [ ] **Step 3: Run it to make sure it fails.** `python3 /tmp/opencode/verify-files.py` → the list checks fail with 404.

- [ ] **Step 4: Implement `GET /api/admin/files`.** `cleanKey` trims, strips control characters, rejects `..`/`\`/leading `/`, collapses `//`, requires a `/` unless the prefix is `''`, and caps at 500. Listing walks `env.RESOURCES.list({ prefix, delimiter: '/' })`; `delimitedPrefixes` become `dirs`, objects become `files` with `lesson: isLessonKey(key)` and `hls: key.endsWith('/index.m3u8')`. `prefix` is optional; a missing prefix lists the root. Skip `.keep` and `.ts`. Return `{ path, dirs, files }` sorted with a numeric collator.

- [ ] **Step 5: Wire it in.** Inside the existing admin block in `worker/index.js`, before the final `return json({ error: 'Not found' }, 404)`:

```js
const handled = await handleFiles(req, env, path, m, new URL(req.url), { invalidate: invalidateCourse });
if (handled) return handled;
```

- [ ] **Step 6: Run and confirm pass**, then commit.

```bash
git add worker/files.js worker/index.js && git commit -m "feat: admin file listing API"
```

## Task 3: Move and rename, with lesson identity

**Files:**
- Modify: `worker/files.js`
- Modify: `/tmp/opencode/verify-files.py`

**Interfaces:**
- Consumes: `cleanKey`, `isLessonKey`, `hooks.invalidate`.
- Produces: `POST /api/admin/files/move { from, to, kind: 'file'|'folder' } -> { ok, moved }`; internal `moveLessonRows(env, from, to)` and `copyPrefix(env, from, to)`.

- [ ] **Step 1: Write the failing checks.** Seed a comment, a note, a resource, and a progress mark on `Test Course & Co/Intro #1.mp4` as the student, then:

```python
st, _ = admin.req("POST", "/api/admin/files/move", {"from": OLD, "to": NEW, "kind": "file"})
check("admin renames a lesson", st == 200)
check("object moved", admin.req("GET", "/api/admin/files?prefix=" + urllib.parse.quote("Test Course & Co"))[1]["files"][0]["key"] == NEW)
check("comments followed", len(student.req("GET", "/api/lesson/%s/comments" % urllib.parse.quote(NEW))[1]["comments"]) == 1)
check("notes followed", student.req("GET", "/api/lesson/%s/notes" % urllib.parse.quote(NEW))[1]["body"] == "my notes")
check("progress followed", NEW in [l["id"] for c in student.req("GET", "/api/course")[1] for s in c["sections"] for l in s["lessons"] if l["done"]])
check("resources followed", len(admin.req("GET", "/api/lesson/%s/resources" % urllib.parse.quote(NEW))[1]["resources"]) == 1)
check("lesson cannot become a non-lesson", admin.req("POST", "/api/admin/files/move", {"from": NEW, "to": NEW[:-4] + ".zip", "kind": "file"})[0] == 400)
check("destination must not exist", admin.req("POST", "/api/admin/files/move", {"from": NEW, "to": PDF, "kind": "file"})[0] == 409)
check("folder cannot move into itself", admin.req("POST", "/api/admin/files/move", {"from": "Test Course & Co/Section A", "to": "Test Course & Co/Section A/Inner", "kind": "folder"})[0] == 400)
check("refusals leave the tree unchanged", len(admin.req("GET", "/api/admin/files?prefix=" + urllib.parse.quote("Test Course & Co/Section A"))[1]["files"]) == 1)
```

- [ ] **Step 2: Run it to make sure it fails** (404 on the move route).

- [ ] **Step 3: Implement the move protocol** exactly as the spec orders it:
1. expand the source to objects (a file is one object; a folder is every key under `prefix + '/'`); refuse empty, refuse > 1,000 objects, refuse `to` inside `from`, refuse a folder moving to the root;
2. copy each object: if the target exists with the same size and ETag as the source, skip it; if it exists otherwise, abort and return 409;
3. rewrite D1 per lesson key (see below);
4. delete the old keys.

On a failure in steps 2–3, delete the copies this attempt wrote. `moveLessonRows` batches 50 statements:

```js
'UPDATE comments SET lesson = ? WHERE lesson = ?',
'UPDATE OR REPLACE video_notes SET lesson = ? WHERE lesson = ?',
'UPDATE OR REPLACE pdf_notes SET lesson = ? WHERE lesson = ?',
'UPDATE OR REPLACE watched SET lesson = ? WHERE lesson = ?',
'UPDATE resources SET lesson = ? WHERE lesson = ?',
```
plus, only when the first segment changes, `'UPDATE OR REPLACE enrollments SET course = ? WHERE course = ?'`, and when the parent now holds an `index.m3u8`, the same rewrite for `<from>/index.m3u8` → `<to>/index.m3u8`.

Call `hooks.invalidate()` on success.

- [ ] **Step 4: Run and confirm pass.** The identity checks are the point of this task; a green run here is the "student data follows the file" requirement.

- [ ] **Step 5: Commit**

```bash
git add worker/files.js && git commit -m "feat: move and rename files and folders, carrying lesson data"
```

## Task 4: Delete, with cleanup

**Files:**
- Modify: `worker/files.js`
- Modify: `/tmp/opencode/verify-files.py`

**Interfaces:**
- Consumes: the same helpers as Task 3.
- Produces: `POST /api/admin/files/delete { path, kind: 'file'|'folder' } -> { ok, deleted }`; internal `deleteLessonRows(env, key)`.

- [ ] **Step 1: Write the failing checks.**

```python
st, _ = admin.req("POST", "/api/admin/files/delete", {"path": LESSON, "kind": "file"})
check("admin deletes a lesson", st == 200)
check("object gone", LESSON not in listing_keys("Test Course & Co"))
check("comments gone", admin.req("GET", "/api/lesson/%s/comments" % urllib.parse.quote(LESSON))[0] == 404)
check("enrollments kept for a file delete", student.req("GET", "/api/course")[1][0]["title"] == "Test Course & Co")
st, _ = admin.req("POST", "/api/admin/files/delete", {"path": "Test Course & Co", "kind": "folder"})
check("admin deletes a course folder", st == 200)
check("course delete removes enrollments", all(c["title"] != "Test Course & Co" for c in student.req("GET", "/api/course")[1]))
```

- [ ] **Step 2: Run to confirm failure**, then implement: delete objects in chunks, then `deleteLessonRows` per lesson key — `comments` (and their replies via `parent_id`) plus their `comment_likes`, `video_notes`, `pdf_notes`, `watched`, `resources`. A folder delete also runs `DELETE FROM enrollments WHERE course = ?` when the folder is a course root.

- [ ] **Step 3: Run and confirm pass; commit.**

```bash
git add worker/files.js && git commit -m "feat: delete files and folders with their student data"
```

## Task 5: Create folder

**Files:**
- Modify: `worker/files.js`
- Modify: `/tmp/opencode/verify-files.py`

**Interfaces:**
- Produces: `POST /api/admin/files/folder { path } -> { ok }`.

- [ ] **Step 1: Failing check:** creating `Test Course & Co/Section B` returns 200, a second identical call returns 409, and the folder then appears under `Test Course & Co` in the listing while its `.keep` marker stays hidden.

- [ ] **Step 2: Implement:** validate with `cleanKey`, require a parent segment, write `env.RESOURCES.put(path + '/.keep', new Uint8Array())`, `hooks.invalidate()`.

- [ ] **Step 3: Run, confirm pass, commit** (`feat: create folders`).

## Task 6: Upload endpoints

**Files:**
- Create: `worker/s3.js`
- Modify: `worker/files.js`
- Modify: `package.json` (`npm i aws4fetch`)
- Modify: `/tmp/opencode/verify-files.py`

**Interfaces:**
- Consumes: `r2Config(env)` from Task 1.
- Produces: `s3Fetch(env, method, key, { query, body, headers })` and `presign(env, method, key, { query, expires, headers })` in `worker/s3.js`; routes `upload/start`, `upload/part`, `upload/url`, `upload/complete`, `upload/abort`, `upload/parts`.

- [ ] **Step 1: Failing checks** covering: a student gets 403; a missing key gets 400; `start` returns an `uploadId`; `part` returns a URL containing `X-Amz-Signature`; `complete` with a wrong ETag fails; `abort` succeeds; `parts` lists what was uploaded; `overwrite: false` on an existing key returns 409.

- [ ] **Step 2: Implement `worker/s3.js`** with `new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })` and `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`. Presigning uses `client.sign(url, { method, headers: { 'X-Amz-Expires': '3600' }, aws: { signQuery: true } })` and returns `signed.url`.

- [ ] **Step 3: Implement the routes.** `start` → `POST ?uploads`; `part` → presign `PUT` with `?partNumber=N&uploadId=...`; `complete` → `POST ?uploadId=...` with the XML body built from the parts (escape ETags); `abort` → `DELETE ?uploadId=...`; `parts` → `GET ?uploadId=...`, parsing `<Part>` entries; `url` → presign a `PUT` for a small file. Guard `size` (1 byte … 500 GB) and reuse `cleanKey`.

- [ ] **Step 4: Prove it against the real bucket.** Make a 6 MiB file, run start → part → PUT the bytes to the presigned URL with `curl --upload-file` → complete, then confirm with `rclone lsf r2:course-sourse --recursive` and delete the object with the admin delete route. This is the only step that touches the live R2 credentials.

- [ ] **Step 5: Run the suite, confirm pass, commit** (`feat: signed multipart upload endpoints`).

## Task 7: Frontend API client

**Files:**
- Modify: `src/app/api.ts`

**Interfaces:**
- Produces the exact methods the view uses: `listFiles(prefix)`, `createFolder(path)`, `moveEntry(from, to, kind)`, `deleteEntry(path, kind)`, `uploadStart(key, size, overwrite?)`, `uploadPartUrl(key, uploadId, partNumber)`, `uploadUrl(key, size, overwrite?)`, `uploadComplete(key, uploadId, parts)`, `uploadAbort(key, uploadId)`, `uploadParts(key, uploadId)`, plus `FileEntry`, `DirEntry`, `FileListing`, `UploadPart` types.

- [ ] **Step 1: Implement** using the existing private `req` helper; the listing must be `this.req(`admin/files?prefix=${encodeURIComponent(prefix)}`)` so `&` and `#` survive.

- [ ] **Step 2: Verify** `npx ng build` succeeds with no TypeScript errors.

- [ ] **Step 3: Commit** (`feat: file manager API client`).

## Task 8: Admin Files view

**Files:**
- Create: `src/app/admin-files.ts`
- Modify: `src/app/admin.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: every Task 7 method.
- Produces: `<app-admin-files />`, a standalone component.

- [ ] **Step 1: Build the component.** Signals `path`, `listing`, `busy`, `error`, dialog state. Breadcrumb from `path.split('/')`; folders first, then files; each row: icon, name, size, and actions rename / move / delete. `@for` with `track` on `key`. Dialogs for new folder, rename, and move (destination defaults to the current folder). Delete uses the shared confirm pattern; folder and course deletes require typing the name. `open(path)` reloads; `up()` goes to the parent.

- [ ] **Step 2: Add the entry point in `admin.ts`.** A `view = signal<'users'|'files'>('users')`, a "Files" button in `.adm-top-actions`, and in the template:

```html
@if (view() === 'files') { <app-admin-files /> } @else {
  <!-- existing users sections, unchanged -->
}
```

- [ ] **Step 3: Style it** in `src/styles.css` with the existing tokens; fill + soft shadow, SVG icons only.

- [ ] **Step 4: Browser check** with `ng serve` + `wrangler dev`: open Admin → Files, walk the seeded tree, create a folder, rename a file, delete it, and confirm the list matches the API. Screenshot at 1200 / 393 / 320 px.

- [ ] **Step 5: Commit** (`feat: admin file manager view`).

## Task 9: Upload UI with progress and resume

**Files:**
- Create: `src/app/upload.ts`
- Modify: `src/app/admin-files.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Produces: `class Uploader` with `readonly jobs = signal<UploadJob[]>([])`, `add(files: File[], folder: string)`, `resume(id: number, file: File)`, `cancel(id: number)`, `dispose()`.

- [ ] **Step 1: Implement the uploader.** Part size = `max(8 MiB, ceil(size / 9000) rounded up to 1 MiB)`; files ≤ 16 MiB use one presigned PUT. Upload parts with `XMLHttpRequest` (fetch cannot report upload progress), 3 at a time, `AbortController`-free cancel via `xhr.abort()`. Persist `{ key, size, lastModified, uploadId }` in `localStorage`; on `add`, if a stored uploadId exists, call `uploadParts` and send only the missing numbers. On complete, clear the entry and refresh the tree. A 404/410 on `uploadParts` means the upload no longer exists: drop the id and start over with a clear status.

- [ ] **Step 2: Wire it into the view** — a file input plus drag-and-drop on the listing area, a per-file progress row with size, percent, and retry/cancel, a "paused — re-select the file" state after a reload, and an explicit "replace it" confirm when a chosen name already exists (uploads refuse to overwrite otherwise).

- [ ] **Step 3: Browser check.** Upload a small file and a 20 MB file; watch progress reach 100%; confirm with `rclone lsf r2:course-sourse --recursive` that both landed; reload mid-upload and confirm only the missing parts are re-sent (network panel). Clean up with the delete route.

- [ ] **Step 4: Commit** (`feat: drag-and-drop uploads with progress and resume`).

## Task 10: Security policy, docs, and deploy

**Files:**
- Modify: `public/_headers`
- Modify: `docs/HANDOFF.md`
- Modify: `docs/SECURITY.md`
- Modify: `README.md`

- [ ] **Step 1: CSP.** Add the R2 endpoint to `connect-src` in the report-only policy: `https://2ee4cb2f8d4de267cc9e18ae77430723.r2.cloudflarestorage.com`.

- [ ] **Step 2: Bucket CORS.** PUT the rule via the Cloudflare API (the wrangler OAuth token works; the R2 `cfat_` token does not): origins `https://course-site.taxin.workers.dev`, `http://localhost:4200`, `http://192.168.0.101:4200`; methods `GET, HEAD, PUT, POST`; headers `content-type`; expose `ETag`; max age 3600. Re-GET it to confirm.

- [ ] **Step 3: Production secrets.** `npx wrangler secret put` for the four `R2_*` values (stdin, non-interactive).

- [ ] **Step 4: Docs.** `HANDOFF.md`: the new binding name and the file-manager routes in the architecture table. `SECURITY.md`: uploads go browser → R2, and why `connect-src` now names the bucket. `README.md`: where uploads happen and the `wrangler dev --remote` caveat.

- [ ] **Step 5: Deploy.** `npx ng build`, then commit and push `main`; confirm the Workers Builds deploy timestamp moved and that the live asset hash matches `dist/web/browser`.

- [ ] **Step 6: Live smoke test.** `/api/admin/files` answers 401 unauthenticated on the live site (admin-only routes stay closed), and a real upload is confirmed with `rclone` before handing the owner the final click-through.

## Task 11: Full verification pass

- [ ] **Step 1:** `python3 /tmp/opencode/verify-discussion.py` → 35/35, and `python3 /tmp/opencode/verify-files.py` → all checks pass.
- [ ] **Step 2:** Re-run the browser checks from Tasks 8 and 9 at 1200 / 393 / 320 px, plus a student account confirming it sees no admin controls.
- [ ] **Step 3:** Refresh `/tmp/opencode/deliverable/` with every changed file.
- [ ] **Step 4:** Commit the design and plan documents, and confirm `main` is clean.