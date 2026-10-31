# Handoff: how this project was built and where it stands

For a developer or AI assistant who will review, optimize or extend the project. Read it fully before changing anything. Last updated after the file manager (uploads, rename, move, delete, folders), the admin panel, UI redesign and mobile pass.

## 1. Goal and requirements

A private video course site for a small cohort (about 6 students, growing to a few hundred at most).

- About 30 GB of video now, planned 60 GB, plus PDFs.
- Stream-only as far as is practical. "No one can download it" is impossible in absolute terms; the agreed target is to make downloading hard and leaks traceable.
- The site shows lessons organized like the folders in the storage bucket.
- Very low cost. The owner already has a Cloudflare account with R2 enabled.
- Deploys happen automatically when the Git repo is connected to Cloudflare (Workers Builds).
- Frontend is Angular.
- The first admin must come from Cloudflare configuration, and admins manage students in the app.

## 2. Decision log

| Decision | Reason |
| --- | --- |
| Not YouTube unlisted | The video ID is visible in DevTools and the link is permanent. |
| Cloudflare R2 for storage | Free egress, about $0.015/GB-month. |
| Worker serves media | Checks a login before any byte is sent; supports range requests so seeking works. |
| HLS supported, MP4 also served | The Worker lists and serves both. HLS (`tools/make-hls.sh`) avoids a single downloadable file; plain MP4 is simpler to upload. The old `ALLOW_MP4` switch was removed from the code, so MP4 is always served. |
| Session cookie, not signed URLs | Media URLs only work with a valid `HttpOnly` cookie, so copied links are useless. |
| Course structure derived from the bucket | No lesson table. Uploading files is the only content step. Top folder = course, sub-folders = folders, files = lessons. |
| File manager inside the Admin panel | The owner needed uploads, renames, moves, deletes and folders without rclone. It works on R2 keys directly and carries the D1 rows in the same operation. |
| Uploads go browser → R2 with presigned S3 URLs | A Worker request body is capped (about 100 MB), so large videos cannot pass through it. The Worker only signs each part; the bytes go straight to the bucket. |
| Moves copy through the R2 binding, then rewrite D1, then delete | Avoids S3's 5 GiB copy ceiling and works against the local bucket in dev. A retry is safe: an identical copy at the target is treated as already done. |
| Binding renamed `VIDEOS` → `RESOURCES` | It now holds PDFs and arbitrary files too. The bucket name `course-sourse` is unchanged (R2 buckets cannot be renamed). |
| D1 for users and progress only | Small relational data; progress keyed by R2 object key. |
| Schema created lazily by the Worker | The Git deploy has no place to run migrations before the database exists. `CREATE TABLE IF NOT EXISTS` runs once per isolate. |
| `wrangler.toml` bindings without IDs | Cloudflare provisions the D1 database and R2 bucket on the first Git deploy. Bucket is named `course-sourse` (spelling kept on purpose). |
| First admin from secrets | `ADMIN_EMAIL` + `ADMIN_PASSWORD` are read on every cold start; the user is created if missing and forced to admin. It replaced the old `/api/setup` + `SETUP_KEY` flow. |
| Admin panel inside the app | Replaced the single "Add student" dialog. No router; `app.ts` toggles between `<app-course>` and `<app-admin>`. |
| Angular 21, not 22 | Angular 22 needs a newer Node than Cloudflare's build image may have. |
| No router, no UI library | One screen after login; fewer dependencies. |
| `ngx-extended-pdf-viewer` | Gives a full PDF reader. Print, download, open, rotate etc. are hidden in `pdf-viewer.ts`. |
| Native video controls and fullscreen | A custom fullscreen button was tried (to keep the watermark visible) and removed at the owner's request. Trade-off: no watermark in native fullscreen. |
| Passwords: PBKDF2-SHA256, 100,000 iterations | The maximum Web Crypto allows in Workers. |
| Optimistic "Mark as complete" | `Api.setDone` updates the UI first and rolls back if the request fails. |

## 3. Architecture

```
Browser (Angular SPA)
   |  fetch /api/*  (cookie: s=...)
   v
Cloudflare Worker  (worker/index.js)
   |-- static assets: dist/web/browser   (served directly; Worker only runs for /api/*)
   |-- D1  binding DB         users, progress, comments, notes, resources, enrollments
   |-- R2  binding RESOURCES  <Course>/<Folder>/.../<file>
   '-- R2 S3 API (signed)     the browser's upload parts go straight here
```

`wrangler.toml` uses `run_worker_first = ["/api/*"]`.

### File map

| Path | Purpose |
| --- | --- |
| `worker/index.js` | Backend entry: auth, admin seeding and endpoints, course listing, media streaming, progress; dispatches `/api/admin/files*` to `files.js` |
| `worker/files.js` | File manager API: listing, create folder, move/rename, delete, and the upload handshake (start/part/url/complete/abort/parts) |
| `worker/s3.js` | R2 S3 signing with `aws4fetch`: `r2Config`, server calls (`s3Fetch`) and presigned browser PUTs (`presign`) |
| `src/app/api.ts` | `Api` service: fetch wrapper (GET/POST/DELETE) and app state signals (`me`, `courses`); user-admin calls |
| `src/app/app.ts` | Root: header (logo, Admin panel toggle, Sign out), switches course/admin views |
| `src/app/login.ts` | Sign-in form |
| `src/app/course.ts` | Course cards (home), sidebar folder tree with search, folder browser with breadcrumb, lesson view, Mark as complete |
| `src/app/player.ts` | Video element + moving email watermark (native controls) |
| `src/app/pdf-viewer.ts` | PDF reader: private notes (auto-save, hide, reset), full-window mode, download/print locked off |
| `src/app/admin.ts` | Admin panel UI (users and course checkboxes) with a Files/Users toggle |
| `src/app/admin-files.ts` | File manager view: breadcrumb tree, rename/move/delete dialogs, new folder, upload rows, drag-and-drop |
| `src/app/upload.ts` | Uploader: part sizing, presigned PUTs, 3 parallel parts, progress, conflict/retry, resume from `localStorage` after a reload |
| `src/styles.css` | All styling and the bundled logo font |
| `src/curse-of-the-zombie.ttf` | Logo font (capitals only; CSS uppercases the logo) |
| `angular.json` | Copies `public/` and the pdf viewer's `assets/` into the build |
| `tools/make-hls.sh` | ffmpeg conversion to HLS; copies PDFs unchanged |
| `proxy.conf.json` | Dev only: proxies `/api` from `ng serve` to `wrangler dev` on 8787 |
| `docs/PLAN-google-login.md` | Planned next feature |

### Data model (D1)

```sql
users   (id INTEGER PK, email TEXT UNIQUE, pass TEXT, is_admin INTEGER, google_sub TEXT UNIQUE)   -- google_sub added by migrate() at startup; pass = "<b64 salt>.<b64 PBKDF2 hash>"
watched (user_id INTEGER, lesson TEXT, PRIMARY KEY (user_id, lesson))      -- lesson = R2 object key
pdf_notes (user_id INTEGER, lesson TEXT, data TEXT, updated INTEGER, PRIMARY KEY (user_id, lesson))   -- data = JSON array of serialized editor annotations (max 1.5 MB)
enrollments (user_id INTEGER, course TEXT, PRIMARY KEY (user_id, course))   -- course = first R2 folder name; created in migrate(), which grants all current courses to existing users once
comments (id INTEGER PK, lesson TEXT, user_id INTEGER, parent_id INTEGER, body TEXT, created INTEGER)   -- lesson = R2 key; replies share the lesson and point at parent_id
comment_likes (comment_id INTEGER, user_id INTEGER, PRIMARY KEY (comment_id, user_id))
video_notes (user_id INTEGER, lesson TEXT, body TEXT, updated INTEGER, PRIMARY KEY (user_id, lesson))
resources (id INTEGER PK, lesson TEXT, title TEXT, url TEXT, note TEXT, created_by INTEGER, created INTEGER)
attempts (k TEXT PRIMARY KEY, n INTEGER, t INTEGER)   -- login throttling
```

Every lesson-shaped table is keyed by the R2 object key. The file manager keeps them attached: a rename/move rewrites `lesson` in `comments`, `video_notes`, `pdf_notes`, `watched` and `resources` in the same operation, a course rename also rewrites `enrollments.course`, and a delete removes all of a lesson's rows (a course delete also removes its enrollments).

### API

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /api/login`, `/api/logout` | none | Sets or clears the cookie |
| `GET /api/config` | none | `{googleClientId}` |
| `POST /api/login/google` | none | `{credential}`; verifies the Google ID token (RS256 against Google's JWKS, `iss`, `aud`, `exp`, `email_verified`), matches `google_sub` then invited email, links on first login |
| `GET /api/me` | session | `{id, email, is_admin}` |
| `GET /api/course` | session | `[{title, sections:[{title, lessons:[{id, title, kind:'video'|'pdf', done}]}]}]`; `section.title` is the sub-path joined by `" / "` or `null` |
| `GET /api/media/<url-encoded key>` | session | Allow-listed extensions only; range requests; refuses `Sec-Fetch-Dest: document` |
| `POST /api/progress` | session | `{lesson, done}` |
| `GET/PUT/DELETE /api/notes/<url-encoded key>` | session | Own notes for one `.pdf`; every query is scoped to the signed-in user; `403` if the course is not enrolled |
| `GET /api/admin/courses` | admin | Course names from `listCourse` |
| `POST /api/admin/users/<id>/courses` | admin | `{courses: []}`; replaces the user's enrollments |
| `GET /api/admin/users` | admin | Users with `watched` count and `owner` flag |
| `POST /api/admin/users` | admin | `{email, password, is_admin?, google_only?}`; `google_only` stores an unusable random password hash |
| `POST /api/admin/users/bulk` | admin | Bulk add; Google-only rows store the marker `'!'` as `pass` (no hashing, `checkPw` rejects it); password rows are hashed one by one, so capped at 20 per request (the UI chunks) |
| `POST /api/admin/users/<id>/password` | admin | Reset password |
| `POST /api/admin/users/<id>/role` | admin | `{is_admin}`; blocked for the Owner and yourself |
| `DELETE /api/admin/users/<id>` | admin | Deletes user and their `watched` rows; blocked for the Owner and yourself |
| `GET /api/admin/files?prefix=` | admin | One folder: `{path, dirs:[{name,path}], files:[{key,name,size,modified,lesson,hls}]}`; `.keep` and `.ts` hidden; sorted naturally |
| `POST /api/admin/files/folder` | admin | `{path}`; creates `<path>/.keep`; `409` if the folder exists |
| `POST /api/admin/files/move` | admin | `{from, to, kind:'file'|'folder'}`; copies, rewrites the D1 rows, then deletes the originals; `409` on an existing target, `400` on a lesson becoming a non-lesson or a folder moving inside itself |
| `POST /api/admin/files/delete` | admin | `{path, kind}`; deletes objects first, then the D1 rows; a course delete also removes enrollments |
| `POST /api/admin/files/upload/start` | admin | `{key, size, overwrite?}` → `{uploadId}`; `409` if the key exists and `overwrite` is false |
| `POST /api/admin/files/upload/part` | admin | `{key, uploadId, partNumber}` → `{url}`, a presigned PUT that expires in 1 hour |
| `POST /api/admin/files/upload/url` | admin | `{key, size, overwrite?}` → `{url}` for files up to 16 MiB (one PUT) |
| `POST /api/admin/files/upload/complete` | admin | `{key, uploadId, parts:[{partNumber, etag}]}`; completes the multipart upload |
| `POST /api/admin/files/upload/abort` | admin | `{key, uploadId}`; drops the parts R2 kept |
| `GET /api/admin/files/upload/parts?key=&uploadId=` | admin | Lists the parts already in R2, so a reload sends only the missing ones; `404` when the upload expired |

Secrets (dashboard, never in git): `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and the four upload values `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (the API token needs Object Read & Write on `course-sourse`). Variable: `GOOGLE_CLIENT_ID` (public; enables Google sign-in). Without the `R2_*` secrets everything else works and only uploads answer `503`.

### Course discovery (`listCourse`)

1. List all R2 keys (paginated, 1000 per call); cached in memory for 60 s per isolate. Every file-manager change calls `invalidateCourse()`, so the site reflects it at once.
2. Keep videos (`mp4 webm mkv mov avi m4v m3u8`) and `.pdf`; skip `.ts` segments and root-level files.
3. Course = first path segment. Section = remaining directories joined by `" / "` (empty = course root).
4. `.m3u8` lessons are titled by their parent folder; others by file name without extension.
5. Sort with a numeric-aware collator.

`/api/course` and `/api/media/*` then filter by `enrollments` (`myCourses`; admins get everything). The Angular browser (`course.ts`) rebuilds the folder tree from `section.title` for both the main browser (current level) and the sidebar outline (`rows` computed: open folders only, flat list while searching).

### Auth

- Cookie `s=<base64url(JSON{uid,exp})>.<base64url(HMAC-SHA256 with SESSION_SECRET)>`, `HttpOnly; Secure; SameSite=Strict`, 7 days.
- Each request re-reads the user row, so deleting a user ends their sessions immediately.
- Admin seeding (`seedAdmin`) runs inside `ensureSchema`.
- CSRF relies on `SameSite=Strict` plus JSON bodies.

### Frontend notes

- Signals everywhere; `Api.me` is `undefined` while checking the session, `null` when signed out.
- The lesson view reads the live lesson from `api.courses()` (computed `lesson()`), so the button state is always current. Back returns to the folder the lesson was opened from.
- Styling uses tokens (`--bg --panel --ink --acc ...`), automatic light/dark, and a phone layout at ≤760 px (course chips strip, stacked lesson bar, edge-to-edge video, single-column admin). `html` carries the background gradient so short pages (login) have no band.
- Adding a font file: keep it next to `styles.css` and reference it with a relative `url("./...")` so the build bundles it.

## 4. What has and has not been verified

Verified (this session, in a sandbox without npm access):
- `worker/index.js` passes `node --check`.
- CSS and markup were rendered on mock pages in headless Chromium (login, folder browser, player bar, admin panel; dark, light, 320-1440 px). An automated check found no overflow, off-screen or overlapping elements. The native video fullscreen icon was checked in Chromium.

Verified in an earlier sandbox (original build):
- `ng build` succeeded; the Worker ran under `wrangler dev`; curl checks of login, course listing, range responses, progress and static assets passed.

Not verified (treat as unknown):
- Google sign-in against the real Google service (button rendering, popup, token check); only the token verification logic was unit-tested.
- `ng build` after the admin, course.ts, api.ts and styles changes (no network in the editing sandbox). Run `npm run build` first.
- The admin endpoints, admin seeding and the new Back/optimistic-progress behavior end to end.
- The PDF viewer layout after the CSS changes (`app-pdf-viewer` fills the lesson area; check the toolbar and page fit).
- Real HLS playback, Safari, and Workers Free CPU limits (PBKDF2 100k iterations may exceed 10 ms on login).
- Large libraries (hundreds of lessons) and 30-60 GB of real media.

## 4a. Added after the first handoff

- **Private PDF notes** (`pdf-viewer.ts`, `/api/notes`): uses `getSerializedAnnotations` / `addEditorAnnotation` / `removeEditorAnnotations` from `ngx-extended-pdf-viewer`; text, draw, highlight and stamp are enabled, comment and signature are off (their save/restore was not confirmed). Download is locked off by `supportsDownloading=false`, hidden buttons and a capture-phase block of Ctrl/Cmd+S and +P.
- **Multi-course access** (`enrollments`, Admin course checkboxes, Worker checks on course, media and notes) with manual payment.
- **Home cards and sidebar tree** in `course.ts`; single-course students skip the home screen.
- **Palette** in `styles.css` tokens (dark = the four-color palette, light derived).
- Not verified (no build or browser run): all of the above. Run `npm run build` and test: notes survive a reload, Hide/Reset, `Ctrl+S` does nothing, a student without a course gets `403` on its media, the admin Courses button, and the phone layout of the outline.

## 4b. Security hardening (added later)

See `docs/SECURITY.md`. In the Worker: D1 `attempts` table for login lockout (8 per email+IP, 40 per IP, 15 min), `users.ver` session version (bumped on password reset and role change; cookie carries `v`), Origin/Sec-Fetch CSRF check, security headers on API responses, media gate (`mediaRequestOk`: needs `Sec-Fetch-Site: same-origin` and media dest) and per-user distinct-lesson cap (`scraping`, in-memory per instance, admins exempt). `public/_headers` adds headers and a report-only CSP for the static pages. Also `serve()` requires a `Range` header for video files, truncates each answer to 4 MB (`CHUNK`) and delays requests above `MAX_MBPS` per student (`reserve()`, in-memory leaky bucket; 429 if the delay would exceed 25 s). Not verified against a real browser/deploy (including whether FetchV is actually slowed): the CSP (report-only, check the console), and iOS/Safari native HLS with the Sec-Fetch gate (`RELAX_FETCH_METADATA=1` is the escape hatch).

## 4c. File manager (added later)

- Admin panel → **Files** toggles between users and the course tree. Folders are key prefixes: the tree lists `env.RESOURCES.list({prefix, delimiter:'/'})`; an empty folder is held by a hidden zero-byte `.keep`. A folder at the top level is a course.
- **Uploads:** pick or drag files onto the open folder. Files up to 16 MiB use one presigned PUT; larger files use multipart with 8 MiB parts (scaled up so 10,000 is never exceeded), 3 parts in parallel, progress per file. The browser PUTs straight to R2; the Worker only signs. `XMLHttpRequest` is used because `fetch` cannot report upload progress. An existing name is refused with a **Replace** choice.
- **Reload mid-upload:** the upload id and size are kept in `localStorage`. After a reload the row shows *Paused — re-select the file*; choosing the same file lists R2's parts and re-sends only the missing ones. If R2 no longer has the upload (`404`), it restarts with a clear message.
- **Rename/move:** the destination must not exist (an identical existing copy counts as a completed retry); a folder cannot move inside itself; a section cannot leave its course; a course cannot move, only be renamed; a lesson cannot be renamed to an extension the site will not show (`400`). Cross-course moves are allowed and leave enrollments alone.
- **Delete:** objects first, then the D1 rows, so a failure never leaves a lesson whose file is gone but whose comments keep it visible. Deleting a course also deletes its enrollments, which is how a student loses access to a removed course.
- **Bucket CORS is required for uploads:** origins `https://course-site.taxin.workers.dev`, `http://localhost:4200`, `http://192.168.0.101:4200`; methods `GET, HEAD, PUT, POST`; header `content-type`; expose `ETag`; max age 3600. Without the exposed `ETag` a multipart upload cannot complete (the browser hides the header).
- `public/_headers` now names the R2 endpoint in the report-only CSP's `connect-src`.
- The bucket has an R2 lifecycle rule (`abort-incomplete-uploads`, Age 604800 s) that aborts incomplete multipart uploads after 7 days.

Verified: `ng build`; the API suites (`46/46` file-manager checks, `35/35` discussion/notes/resources regression checks); in Chromium at 1200/393/320 px the tree, new folder, rename, delete-with-typed-name, drop overlay and root-upload refusal. Real uploads to `course-sourse` confirmed with `rclone size`: a 900 KB file by single PUT, 20 MiB and 60 MiB by multipart. A reload at 8 parts left only part 7 to re-send (checked against `ListParts` and the page's resource timings), and the file then completed at exactly 60 MiB. Test objects were deleted afterwards.

## 5. Known limitations and risks

1. A signed-in technical student can still capture or fetch media with their cookie (`yt-dlp`, or the file URL for plain MP4/PDF). No DRM.
2. The video watermark is a DOM element, removable with DevTools, and absent in native fullscreen. PDFs have no watermark.
3. HLS segments are not encrypted; protection is the session cookie only.
4. Login lockout exists, but there is no Cloudflare WAF/bot protection configured; see `docs/SECURITY.md`.
5. No password change by the student, no self-service reset, no "disable" (only delete).
6. Progress, notes, comments and course access are keyed by R2 object/folder names. Renaming through the in-app file manager carries them; renaming with rclone, the dashboard or an S3 client does not.
6a. No access expiry dates; payment is manual (no gateway).
7. `listCourse` lists the whole bucket per cold isolate/cache expiry.
8. The schema helper only creates missing tables; altering a table needs a manual `wrangler d1 execute` or a try/catch `ALTER` step.
9. The Worker is plain JavaScript with no tests; the frontend has no tests.
10. Changing `ADMIN_PASSWORD` after the first run does not update the stored hash.
11. The logo font is free for personal use only.
12. `@angular/router` is listed in `package.json` but not used.

## 6. Backlog (suggested order)

0. Access expiry dates, a phone menu button for the outline, and (later) automatic payment through a Bangladeshi gateway (SSLCommerz, bKash API). Renames are now handled by the file manager.

1. Run `npm run build`, open the site, and fix whatever breaks (PDF layout, admin flows, mobile).
2. Google login is implemented; do the Google Cloud setup in `docs/PLAN-google-login.md` and test it end to end (the JWT verification was unit-tested with a locally generated key, not against real Google).
3. Enforce the CSP, turn on Cloudflare Bot Fight Mode and WAF rate limits, move to HLS-only (`docs/SECURITY.md`).
4. Student password change; optional "disable user" instead of delete.
5. Resume playback position per lesson (store seconds in D1) and deep links.
6. Watermark support in fullscreen (custom fullscreen on the wrapper) and on PDFs, if leak tracing matters.
7. Multi-bitrate HLS and AES-128 segment encryption with an authenticated key endpoint.
8. Generate a `manifest.json` at upload time so the Worker does not list the bucket (or cache in KV).
9. Port the Worker to TypeScript, split into modules, add Vitest tests (`@cloudflare/vitest-pool-workers`).
10. GitHub Actions for build and type checks on pull requests.
11. Stateful sessions (a `sessions` table) for instant revocation and device lists.
12. A paid DRM or per-user watermarking service if leaks become a real problem.

## 7. Constraints to respect

- Stay on Cloudflare Workers, R2 and D1; keep cost near zero.
- Keep `wrangler.toml` bindings without IDs so Git deploys self-provision.
- Keep the deploy command `npm run deploy` (Angular build, then `wrangler deploy`).
- Keep Angular 21 unless the Cloudflare build Node version is confirmed to support a newer release.
- Keep the Worker `/api` contract and the Angular `Api` service in sync; change both together.
- Never commit secrets, `.dev.vars`, `node_modules`, `dist`, or media files.
- Upload media with `rclone`, never through git.

## 8. Run and test

```bash
npm install
cp .dev.vars.example .dev.vars     # SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, R2_* for uploads
npm run build
npm run api      # Worker on http://localhost:8787 (local D1 and R2)
npm start        # Angular on http://localhost:4200
```

Smoke test (cookie jar `-c`/`-b`; uses the admin from `.dev.vars`):

```bash
curl -c jar -X POST localhost:8787/api/login -H "content-type: application/json" -d '{"email":"admin@example.com","password":"<ADMIN_PASSWORD>"}'
curl -b jar localhost:8787/api/me
curl -b jar localhost:8787/api/course
curl -b jar localhost:8787/api/admin/users
curl -b jar -X POST localhost:8787/api/admin/users -H "content-type: application/json" -d '{"email":"s@x.com","password":"longpassword1"}'
curl -b jar -H "Range: bytes=0-99" "localhost:8787/api/media/Demo/Notes.pdf" -i
```

## 9. Uploading course content to R2

Use the in-app **Admin panel → Files** for ordinary work: pick or drag files onto a folder, and rename, move, delete or create folders there. It keeps student data attached and needs no `rclone`. Use `rclone` for bulk imports.

Bucket: `course-sourse`. See the README for the folder mapping, the `rclone` setup and the MP4 `-movflags +faststart` fix (required for plain MP4 so playback starts without downloading the whole file).

```bash
rclone copy "/path/to/video.mp4" "r2:course-sourse/Course Name/" --progress
```

## 10. Prompt to give another AI

> Read `docs/HANDOFF.md`, `README.md` and `docs/PLAN-google-login.md` first, then review `worker/index.js` and `src/app/`. Do not change the platform (Cloudflare Workers, R2, D1) or the Git-based deploy flow. Start with section 6 of the handoff. For every change, explain what you changed and why, keep the Worker API and the Angular `Api` service consistent, and tell me anything you could not verify.
