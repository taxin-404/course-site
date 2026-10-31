# Course File Manager — Design

Date: 2026-10-31
Status: proposed (awaiting owner approval)

## 1. Intent

Today the owner adds course files by running `rclone` (or hitting the R2 API) from their own
machine. The hard part is never the transfer — it is putting the file at the right key, because
the R2 object key **is** the site's structure: `listCourse()` derives courses, sections and
lessons from key names alone.

The owner wants to do all of it from the course website: sign in as admin, drop a file in the
right place, and have it appear on the site — plus full "file manager" control over what is
already in the bucket (rename, move, delete, new folder).

The one thing that makes this more than a CRUD screen: **lesson identity is the key**. Notes,
comments, likes, resources and completion are all filed under the exact key string, and a
course name is what `enrollments` grants access to. So every structural edit has to carry that
data along, or students silently lose their work and their access.

## 2. Goals

1. Upload one or many files from the admin UI into any path in the course tree, including
   multi-gigabyte videos, with visible per-file progress, retry, and resume after a reload.
2. Full file-manager control: rename, move, and delete files; create, rename, and delete
   folders (sections and courses).
3. Structural edits preserve lesson identity: notes, comments, likes, resources, progress, and
   course enrollments follow the file to its new key.
4. Deletes clean up after themselves — no orphaned comments or notes left pointing at a key
   that no longer exists.
5. The UI matches the rest of the site: one theme, fill + soft shadow, inline stroke SVG icons,
   mobile-safe down to 320 px.
6. Nothing in the browser bundle gets a new dependency; the S3 signing lives in the Worker.

## 3. Non-goals

- **Not** a general bucket browser. It manages keys inside the course tree only (keys with at
  least one `/`, i.e. under a course folder). Root-level junk is not shown or editable.
- **Not** a multi-tenant CMS. One owner; everything is admin-only.
- **Not** versioned and **not** undoable. There is no trash bin or file history; deleting is
  final, guarded by a confirmation (typed for folders/courses). A trash bin is a possible
  later feature.
- **Not** a content editor. Files are moved around, never edited in place.
- **Not** bulk reorganization of thousands of objects in one action. Multi-select stays small
  (a folder's worth), and every folder operation runs as a bounded batch.
- No per-file permissions, no sharing links, no student-facing upload.

Anti-goal (what would make this a failure even if it works): a rename that quietly detaches a
lesson's comments, notes, or progress; or a course rename that un-enrolls every student.

## 4. Current state (verified)

- `worker/index.js` is the whole backend. R2 binding `VIDEOS` → bucket `course-sourse`;
  `/api/media/<key>` streams video/PDF; `listCourse()` walks every object key, ignores anything
  that is not video or PDF, skips `.ts` segments, and shows `index.m3u8` as a lesson titled by
  its parent folder. Results are cached in a module-level variable for 60 s.
- D1 tables that key on a lesson: `watched`, `pdf_notes`, `comments`, `video_notes`,
  `resources` (plus `comment_likes`, which hangs off `comments.id`). `enrollments.course` keys
  on the **first key segment**.
- The bucket today holds 8 objects, all flat video/PDF, no HLS:
  `CourseName/`, `Web_Design_&_Development-1_(Record_Class)/`, `dang/`, `dang/gg/`.
  Course names contain spaces, `&`, `#` and parentheses — path encoding gets attention.
- `tools/make-hls.sh` exists, so HLS lessons are possible even though none exist right now.
- `.dev.vars.example` documents local secrets; `.dev.vars` is gitignored; production secrets
  are set on the Worker.
- Local `wrangler dev` runs against a **local** R2 bucket (miniflare), which the S3 credentials
  cannot see. See §9.

## 5. How it gets made (mechanism)

Chosen by the owner: uploads go browser → R2 directly, signed by the Worker with the R2 S3 API.
Rejected default: piping file bytes through the Worker (Worker request bodies cap at ~100 MB,
and a multi-GB video would burn the request's time budget).

**Upload (large files, multipart):**

1. `POST /api/admin/files/upload/start` `{ key, size }` → Worker validates the key and admin
   rights, refuses if the key already exists (unless overwrite is requested and confirmed),
   calls S3 `CreateMultipartUpload`, returns `{ uploadId }`.
2. Browser slices the file into parts. Part size = 8 MiB by default, raised so the file never
   exceeds 10,000 parts (R2's cap). Every part except the last must be ≥ 5 MiB.
3. Per part: `POST /api/admin/files/upload/part` `{ key, uploadId, partNumber }` → Worker
   returns a **presigned `UploadPart` URL**. The browser `PUT`s the bytes straight to R2 and
   keeps the `ETag`. A presigned URL per part (rather than one signed set up front) keeps
   long uploads valid, at the cost of one tiny Worker call per part.
4. `POST /api/admin/files/upload/complete` `{ key, uploadId, parts }` → Worker calls
   `CompleteMultipartUpload`.
5. `POST /api/admin/files/upload/abort` on cancel. Abandoned uploads are also cleaned by an R2
   lifecycle rule (documented, configured once by hand).

**Upload (small files):** below the 5 MiB multipart minimum, a single presigned `PutObject`
URL is returned by `POST /api/admin/files/upload/url`, and the browser does one `PUT`.

**Resume:** the browser remembers `{ key, size, lastModified, uploadId }` in `localStorage`.
A reload cannot re-send bytes on its own — the `File` handle is gone — so an interrupted upload
returns as "paused", and the admin re-selects the same file (matched by name, size, and
last-modified). The client then asks `GET /api/admin/files/upload/parts?key=&uploadId=` (the
Worker calls `ListParts`) and sends only the missing parts. If the `uploadId` no longer exists —
expired, aborted, or swept by the lifecycle rule — the upload starts over and the UI says so
instead of pretending. While the tab is open, retries are per part with backoff; a failed part
never restarts the whole file.

**Rename / move:** R2 has no rename, so it is copy-then-delete, done through the R2 **binding** —
`get` the object and `put` its stream under the new key — rather than through the S3 API. That
copies any size without a 5 GiB ceiling, and it works against the local bucket in dev, where
the S3 credentials point at the real one. The cost is that bytes flow through the Worker; for a
multi-gigabyte video this is I/O-bound waiting, not CPU work.

Protocol, built to be **idempotent and retryable** — a half-finished move must never be stuck:

1. Expand the source into a list of objects. Refuse if the list is empty or longer than 1,000
   objects (split the operation instead), or if the destination is inside the source.
2. Copy each object. A target that already exists with the same size and ETag as its source is
   treated as already-copied and skipped, so a retry converges instead of being blocked by the
   "target exists" check. Any *other* existing target aborts the whole operation.
3. Rewrite the D1 rows for every lesson key (see §6), chunked into batches of 50 statements,
   the same chunking the existing code uses.
4. Delete the old objects, in batches.

Failure behaviour: a failure in step 2 removes the copies this attempt made and reports the
error — no partial state. A failure in step 3 removes those copies too, so the lesson is never
left pointing at nothing. A failure in step 4 leaves both copies present; retrying the same
operation is safe because step 2 skips the identical copies and step 3's `UPDATE OR REPLACE`
rewrite is repeatable, so the retry finishes the delete. Ordering matters: a D1 failure after an
old-object delete would orphan student data, which is why the delete is last.

**Move and rename rules** (they resolve the "silently detach" anti-goal):

- A rename may not change a lesson key into a non-lesson key (`lesson.mp4` → `lesson.zip`).
  That would move its comments, notes, and progress onto a key the site never shows — the exact
  failure this design exists to prevent. The endpoint refuses it and says why; delete is the
  honest way to remove a lesson.
- A non-lesson may be renamed to a lesson extension; it simply becomes a lesson.
- A lesson or section may move **into another course**. Its data follows the key, and the
  confirmation says who is affected: students enrolled in the source course lose it, students
  enrolled in the destination course gain it. Enrollments themselves are per course, so nothing
  is rewritten.
- A section may not move to the root (root-level files are not shown by `listCourse()`), and no
  item may move into itself or its own descendant.
- **Courses are never moved**, only renamed, created, and deleted — they are the top level by
  definition.

**Delete:** confirmation first (typed confirmation for a folder or course). Delete the objects
under the key/prefix (R2 batch deletes, in chunks), then remove the matching D1 rows.

**Folders:** R2 has no folders; they exist because keys share a prefix. "New folder" writes a
zero-byte `.keep` marker, which is already invisible to `listCourse()` (it ignores anything that
is not video/PDF) but visible to the file manager. Folder operations are just file operations
applied to every key under a prefix — plus, for a course, `UPDATE enrollments SET course = ?`.

**HLS:** a folder containing `index.m3u8` is one lesson whose id is `<folder>/index.m3u8`. The
file manager shows that folder as a single video item (its `seg_*.ts` siblings hidden), so
moving or deleting it moves/deletes the whole folder and carries the lesson's data. Not used in
the bucket today; the rule exists because `make-hls.sh` makes it reachable.

**Cache:** `listCourse()`'s 60 s cache is cleared after any structural change so the site
reflects edits immediately instead of up to a minute later. Small change, same module.

## 6. Keeping lesson identity (the core rule)

A lesson key is any key that is a video or PDF file, or an `index.m3u8`. On rename/move, in one
`env.DB.batch()`:

| Table | Rewrite | Note |
| --- | --- | --- |
| `comments` | `UPDATE comments SET lesson = ?` | replies are rows in the same table; they follow |
| `video_notes` | `UPDATE OR REPLACE` | PK `(user_id, lesson)` |
| `pdf_notes` | `UPDATE OR REPLACE` | PK `(user_id, lesson)` |
| `watched` | `UPDATE OR REPLACE` | PK `(user_id, lesson)` |
| `resources` | `UPDATE resources SET lesson = ?` | |
| `enrollments` | `UPDATE enrollments SET course = ?` | course rename/move only |

`UPDATE OR REPLACE` on the primary-keyed tables means a stray row already sitting on the target
key can never abort the whole move. Since the target key is required not to exist in R2, and
deletes clean up their rows, a collision should not happen — this is belt and braces.

On delete of a lesson, the same rows are removed: the lesson's `comments` and their replies,
their `comment_likes`, its `video_notes`, `pdf_notes`, `watched`, and `resources`. Deleting a
**course** also removes its `enrollments` rows — students lose access, which is the point of
deleting a course, and the confirmation says so.

## 7. Files in the bucket that are not lessons

Anything may be uploaded (a `.zip` of assets, for instance). Non-lesson files are listed and
manageable in the file manager but do not become lessons, and no lesson data attaches to them,
because `listCourse()` only surfaces video/PDF.

## 8. Admin UI

A new admin-only view, reachable from the existing admin panel (`src/app/admin.ts`), in its own
component (`src/app/admin-files.ts`). Not a route — the app has no router; `app.ts` already
switches between course and admin views, and this becomes a third view inside the admin area.

Contents:

- Breadcrumb + expandable tree of courses → sections → lessons/files, driven by a prefix listing.
- Row actions: rename, move (pick a destination folder), delete.
- Upload: button plus drag-and-drop onto the current folder; multiple files; an editable
  destination name per file; a note when a name already exists.
- Upload list: one row per file with progress, speed, remaining, pause/cancel, retry, and
  "resuming" state after a reload.
- Destructive confirmations: standard dialog for a file; typed name for a folder or course.
- Icons: inline stroke SVGs (folder, file, video, PDF, upload, rename, move, trash, chevron),
  matching the site's existing icon set. The CSS `›` chevron stays a decoration, not an icon.
- Theme: existing tokens, fill + soft shadow, no 1-px strokes; verified at 1200, 393, and 320 px.

## 9. Configuration and deployment

New Worker settings (local `.dev.vars`, production Worker secrets):

```
R2_ACCOUNT_ID=<the id in the S3 endpoint host>
R2_ACCESS_KEY_ID=<R2 API token access key id>
R2_SECRET_ACCESS_KEY=<R2 API token secret>
R2_BUCKET=course-sourse          # optional, defaults to course-sourse
```

`.dev.vars.example` gains these with placeholders and comments. `.dev.vars` is never committed,
and the credentials currently in use are temporary and get rotated after testing.

The R2 API token needs **Object Read & Write** on this bucket. The Worker binds the bucket for
reading/writing files, but signing uses the S3 credentials, so both must be present in
production or uploads fail with a clear error.

**Bucket CORS rule** (required for browser uploads), allowing the live origin and the dev
origins:

- origins: `https://course-site.taxin.workers.dev`, `http://localhost:4200`,
  `http://192.168.0.101:4200`
- methods: `GET, HEAD, PUT, POST`
- headers: `content-type`
- exposed: `ETag`
- max age: 3600

**Page CSP:** `public/_headers` ships a report-only policy whose `connect-src` allows only
`'self'` and Google's sign-in. The R2 S3 endpoint must be added there — for this account,
`https://2ee4cb2f8d4de267cc9e18ae77430723.r2.cloudflarestorage.com` — or every upload `PUT` is
blocked the moment the policy is enforced. `docs/SECURITY.md` already plans that switch, so the
endpoint goes in as part of this work.

**Local-development gotcha:** `wrangler dev` serves a *local* R2 bucket, while presigned URLs
write to the *real* bucket. In local dev an uploaded file therefore lands in the real bucket but
`listCourse()` reads the local one and does not show it. Options: run `wrangler dev --remote`
against the real bindings while testing uploads, or accept that uploads are exercised only
against the deployed Worker. This is documented in the design so it is not mistaken for a bug.

**Lifecycle rule:** an R2 lifecycle rule aborts incomplete multipart uploads after 7 days, so
abandoned uploads do not accumulate. Configured once in the dashboard (documented, not coded).

## 10. Constraints and limits

- R2 multipart: 5 MiB minimum part, 5 GiB maximum part, 10,000 parts maximum.
- S3 `CopyObject` is not used; copies stream through the Worker, so a very large file makes one
  long-lived request (I/O-bound, not CPU-bound).
- Worker request bodies cap around 100 MB — the reason uploads never pass through the Worker.
- Object keys stay under 500 characters, matching the existing lesson-key limit.
- Key sanitation: strip control characters, reject `..` and leading `/`, normalise repeated
  separators, and require at least one `/` so nothing lands beside the course folders.
- `listCourse()`'s in-memory cache is per Worker instance; clearing it on the instance handling
  the edit is best-effort, with the 60 s window as the fallback.
- The bucket name `course-sourse` is fixed (R2 buckets cannot be renamed).

## 11. My calls (the owner has not decided these; change any of them if you disagree)

1. **Folder operations are in scope** — create, rename, and delete sections and courses, with
   typed confirmation for destructive ones. The owner asked for "every file change" and was
   asked twice without a decision; this is the reading that makes the feature complete.
2. **`aws4fetch`** for SigV4 signing in the Worker (Cloudflare's documented approach for R2's
   S3 API). Worker-side only; the browser bundle gains nothing.
3. **Binding-based copy** for moves — stream the object to its new key — rather than S3
   `CopyObject`. No size ceiling, and it works in local dev.
4. **Binding renamed** `VIDEOS` → `RESOURCES` at the owner's request. Note the collision of
   vocabulary with the existing lesson "resources" feature (D1 `resources` table); they do not
   collide in code — that table is behind `env.DB` — but the word is now doing double duty.
   `COURSE_FILES` was offered as the alternative and declined.
5. **HLS folders collapse to one item** in the file manager.
6. **Empty folders** are kept alive by a hidden zero-byte `.keep`.
7. **Cache invalidation** on every structural change.
8. **Any file type** may be uploaded; only video/PDF become lessons.
9. **Overwrite** of an existing key is refused by default and only allowed through an explicit
   confirm in the UI.
10. Presigned URLs are valid for one hour; parts are signed on demand.
11. **Moves are idempotent and retryable** — copy, rewrite, then delete; identical copies are
    skipped on a retry; one operation caps at 1,000 objects.
12. **A lesson cannot be renamed to a non-lesson extension**, because that would strand its
    student data on a key the site never shows. Any other file may be promoted into a lesson.
13. **Cross-course moves are allowed**, with a confirmation that names who gains and who loses
    access. Courses themselves are never moved — only renamed, created, and deleted.
14. **Resume needs the file re-selected** after a reload, since the browser no longer holds it.
15. **The R2 S3 endpoint goes into `connect-src`** in `public/_headers`.

## 12. Left to the builder

- Component structure, naming, and how the file-manager view is entered from the admin panel.
- The exact upload-list UI and progress/error copy.
- Part-size tuning and concurrency (how many parts upload at once).
- Verification approach: the existing Python API suite plus browser checks.
