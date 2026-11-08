# Handoff: how this project was built and where it stands

For a developer or AI assistant who will review, optimize or extend the project. Read it fully before changing anything. Last updated after the Angular 22 / TypeScript 6 upgrade (see the decision log), lazy loading of the PDF viewer and admin panel, the YouTube lessons feature, the file manager (uploads, rename, move, delete, folders, admin-controlled ordering), the admin panel, UI redesign and mobile pass, the picture-in-picture and sidecar-subtitle work on the lesson players, PDF resources on video lessons, the course catalog with locked courses, and the course banners, resource editing and 3/2/1 home grid.

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
| Not YouTube unlisted (as the storage) | The video ID is visible in DevTools and the link is permanent, so it cannot protect paid content. |
| YouTube lessons are opt-in, managed in D1 | Sometimes a lesson already lives on YouTube and uploading it again is wasted work. Lessons are stored in the `youtube_lessons` table and edited from **Admin panel → Files** — the **YouTube** button adds one to the folder you are in (no redeploy, no upload, no R2 cost). It is an addition to the bucket listing, not a replacement for it. `worker/youtube.js` is only a first-run seed. |
| YouTube lesson keys are R2-key shaped | So progress, comments, notes, resources and enrollments all key off the same `lesson` string as a real file. The course is the first segment, so a YouTube-only course is a normal course and can be granted to students. A real file with the same key wins the clash. |
| One CSV format for batch import | An admin often has dozens of existing YouTube lessons to add, and a spreadsheet is how they arrive. A single CSV (`name,link`, with extra columns and a header ignored, and the link column detected by its URL) keeps one parser and one format to maintain; the browser parses it and reuses the single-add endpoint, so there is no Worker change. |
| YouTube lessons in the Files view get a CSV batch import, and the toolbar button always toasts (not disabled) | The button is now a normal, hoverable button; at the top level it explains that a lesson needs a course rather than rendering `button:disabled{cursor:wait}`. |
| Sections that exist only as YouTube lessons appear in the Files view | The Files view listed folders from R2 prefixes, but the course view also lists YouTube lessons, so a YouTube-only section (`ক্লাস করার নিয়ম`) was invisible to the admin while students saw it. `worker/files.js` now derives those folders from `youtube_lessons.id` (`childDirsFromIds`) and merges them into `listFolder` (so they render) and `siblings` (so a position edit renumbers them with unique numbers); `deleteEntry` counts a folder's YouTube rows so such a folder can be deleted instead of answering "Not found". A real R2 folder of the same name wins the clash. |
| Cloudflare R2 for storage | Free egress, about $0.015/GB-month. |
| Worker serves media | Checks a login before any byte is sent; supports range requests so seeking works. |
| HLS supported, MP4 also served | The Worker lists and serves both. HLS (`tools/make-hls.sh`) avoids a single downloadable file; plain MP4 is simpler to upload. The old `ALLOW_MP4` switch was removed from the code, so MP4 is always served. |
| Session cookie, not signed URLs | Media URLs only work with a valid `HttpOnly` cookie, so copied links are useless. |
| Course structure derived from the bucket | No lesson table. Uploading files is the only content step. Top folder = course, sub-folders = folders, files = lessons. |
| File manager inside the Admin panel | The owner needed uploads, renames, moves, deletes and folders without rclone. It works on R2 keys directly and carries the D1 rows in the same operation. |
| Course descriptions live in D1 (`course_meta`), keyed by the course folder | The text is small relational metadata, not content — it does not belong in R2 (where an object would show up as a lesson) and not in a deploy. Keying it by the top-level folder name means the file manager's own rules carry it: a course rename rewrites `course_meta.course`, and a course delete drops the row, in the same D1 batch as `enrollments`. The owner edits it from a per-row **Description** tool in the Files view, and `listCourse` attaches it to the `/api/course` payload so the card grid and the course intro read one source. |
| Course banners are a named file at the course root | A banner is content, not configuration, so it stays an ordinary R2 object: `<Course>/banner.jpg` (or `.jpeg`, `.png`, `.webp`, `.svg`) needs no schema or pointer, survives the existing upload/replace/delete flow, and a course rename carries it because it moves with the folder. `worker/banners.js` decides what counts (`bannerExt`) and picks one per course (`bannerKeys`, priority jpg → jpeg → png → webp → svg); `listCourse` exposes the key, `/api/course` turns it into `/api/banner/<course>`, and the route serves the bytes to any signed-in user — **not** only enrolled ones — so a locked course's card still shows its banner. The card centre-crops it at 16:9 (`.card-banner`), and no banner means the old card. An SVG is served with a restrictive CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox`) so a direct visit cannot execute script; in an `<img>` it never runs anyway. |
| Resources are editable in place | Title, note and (for links) URL are D1 columns, so a PATCH updates them without touching a PDF file or changing the row id. Editing a PDF is deliberately title/note only: its file is `file_key`, and replacing it stays delete + upload so the R2 object and its `pdf_notes` keep one lifecycle. The server ignores a submitted `url` for a PDF, so a crafted request cannot detach the file. |
| Uploads go browser → R2 with presigned S3 URLs | A Worker request body is capped (about 100 MB), so large videos cannot pass through it. The Worker only signs each part; the bytes go straight to the bucket. |
| Moves copy through the R2 binding, then rewrite D1, then delete | Avoids S3's 5 GiB copy ceiling and works against the local bucket in dev. A retry is safe: an identical copy at the target is treated as already done. |
| Resource PDFs live in `<Course>/_resources/<uuid>.pdf`, not next to the lesson | A resource is a file the lesson links to, not a lesson. Hiding the folder from `listCourse` and the file manager keeps it out of the course tree, while the existing media/notes routes and enrollment checks work unchanged. One folder per course also gives course rename and cross-course moves an obvious rule: `file_key` is rewritten with the lesson, and a cross-course move copies the PDF to the destination course's `_resources`. |
| Binding renamed `VIDEOS` → `RESOURCES` | It now holds PDFs and arbitrary files too. The bucket name `<bucket-name>` is unchanged (R2 buckets cannot be renamed). |
| D1 for users and progress only | Small relational data; progress keyed by R2 object key. |
| Schema created lazily by the Worker, behind a version gate | The Git deploy has no place to run migrations before the database exists, so the Worker still creates the schema itself. `schema_meta (k, v)` records `schema` = `SCHEMA_VERSION`: a cold isolate spends one `SELECT k, v FROM schema_meta WHERE k IN ('schema', 'admin_pw')` and, when the version matches, skips every `CREATE TABLE`, the `migrate()` probes and the migration queries — only `seedAdmin`'s one owner read remains (two D1 calls total). On first run, a version bump, a missing row or a missing table it runs the idempotent `SCHEMA` batch, then `migrate()`, then `seedAdmin()`, and writes the version **last**, so a failed step can never activate the fast path. **Bump `SCHEMA_VERSION` in `worker/index.js` whenever `SCHEMA` or `MIGRATIONS` changes**: `worker/schema.test.mjs` pins a SHA-256 of both lists and fails, telling you to bump, if the DDL moved without it. There is still no manual `wrangler d1` migration step. |
| `wrangler.toml` bindings without IDs | Cloudflare provisions the D1 database and R2 bucket on the first Git deploy. Bucket is named `<bucket-name>` (spelling kept on purpose). |
| Login lockout and the per-hour lesson cap live in SQLite Durable Objects, with D1 as the fallback | Both counters are shared by every Worker instance and must survive eviction, so one SQLite-backed `RateLimiter` object exists per key: `login:<email>\|<ip>`, `login:<ip>`, `login:<email>` and `lessons:<userId>`. A login check reads up to three objects in parallel; a failure records the same three; the lesson object inserts one `(hour, lesson)` row and returns the distinct count for that hour, deleting hour buckets older than the previous one on access. Because a key can hold an attacker-supplied email, objects are not immortal: a login request sets a cleanup alarm one lock window out (only if `getAlarm()` says none is scheduled, so it is not pushed later on each request), a lesson request sets one an hour out, and `alarm()` deletes expired rows then calls `state.storage.deleteAll()` once nothing remains (recreating the empty schema for the still-loaded instance), so an abandoned object leaves no stored data or wakeups. Every call is raced against a **2 s** deadline (overridable with `RATE_TIMEOUT_MS`); on a missing binding, an error or a stall it logs one structured line `{path, limiter, error}` — never the key, so no email, IP or user id — and falls back to the existing `attempts` / `lesson_hits` code, which stays in place. Limits are unchanged (8 per email+IP, 40 per IP, 30 per email, 15-minute window, 20 distinct lessons/hour, admins exempt). The in-memory hit/count memos still collapse an HLS segment burst to one object call; the D1 fallback keeps its own memos so a hit recorded by the object cannot skip the D1 write. |
| First admin from secrets | `ADMIN_EMAIL` + `ADMIN_PASSWORD` are read on every cold start; the user is created if missing and forced to admin. It replaced the old `/api/setup` + `SETUP_KEY` flow. The SHA-256 fingerprint of `ADMIN_PASSWORD` stored in `schema_meta` (`admin_pw`) is a change detector, not a credential: a matching cold start compares it and skips the PBKDF2 derive, so the password is hashed only when the owner row is missing or the secret changed. Removing the secret writes the unusable marker `!` (Google-only), and changing it replaces the hash. |
| Admin panel inside the app | Replaced the single "Add student" dialog. No router; `app.ts` toggles between `<app-course>` and `<app-admin>`. |
| Angular 22 (upgraded from 21) | The reason to hold at 21 (Workers Builds had an older Node) is gone: the build image now defaults to Node 24, which Angular 22 supports. Angular 22 makes `OnPush` the default change detection strategy, so the `ng update` migration added `ChangeDetectionStrategy.Eager` to every existing component to keep behaviour unchanged; new components can use the OnPush default. |
| No router, no UI library | One screen after login; fewer dependencies. |
| `ngx-extended-pdf-viewer` | Gives a full PDF reader. Print, download, open, rotate etc. are hidden in `pdf-viewer.ts`. |
| Lazy-load the PDF viewer, admin panel, lesson area, login and course shell | The app shipped one initial bundle; `@defer` splits every conditional view out of it (initial transfer ~215 kB → ~66 kB). A static `prefetchPdfAssets` import pinned the PDF library into the entry bundle, so the on-idle warm-up became a dynamic `import()` instead. No router (see above); every block has a layout-matched placeholder, `@error` and `aria-live`. |
| Both lesson players are **Video.js 10** custom elements (Default skin) | The hand-written players (a raw `youtube.com/embed` iframe and a bare `<video>` + `hls.js`) meant maintaining the chrome ourselves and could not hide YouTube's Share / "Watch on YouTube". Video.js 10 ships web components, so YouTube lessons render `<video-player><video-skin><youtube-video>` and self-hosted lessons render `<hlsjs-video>` (HLS) or a native `<video>` (MP4 and other files) inside the same skin. The skin's own control bar and fullscreen replace the native controls; the moving watermark and the `@defer` lazy chunks are unchanged. Both players **autoplay un-muted**. A dark `.media-cover` stays above the media/spinner/controls and below the watermark and shows a **loading spinner** until playback really progresses (so YouTube's own thumbnail/title/red button never show, and the skin's premature pause icon is hidden). If autoplay is blocked — no progress within 4 s — the spinner becomes a real "Play lesson" button, so one tap recovers with sound. |
| Known player limits | YouTube fullscreen still shows YouTube's own chrome, and PiP is unavailable on YouTube media. Un-muted autoplay is subject to browser policy; the cover tap is the fallback (never silently muted). The Video.js core is a **shared lazy** chunk, so the entry bundle does not grow, but the lazy lesson chunks did (self-hosted `player` ≈ 638 kB raw, YouTube `yt-player` ≈ 15 kB raw). |
| PiP and subtitle policy | PiP is the browser's own picture-in-picture on self-hosted lessons only; the skin already had the button, so the only change was dropping `disablepictureinpicture` from `<hlsjs-video>` / `<video>`. YouTube's adapter cannot do PiP, so it stays unavailable there. Subtitles are **only tracks already embedded in the source video**, extracted by `tools/make-hls.sh` to sidecar `index.<lang>[.<n>].vtt` files (no upload UI, no transcription, no cost). Sidecars were chosen over HLS master-playlist subtitle renditions because `CustomMediaElement` clones light-DOM `<track>` children into the internal `<video>` and `hlsjs-video` preserves sideloaded tracks — one mechanism for MP4 and HLS. Captions stay off until the viewer picks one. No resolution selector and no encoder quality change: YouTube no longer lets an embed set quality (its setters are no-ops or gone), and the only working menu is YouTube's own chrome, which we hide. |
| Passwords: PBKDF2-SHA256, 100,000 iterations | The maximum Web Crypto allows in Workers. |
| Two-column lesson layout on wide screens, plus one shared "back to top" button | At ≥1100px a video lesson is a grid (player left, lesson panel right, the panel scrolling on its own); below 1100px and for the PDF reader it stays a single column. The height-capped player made the panel start below the fold on every laptop, which is why the layout changes rather than only shrinking the video. Rather than a control per section, one fixed button in `app.ts` listens for scroll in the capture phase and acts on any `data-scroll-top` container (course/browser `main`, `.player-body`, `app-lesson-panel`, the admin user dialog) or the page (admin), so every long section can return to the top. |
| Optimistic "Mark as complete" | `Api.setDone` updates the UI first and rolls back if the request fails. |

## 3. Architecture

```
Browser (Angular SPA)
   |  fetch /api/*  (cookie: s=...)
   v
Cloudflare Worker  (worker/index.js)
   |-- static assets: dist/web/browser   (served directly; Worker only runs for /api/*)
   |-- D1  binding DB         users, progress, comments, notes, resources, enrollments, course descriptions
   |-- R2  binding RESOURCES  <Course>/<Folder>/.../<file>
   '-- R2 S3 API (signed)     the browser's upload parts go straight here
```

`wrangler.toml` uses `run_worker_first = ["/api/*"]`.

### File map

| Path | Purpose |
| --- | --- |
| `worker/index.js` | Backend entry: auth, admin seeding and endpoints, course listing, media streaming, progress; dispatches `/api/admin/files*` to `files.js` |
| `worker/files.js` | File manager API: listing, create folder, move/rename, delete, and the upload handshake (start/part/url/complete/abort/parts) |
| `worker/banners.js` | Course banner convention: `bannerExt` / `bannerKeys` decide which named file at a course root is the banner and its content type |
| `worker/youtube.js` | YouTube lessons: an optional first-run seed for the `youtube_lessons` table (lessons are managed from the Files view) |
| `worker/s3.js` | R2 S3 signing with `aws4fetch`: `r2Config`, server calls (`s3Fetch`) and presigned browser PUTs (`presign`) |
| `src/app/api.ts` | `Api` service: fetch wrapper (GET/POST/DELETE) and app state signals (`me`, `courses`); user-admin calls |
| `src/app/app.ts` | Root: slim header (wordmark, search, options menu) shown only on the course list/browser, switches course/admin views, and the shared "back to top" button |
| `src/app/shell.ts` | Shared shell state: admin / lesson-open flags, header visibility, sign-out |
| `src/app/options-menu.ts` | The single hamburger options menu (Admin panel / Back to course, theme switch, Sign out), shown in full-contrast text colour in the header, the lesson bar and both admin toolbars |
| `src/app/theme.ts` | Two-way light/dark controller; mirrors the pre-paint script and writes `localStorage['theme']` |
| `src/app/login.ts` | Sign-in form |
| `src/app/course.ts` | Course list (card grid with descriptions), folder browser with breadcrumb, lesson view + lesson bar, Mark as complete |
| `src/app/player.ts` | HLS/MP4 lesson: `<hlsjs-video>` or `<video>` inside the Video.js skin (autoplay, un-muted) with a loading cover (spinner; play button if autoplay is blocked) + moving email watermark |
| `src/app/yt-player.ts` | YouTube lesson: `<video-player><video-skin><youtube-video>` (autoplay, un-muted) with an opaque loading cover until playback (spinner; play button if autoplay is blocked) + the same moving email watermark |
| `src/app/pdf-viewer.ts` | PDF reader: private notes (auto-save, hide, reset), download/print locked off; draws no chrome of its own |
| `src/app/notes-controls.ts` | The shared PDF notes controls (status · hide/show · delete) rendered by both the lesson bar and the resource-PDF modal header |
| `src/app/lesson-resources.ts` | Lesson Resources tab: admin Link/PDF form, link rows, PDF rows that open the shared viewer in a full-window modal |
| `src/app/admin.ts` | Admin **Users** view (single heading, one stats line, borderless table), the shared options menu, and the user detail dialog; hosts the Files view |
| `src/app/admin-files.ts` | File manager view: breadcrumb tree, rename/move/delete dialogs, new folder, upload rows, drag-and-drop, YouTube lessons (a toolbar button + rows with change-link/delete + a CSV batch import), one position box per row, and the shared options menu |
| `src/app/youtube-csv.ts` | Pure CSV parser for the YouTube batch import (`parseYoutubeCsv`, `ytId`); no Angular imports |
| `src/app/upload.ts` | Uploader: part sizing, presigned PUTs, 3 parallel parts, progress, conflict/retry, resume from `localStorage` after a reload |
| `src/styles.css` | All styling: tokens, light/dark, shared row/control primitives, desktop + phone layouts |
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
content_order (path TEXT PRIMARY KEY, position INTEGER NOT NULL)   -- admin-chosen order inside one folder: folders, files and YouTube lessons share the sequence; created lazily on the first reorder
course_meta (course TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '')   -- owner-written course description (plain text, <= 2000 chars); `course` = the top-level folder name, so it is keyed like `enrollments.course`
resources (id INTEGER PK, lesson TEXT, title TEXT, url TEXT, note TEXT, created_by INTEGER, created INTEGER, kind TEXT, file_key TEXT)   -- kind = 'link' (default) or 'pdf'; for PDFs `url` is empty and `file_key` is the R2 key
youtube_lessons (id TEXT PRIMARY KEY, yt TEXT NOT NULL, created INTEGER NOT NULL)   -- id = lesson path "<Course>/<Folder>/<Name>", yt = YouTube video id; created in migrate() and seeded once from worker/youtube.js
attempts (k TEXT PRIMARY KEY, n INTEGER, t INTEGER)   -- login throttling, the fallback when the RateLimiter object is unavailable
lesson_hits (user_id INTEGER, hour INTEGER, lesson TEXT, PRIMARY KEY (user_id, hour, lesson))   -- per-hour distinct-lesson cap, the fallback when the RateLimiter object is unavailable
schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)   -- bootstrap state: k='schema' → SCHEMA_VERSION, k='admin_pw' → SHA-256 fingerprint of ADMIN_PASSWORD; read once per cold isolate, version written last after a successful full bootstrap
```

Every lesson-shaped table is keyed by the R2 object key. The file manager keeps them attached: a rename/move rewrites `lesson` in `comments`, `video_notes`, `pdf_notes`, `watched` and `resources` in the same operation, a course rename also rewrites `enrollments.course` and `course_meta.course`, and a delete removes all of a lesson's rows (a course delete also removes its enrollments and its `course_meta` row). `content_order` follows the same rule: a rename keeps every position, a move to a different parent drops only the moved root's number (its children keep theirs), and a delete removes the path and its whole subtree. A folder move also carries its `youtube_lessons` rows and their positions; a folder delete removes them.

### API

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /api/login`, `/api/logout` | none | Sets or clears the cookie |
| `GET /api/config` | none | `{googleClientId}` |
| `GET/HEAD /api/health` | none | Uptime probe: one guarded `SELECT 1 AS ok`, no schema bootstrap, no session. `200 {"ok":true}` or `503 {"ok":false}` with `retry-after: 5`; `cache-control: no-store`; body is only `ok` (no error text or timings) |
| `POST /api/login/google` | none | `{credential}`; verifies the Google ID token (RS256 against Google's JWKS, `iss`, `aud`, `exp`, `email_verified`), matches `google_sub` then invited email, links on first login |
| `GET /api/me` | session | `{id, email, is_admin}` |
| `GET /api/course` | session | A **catalog**: every course is sent to every signed-in user. `[{title, description, banner, locked, lessonCount, sections:[{title, lessons:[{id, title, kind:'video'|'pdf'|'youtube', done}]}]}]`; `banner` is `/api/banner/<course>` when the course has a banner file, else `''`; `locked` is `true` when the viewer is not an admin and the course is not granted, and then `sections` is `[]` so a locked course never leaks its lessons (its title, owner-written description, banner URL and `lessonCount` still travel, as they are course-level); `lessonCount` is the total lesson count, so a locked card reads `0/23 lessons` instead of `0/0`. `description` is the owner-written text from `course_meta` (empty string when unset); `youtube` lessons also carry `yt` (the video id); `section.title` is the sub-path joined by `" / "` or `null`. Built from the bucket listing plus `worker/youtube.js`. Sorted by `content_order` where set. |
| `GET /api/banner/<course>` | session | Image bytes for the course's banner file (`banner.jpg|jpeg|png|webp|svg`; the extension priority is jpg → jpeg → png → webp → svg). `404` when the course or its banner does not exist. Login is required but **enrollment is not**, so a locked course's card still shows its banner. `content-type` from the extension, `cache-control: private, no-store`, `nosniff`, same-origin, `inline`; an SVG also carries a restrictive CSP (`default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox`) so script cannot run on a direct visit. |
| `GET /api/order` | session | `{path: position}` for the saved numbers the browser needs: every course-level path (one with no `/`) for all viewers, plus a lesson-level path only when its course is granted (admins: all). A locked course's lesson paths are withheld. The student browser uses it for its number labels. |
| `GET /api/media/<url-encoded key>` | session | Allow-listed extensions only; range requests; refuses `Sec-Fetch-Dest: document` |
| `POST /api/progress` | session | `{lesson, done}` |
| `GET/PUT/DELETE /api/notes/<url-encoded key>` | session | Own notes for one `.pdf`; every query is scoped to the signed-in user; `403` if the course is not enrolled |
| `GET /api/lesson/<url-encoded key>/resources` | session | `{resources:[{id,title,url,note,kind}]}`; `url` is the link for `kind:'link'` and the R2 key for `kind:'pdf'`; course-scoped |
| `POST /api/admin/lesson/<url-encoded key>/resources` | admin | `{title,url,note?}`; adds a link resource |
| `POST /api/admin/lesson/<url-encoded key>/resources/pdf` | admin | multipart `file`, `title?`, `note?`; `%PDF-` magic, 25 MB cap, title ≤120, note ≤300, 100 resources per lesson; stores `<Course>/_resources/<uuid>.pdf` and returns `{resource}` with `kind:'pdf'` |
| `DELETE /api/admin/resources/<id>` | admin | Deletes the row, and for a PDF the R2 object and its `pdf_notes` rows |
| `PATCH /api/admin/resources/<id>` | admin | `{title, note?, url?}`; edits in place and returns `{resource}`. For a link, `url` must be a valid `http(s)` link and is written; for a PDF, only title and note are written and a submitted `url` never replaces `file_key`. Requires the lesson's admin access. |
| `GET /api/admin/courses` | admin | Course names from `listCourse` |
| `GET /api/admin/youtube` | admin | `[{id, course, folder, lesson, yt}]` |
| `POST /api/admin/youtube` | admin | `{course, folder?, lesson, link}`; `ytId` parses the link (`400` if not a YouTube link / course or lesson empty or containing `/`); upserts by path; `invalidateCourse()`; returns `{ok, id, yt, shadowed}` where `shadowed` is true when an R2 object already uses the id |
| `DELETE /api/admin/youtube` | admin | `{id}`; deletes the row and `invalidateCourse()` |
| `POST /api/admin/youtube/rename` | admin | `{id, name}`; a YouTube lesson's name is its key, so this moves the `youtube_lessons` row **and** its `comments`, `video_notes`, `pdf_notes`, `note_assets`, `watched`, `resources` and `content_order` rows to `<folder>/<name>`; video id and creation time are kept; `400` empty name or one containing `/`, `404` missing lesson, `409` if the target is another lesson or an R2 file; no-op when unchanged; `invalidateCourse()`; returns `{ok, id}` |
| `POST /api/admin/users/<id>/courses` | admin | `{courses: []}`; replaces the user's enrollments |
| `GET /api/admin/users` | admin | Users with `watched` count and `owner` flag |
| `POST /api/admin/users` | admin | `{email, password, is_admin?, google_only?}`; `google_only` stores an unusable random password hash |
| `POST /api/admin/users/bulk` | admin | Bulk add; Google-only rows store the marker `'!'` as `pass` (no hashing, `checkPw` rejects it); password rows are hashed one by one, so capped at 20 per request (the UI chunks) |
| `POST /api/admin/users/<id>/password` | admin | Reset password |
| `POST /api/admin/users/<id>/role` | admin | `{is_admin}`; blocked for the Owner and yourself |
| `DELETE /api/admin/users/<id>` | admin | Deletes user and their `watched` rows; blocked for the Owner and yourself |
| `GET /api/admin/files?prefix=` | admin | One folder: `{path, dirs:[{name,path,position}], files:[{key,name,size,modified,lesson,hls,position}], order:{path:position}}`; `.keep` and `.ts` hidden; sorted by saved positions, then naturally |
| `POST /api/admin/files/order` | admin | `{path, position:1..9999|null}`; puts the entry at that place in its folder and renumbers the folder 1..N. `null`/blank clears just that entry (default order). `404` if the item no longer exists. |
| `POST /api/admin/files/folder` | admin | `{path}`; creates `<path>/.keep`; `409` if the folder exists |
| `POST /api/admin/files/description` | admin | `{course, description}`; upserts the owner-written course description in `course_meta` (plain text, trimmed, `\r\n`→`\n`, capped at 2000 chars; empty clears it); `400` when `course` is empty or contains `/`; `invalidateCourse()` on write |
| `GET /api/admin/files/description?course=` | admin | `{course, description}`; reads the stored description for one course, including a course that has no lesson yet (so the file-manager editor can prefill it) |
| `POST /api/admin/files/move` | admin | `{from, to, kind:'file'|'folder'}`; copies, rewrites the D1 rows, then deletes the originals; `409` on an existing target, `400` on a lesson becoming a non-lesson or a folder moving inside itself |
| `POST /api/admin/files/delete` | admin | `{path, kind}`; deletes objects first, then the D1 rows; a course delete also removes enrollments and the `course_meta` row |
| `POST /api/admin/files/upload/start` | admin | `{key, size, overwrite?}` → `{uploadId}`; `409` if the key exists and `overwrite` is false |
| `POST /api/admin/files/upload/part` | admin | `{key, uploadId, partNumber}` → `{url}`, a presigned PUT that expires in 1 hour |
| `POST /api/admin/files/upload/url` | admin | `{key, size, overwrite?}` → `{url}` for files up to 16 MiB (one PUT) |
| `POST /api/admin/files/upload/complete` | admin | `{key, uploadId, parts:[{partNumber, etag}]}`; completes the multipart upload |
| `POST /api/admin/files/upload/abort` | admin | `{key, uploadId}`; drops the parts R2 kept |
| `GET /api/admin/files/upload/parts?key=&uploadId=` | admin | Lists the parts already in R2, so a reload sends only the missing ones; `404` when the upload expired |

Secrets (dashboard, never in git): `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and the upload values `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` plus optional `R2_BUCKET` (the API token needs Object Read & Write on `<bucket-name>`). Variable: `GOOGLE_CLIENT_ID` (public; enables Google sign-in). Without the `R2_*` secrets everything else works and only uploads answer `503`. `npm run doctor` reports which names are missing (never values).

### Course discovery (`listCourse`)

1. List all R2 keys (paginated, 1000 per call); cached in memory for 60 s per isolate. Every file-manager change calls `invalidateCourse()`, so the site reflects it at once. Single-PUT uploads finish entirely in the browser, so the client calls `/api/admin/files/upload/done` afterwards to drop the same cache.
2. Keep videos (`mp4 webm mkv mov avi m4v m3u8`) and `.pdf`; skip `.ts` segments, root-level files, and any key with a `_resources` segment (those are lesson resources, not lessons).
3. Course = first path segment. A course is registered for any nested key **before** the lesson filter, so a top-level folder holding only its `.keep` placeholder — a brand-new, empty course — is listed too, as `{ title, description, sections: [] }`. Section = remaining directories joined by `" / "` (empty = course root).
4. `.m3u8` lessons are titled by their parent folder; others by file name without extension.
5. Sort by `content_order` where a path has a saved position (numbered items first, in that order), then with a numeric-aware collator; folders sort before files at the same level.
6. Merge `youtube_lessons` from D1 (managed in Admin → Files; seeded once from `worker/youtube.js`). Each row's `id` is split on `/`; the first segment is the course (created if missing, so a YouTube-only course appears), the middle segments form the section title (joined with `" / "`), and the last segment is the lesson name. `ytId()` accepts a watch/`youtu.be`/`embed`/`shorts`/`live` link or a bare id and is used on write; an unusable link is refused at the endpoint. The merged lesson is `{id, title, kind:'youtube', yt}` where `id` is the full path, so progress/comments/notes/resources/enrollments work unchanged. A row whose id matches a real file is skipped (the file wins).
7. Attach each course's `description` from `course_meta` (keyed by the top-level folder name; empty string when unset), so `/api/course` and the card grid can show it.

`/api/course` is a catalog: it sends every course and marks an ungranted one `locked` with `sections: []` (it no longer filters by `enrollments`). Lesson-level access is still enforced by `myCourses` on `/api/media/*`, `/api/notes/*`, comments and resources (admins get everything), so a locked course's lessons stay protected even by direct URL. The Angular browser (`course.ts`) rebuilds the folder tree from `section.title` for both the main browser (current level) and the sidebar outline (`rows` computed: open folders only, flat list while searching); a locked card is `disabled` and its `openCourse`/search-jump paths are guarded.

### Auth

- Cookie `s=<base64url(JSON{uid, v, sid, exp})>.<base64url(HMAC-SHA256 with SESSION_SECRET)>`, `HttpOnly; Secure; SameSite=Strict`, 7 days.
- Each request re-reads the user row, so deleting a user ends their sessions immediately.
- `users.sid` is the account's current session id (nullable). A student cookie is valid only while its `sid` matches the row, so an account has one live student session and a new login signs the old device out; admins (`is_admin = 1`, including the owner) skip the check. The client clears its session on any `401` (`Api.signOutLocal`, internal) and revalidates on `window focus` / `document visibilitychange` (`Api.refreshMe`). This stops account sharing via a new login (password or Google); it does **not** stop a student copying their own cookie value to a second device, since both carry the same valid `sid` — true per-device enforcement would need a `sessions` table with a per-device identity.
- Admin seeding (`seedAdmin`) runs inside `initSchema`, under the same cached promise as the schema gate; with a matching `schema_meta` version it costs one owner `SELECT` and, unless the secret changed, no PBKDF2 derive.
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

See `docs/SECURITY.md`. In the Worker: login lockout (8 per email+IP, 40 per IP, 30 per email, 15 min) and the per-user distinct-lesson cap run in SQLite **Durable Objects** (`RateLimiter`, one object per key, `lessons:<userId>` for the cap; admins exempt), with the D1 `attempts` and `lesson_hits` tables as an automatic fallback when an object errors or stalls; `users.ver` session version (bumped on password reset and role change; cookie carries `v`), Origin/Sec-Fetch CSRF check, security headers on API responses, media gate (`mediaRequestOk`: needs `Sec-Fetch-Site: same-origin` and media dest). `public/_headers` adds headers and a report-only CSP for the static pages. Also `serve()` requires a `Range` header for video files, truncates each answer to 4 MB (`CHUNK`) and delays requests above `MAX_MBPS` per student (`reserve()`, in-memory leaky bucket; 429 if the delay would exceed 25 s). Not verified against a real browser/deploy (including whether FetchV is actually slowed): the CSP (report-only, check the console), and iOS/Safari native HLS with the Sec-Fetch gate (`RELAX_FETCH_METADATA=1` is the escape hatch).

## 4c. File manager (added later)

- Admin panel → **Course files** is reached from the "Course files" link in the Users heading; the sub-view is kept in `location.hash` (`#files`), so the browser Back button returns to Users, and the Files toolbar starts with **← Users**. Folders are key prefixes: the tree lists `env.RESOURCES.list({prefix, delimiter:'/'})`; an empty folder is held by a hidden zero-byte `.keep`. A folder at the top level is a course.
- **Uploads:** pick or drag files onto the open folder. Files up to 16 MiB use one presigned PUT; larger files use multipart with 8 MiB parts (scaled up so 10,000 is never exceeded), 3 parts in parallel, progress per file. The browser PUTs straight to R2; the Worker only signs. `XMLHttpRequest` is used because `fetch` cannot report upload progress. An existing name is refused with a **Replace** choice.
- **Reload mid-upload:** the upload id and size are kept in `localStorage`. After a reload the row shows *Paused — re-select the file*; choosing the same file lists R2's parts and re-sends only the missing ones. If R2 no longer has the upload (`404`), it restarts with a clear message.
- **Rename/move:** the destination must not exist — neither a file nor a folder holding other files or YouTube lessons (an identical existing copy counts as a completed retry, so the same move can be run again); a folder cannot move inside itself; a section cannot leave its course; a course cannot move, only be renamed; a lesson cannot be renamed to an extension the site will not show (`400`). Cross-course moves are allowed and leave enrollments alone. A folder move carries its `youtube_lessons` rows. If the D1 rewrite fails partway, the copies are kept (so every row still points at a real object) and the same move finishes the job; if the old-file delete fails, the reply carries a warning that the UI shows.
- **Delete:** objects first, then the D1 rows. YouTube lessons under the deleted path go too (otherwise a deleted folder or course would reappear with its lessons). If the bucket delete fails nothing changes; if the row cleanup fails the request says so and the rows survive, but a retry finds those lesson keys in D1 even though their objects are gone and finishes the cleanup. Deleting a course also deletes its enrollments, which is how a student loses access to a removed course. **The `content_order` / `youtube_lessons` prefix cleanup must not use `LIKE ? ESCAPE '\'`:** D1's `batch()` rejects an escaped LIKE pattern with `LIKE or GLOB pattern too complex` even though the identical statement runs fine on its own (this once left folders half-deleted — files gone, rows kept). Match the prefix as a plain range instead, `p/ <= path < p0` (where `p0` is `p` with `'0'` appended, the byte just after `/`).
- **Order:** the number box on each row sets the entry's place in its folder. Folders, files and YouTube lessons share one 1..N sequence per folder; the server stores it in `content_order` and renumbers the folder on every save so there are no gaps or duplicates. A blank box removes the number, so that entry falls back to the default order (folders, then files, then YouTube; each by name). Numbered entries always sort before unnumbered ones. The top-level course cards are orderable the same way (their numbers are not shown on the cards). Students see the effective place number (1..N) before every item in the browser. The admin's number box shows the stored position, so an unnumbered item shows blank even though the student view gives it a number.
- **Bucket CORS is required for uploads, and is now automatic:** `npm run deploy` runs `scripts/deploy.mjs`, which resolves the active Cloudflare account, clears a stale Wrangler account cache, creates the bucket if needed, keeps the multipart-abort lifecycle rule, deploys, then merges the deployed origin (parsed from Wrangler's output) plus localhost and `UPLOAD_ORIGINS` into the bucket CORS rule with `GET, HEAD, PUT, POST`, `content-type`, exposed `ETag`, max age 3600. `npm run setup:r2` does the bucket part alone (`SITE_URL=...` for a custom domain); `npm run doctor` verifies account, bucket, lifecycle, CORS, secrets and reachability. Without the exposed `ETag` a multipart upload cannot complete (the browser hides the header). In Workers Builds, if the build token cannot manage R2 the deploy still succeeds and prints the local command to run.
- `public/_headers` names the R2 endpoint in the report-only CSP's `connect-src` as `https://*.r2.cloudflarestorage.com`, so a fork does not inherit another account's endpoint.
- The bucket has a lifecycle rule (7 days) that aborts incomplete multipart uploads; `npm run setup:r2` adds it if missing.

Verified: `ng build`; the local API suites (`59/59` file-manager checks, `35/35` discussion/notes/resources regression checks); a live pass against the deployed Worker with a throwaway admin, student and course: `44/44` API checks, then Chromium at 1200/393/320 px covering create course/section, single-PUT and multipart uploads, drag-and-drop, duplicate-name **Replace**, rename/move (including Unicode and `&`/parentheses), Escape closing a dialog, delete file/folder/course, long-name truncation and no horizontal overflow. Real uploads were confirmed with `rclone size` (900 KB by single PUT; 20 MiB and 60 MiB by multipart). A 60 MiB upload reloaded after 6 of 8 parts resumed at 80% and completed at exactly 60 MiB. Cancelling during the start call, mid-parts, during a single PUT, and on a paused row after a reload left no object and no multipart upload. Test objects, users and enrollments were removed afterwards.

Ordering was verified later on the deployed Worker with a throwaway admin and student and a test course of two folders and four YouTube lessons: saving a position renumbered the folder 1..N; a blank position cleared only that entry; `/api/order` returned the same map; `/api/course` and the student browser showed the new order; the admin's number boxes showed the stored numbers while the student's labels were the effective 1..N; a folder rename kept its own and its children's numbers; moving it to another course cleared only the moved folder's number; deleting a course removed its lessons and every number row. A real-browser pass (Chromium) changed a number in the box to reorder the list and saw the student view change to 1 Alpha, 2 B Section, 3 Zeta. Test data was removed afterwards.

## 4d. YouTube lessons (added later; managed from the Files view)

- Lessons live in the D1 table `youtube_lessons (id, yt, created)` and are added/edited/deleted from **Admin panel → Files** — the **YouTube** button in the folder toolbar adds one to the folder you are in (the path is that folder, so there is no course/folder field; at the top level it explains that a lesson needs a course first — it is a normal button, not a disabled one), and the folder's lessons show as rows with **Change link** / **Delete** (`GET/POST/DELETE /api/admin/youtube`). `POST` parses the link with `ytId()` (bare id, watch link, `youtu.be`, `/embed`, `/shorts`, `/live`), refuses anything else with `400`, upserts by path, calls `invalidateCourse()`, and reports `shadowed` when an R2 object already uses the id. So a change is live with no redeploy. (An earlier pass had a separate Admin → YouTube tab and `src/app/admin-youtube.ts`; both were removed here.)
- A CSV file can add many at once: the dialog's file input is parsed in the browser by `src/app/youtube-csv.ts` (`parseYoutubeCsv`) — it strips a BOM, handles RFC-4180 quoting, drops an optional header, and finds the link column by its YouTube-URL shape (the name is the column to its left) — then posts one `addYoutubeLesson` per valid row into the current folder (N client calls, **no Worker change**) and reports the skipped rows.
- `worker/youtube.js` is only a first-run seed: `migrate()` creates the table (guarded by an `sqlite_master` existence check) and, only on that first creation, copies `YOUTUBE_LESSONS` in. The guard is what makes a later delete permanent.
- `listCourse` reads the table after the R2 walk.
- The id is R2-key shaped on purpose: `id` is the full path, so `watched`, `comments`, `video_notes`, `pdf_notes`, `resources` and `enrollments` treat a YouTube lesson exactly like a file lesson. The first segment is the course, so a YouTube-only course appears in the admin Courses list and can be granted.
- Frontend: `course.ts` renders `<app-yt-player>` for `kind === 'youtube'` (instead of `<app-player>`), and both the file list and the header search show a distinct YouTube icon. `src/app/yt-player.ts` is a plain `<iframe src="https://www.youtube.com/embed/<id>?rel=0">` with the shared moving email watermark. `public/_headers` adds `youtube.com` and `youtube-nocookie.com` to the report-only CSP `frame-src`.
- A YouTube lesson has no server-side "ended" event (the iframe is opaque), so completion is the lesson panel's **Mark as complete** button only; the video player's auto-finish-on-ended does not apply.

Verified this session (local Worker):
- `node --check worker/index.js worker/youtube.js` pass; `npm run typecheck` and `npm run build` exit 0; the built bundle contains the embed URL.
- Storage/list: a direct D1 row appeared in `GET /api/course` as `kind:'youtube'`; after deleting it and restarting, it did **not** re-seed.
- Endpoints: `POST` a `youtu.be` link → `{ok,id:'Physics/Week 1/Welcome',yt:'dQw4w9WgXcQ',shadowed:false}` and it showed in `/api/course` at once; a bad link, a slashed course and an empty lesson each `400`; re-`POST` of the same path left one row with the new `yt`; `DELETE` removed it. A real R2 object `Demo/Lecture.mp4` made `POST` return `shadowed:true` and the listing showed the file once as `kind:'video'`. A student got `403` on `POST`/`GET`/`DELETE`.

Not verified: clicking through the YouTube button/rows in the Files view in a real browser, and the iframe on the live Worker — the CSP is report-only, so check the console after deploy.

## 4e. Lazy loading (added later)

- Every conditional view is a lazy chunk loaded with Angular `@defer`: the PDF viewer and the admin panel (in `course.ts` / `app.ts`), then in a second pass the lesson area (`player`, `yt-player`, `lesson-panel` + discussion/resources), `login` and the `course` shell. Initial JS transfer went ~215 kB → ~66 kB.
- The PDF viewer warms on idle via a **dynamic** `import('./pdf-viewer')`. A static import of `prefetchPdfAssets` — which lives in the same module as the viewer, and so pulls in `ngx-extended-pdf-viewer` — is what kept the whole library in the entry chunk; that is the trap to remember when deferring anything else. The reader tuning in `pdf-viewer.ts` (`disableStream`, `disableAutoFetch`, `rangeChunkSize`) still runs when the lazy module loads, before the viewer initialises.
- All blocks use `@defer (on immediate)` with a layout-matched `.defer-fill` placeholder, an `@error` fallback and `aria-live="polite"`. No block has a `@defer` prefetch trigger: a student never fetches admin or lesson code, and the lesson chunks load only when a lesson opens. The PDF chunk is the exception — `Course` warms it on idle for everyone (as before), so it appears shortly after the course list without a PDF being opened.
- Angular splits per deferred dependency, so the lesson area became separate `player` / `yt-player` / `lesson-panel` chunks rather than one; opening any lesson requests all three (Angular awaits the block's whole dependency array).
- Verified in a real browser (the deployed site, plus a seeded local build for RED→GREEN): initial load is `main` + the shared framework chunk only; `course` arrives on the deferred mount; `pdf-viewer` warms on idle; opening a lesson loads `player`/`yt-player`/`lesson-panel`; the `"Loading lesson…"` / `"Loading admin panel…"` placeholders really appear mid-load; the `admin` chunk is not fetched until the admin panel is actually opened; a signed-out visitor loads the `login` chunk and neither `course` nor `admin`. The PDF viewer renders (96 pages, full toolbar).

## 4f. YouTube player (added later) — the RESOURCE_URL trap

- `yt-player.ts` binds `<iframe [src]>`, and **`iframe[src]` is an Angular `RESOURCE_URL` binding**: Angular 22 refuses a plain string there — `DomSanitizer.sanitize(SecurityContext.RESOURCE_URL, "https://…")` throws (NG0904, runtime `-904`) — so the `src` is silently never applied and the player is a blank black box. The binding must be a `SafeResourceUrl`, made with `DomSanitizer.bypassSecurityTrustResourceUrl(...)`.
- This was a long-standing bug from when YouTube lessons were first added, not from the `@defer` work: it was hit by a real-browser click-through (the symptom was mis-attributed at first because the defer pass also changed this code's surroundings). Ordinary `[href]` on `<a>` is the `URL` context, not `RESOURCE_URL`, so `lesson-resources.ts` is unaffected.
- Diagnosis worth repeating: run the page with `Page.addScriptToEvaluateOnNewDocument` patching `console.warn/error` to catch Angular's thrown error code, and inspect the built chunk — the minified `ɵɵsanitizeResourceUrl` (`vm`) and `DomSanitizerImpl.sanitize` show exactly which context throws.

## 4g. Picture-in-picture and subtitles (added later)

- **PiP:** `src/app/player.ts` no longer sets `disablepictureinpicture` on either media branch, so the skin's `media-pip-button` enters/exits browser PiP on MP4 and HLS. Verified with trusted clicks on both. YouTube media cannot enter PiP through the adapter; the button's availability there is Video.js's call.
- **Encoder (`tools/make-hls.sh`):** `subs()` runs for every source *before* the `[ -f "$dest/index.m3u8" ]` skip. It reads `ffprobe -select_streams s -show_entries stream=index,codec_name:stream_tags=language` and writes `index.<lang>[.<n>].vtt` with `ffmpeg -map 0:<idx> -c:s webvtt`. Language tags are lowercased and reduced to `[a-z0-9-]`, else `und`; collisions in one run get `.2`, `.3` (the counter is per run, so a re-run overwrites the same names rather than growing suffixes). Bitmap codecs (`hdmv_pgs_subtitle`, `dvd_subtitle`, `dvb_*`, `xsub`) are skipped. The video encode carries `-sn`; without it ffmpeg auto-selects a subtitle stream and the HLS muxer writes stray `index0.vtt` / `index_vtt.m3u8`.
- **Contract:** the Worker accepts `^(.+)/index\.([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.\d+)?\.vtt$`; group 2 is the `lang`. `listCourse` attaches `subtitles: [{ key, lang }]` (sorted by `lang` then `key`) to the folder's `index.m3u8` lesson. A folder containing only `.vtt` is not a lesson. `.vtt` is allowed by `serve`, typed `text/vtt`, hidden in `worker/files.js` like `.ts`, and `lessonOf` maps it to its folder so the scrape cap counts it with the lesson.
- **App:** `Lesson.subtitles?: Subtitle[]` (`src/app/api.ts`); `Player` takes `subtitles = input<Subtitle[]>([])`, builds `tracks()` with `Intl.DisplayNames` labels (duplicates get ` (2)`, `und` is shown as `Undetermined` because CLDR calls it "root") and renders one `<track kind="subtitles">` per entry inside the media element. No `default` attribute: the viewer enables captions from the skin's button (desktop) or Settings → Captions (below 512px, where `.video-controls-captions-button` is `display:none`). `course.ts` passes `l.subtitles ?? []`.
- **YouTube:** `src/app/yt-player.ts` passes `cc_load_policy: 1`, which makes YouTube turn its own captions on and paint them (verified on the user-reported ASR-only video and on a normal captioned video). With `0`, YouTube still reports a current track (often auto-generated, with `is_servable:false`) and the adapter marks the skin's track `showing`, so the UI looks enabled while the iframe paints nothing; selecting that track through `setOption('captions','track', …)` cannot recover it. The adapter still calls `setOption` when the viewer changes the skin's track, so turning captions off or picking another language keeps working.

## 4h. PDF resources on video lessons (added later)

- A **video or YouTube** lesson's **Resources** tab can now hold PDFs as well as links. The admin form switches **Link | PDF**; a PDF is uploaded in the same request (`POST /api/admin/lesson/<key>/resources/pdf`, multipart) rather than through the presigned file-manager flow, because it is small (25 MB cap, `%PDF-` magic check) and should become a resource row in one step. The title defaults to the file name; title ≤120 and note ≤300 are enforced by the Worker, and links and PDFs share the existing 100-resource-per-lesson cap.
- **Storage:** `<Course>/_resources/<uuid>.pdf`. `listCourse` skips any key containing `_resources`, and `worker/files.js` hides the folder from every file-manager listing, so a resource never becomes a lesson and cannot be browsed as content. The media route (`/api/media/<key>`) and the notes route (`/api/notes/<key>`) are reused unchanged, which is what gives resource PDFs exactly the same enrollment checks and per-student private annotations as a PDF lesson.
- **Client:** `ResourceItem.kind` drives the row (link rows open in a new tab as before; PDF rows open `app-pdf-viewer` in a fixed full-window modal). `PdfViewer` gained `fullWindow` (the modal sets it to `false`, hiding the viewer's own full-window button) and `Api.raw()` for the multipart request. Escape and Close both dismiss the modal and return focus to the row; the modal locks page scroll while open, so the two-column lesson layout behind it does not reflow.
- **Cleanup/rename:** deleting a resource removes the row, the R2 object and its `pdf_notes`. Deleting a lesson, section, course or YouTube lesson also deletes the PDFs of every resource attached to it (and their notes). `file_key` is rewritten with the lesson on a rename/move, a course rename carries `_resources` as ordinary objects, and a **cross-course** lesson move copies the PDFs into the destination course's `_resources` before the source is deleted. This is the only place the file manager needs to know about resources: `LESSON_ROWS` includes `UPDATE resources SET file_key = ...`.
- **Notes timing (shared viewer fix):** saved annotations must be applied after PDF.js renders **that page's** annotation editor layer. `pagesLoaded` fires earlier, and `addEditorAnnotation` silently skips notes when no editor layer exists yet, so the viewer waits for `annotationEditorLayerRendered` and restores each page's notes when its layer appears (pages farther down restore as the reader scrolls). A save merges in stored notes whose pages have not rendered yet, so an edit cannot delete them; `course.ts` also creates one viewer per lesson id, so moving between PDF lessons cannot reuse another document's note state. This affects PDF lessons too, which is why it was fixed in `pdf-viewer.ts` rather than in the modal.

Verified this session: `npm run typecheck`, `npm run build`, `wrangler deploy --dry-run`; the local access matrix (owner upload to an HLS and a YouTube lesson; a student opens both, highlights, reloads and keeps the annotation; a second student sees empty notes; a non-enrolled student gets `403` on media and notes; link resources still open in a new tab; delete of resource/lesson/YouTube/lesson-file cleans the row, object and `pdf_notes`; the file manager never lists `_resources`; negative checks for non-admin `403`, fake PDF `400`, 26 MB `413`, 101st resource `400`, long title `400`, long note `400`); and a live smoke test on the deployed Worker (upload to a YouTube lesson, student media `200`, highlight survives reload, then cleanup). Test data was removed afterwards.

Not covered: replacing or versioning an already-uploaded PDF (delete and upload again), PDF resources on **PDF** lessons (Resources stays video/YouTube-only), and resumable/direct-to-R2 uploads for PDFs (the 25 MB request-body cap is deliberate).

## 5. Known limitations and risks

1. A signed-in technical student can still capture or fetch media with their cookie (`yt-dlp`, or the file URL for plain MP4/PDF). No DRM.
2. The video watermark is a DOM element, removable with DevTools, and absent in native fullscreen. PDFs have no watermark.
2a. YouTube lessons get **no** download protection: the iframe cannot stop saving the video, the video id is visible in DevTools, and the video is reachable on YouTube itself. Use them only for content you are happy to publish on YouTube; the iframe does not enforce course access once the id is known. (The page still requires a session to list the lesson.)
2b. **No resolution selector.** YouTube no longer lets an embed choose playback quality (`setPlaybackQuality` is a no-op, `setPlaybackQualityRange` is undefined and undocumented); the only working quality menu is YouTube's own chrome, which the player hides. Self-hosted lessons are a single full-resolution rendition (`-crf 23 -preset veryfast`).
2c. **PiP is self-hosted only** and the email watermark is a DOM overlay, so it does not appear in the PiP window.
2d. **Existing HLS lessons gain subtitles only by re-running the encoder with the original source file.** The script extracts `.vtt` before the "already encoded" skip, but it can only see files present in `videos/`. Raw MP4/MKV lessons uploaded directly have no encoder step and therefore no subtitles. Bitmap subtitles (PGS/VobSub) are skipped. On phones the captions button is hidden; use Settings → Captions.
2e. **Resource PDFs cannot be replaced or versioned** — delete the resource and upload the new file (student annotations belong to the old file key and are deleted with it). They are only available on **video and YouTube** lessons, not PDF lessons, and they upload through the Worker, so the cap is 25 MB and there is no resumable/direct-to-R2 path. Resource PDFs have no watermark, like PDF lessons.
3. HLS segments are not encrypted; protection is the session cookie only.
4. Login lockout exists, but there is no Cloudflare WAF/bot protection configured; see `docs/SECURITY.md`.
5. No password change by the student, no self-service reset, no "disable" (only delete).
6. Progress, notes, comments and course access are keyed by R2 object/folder names. Renaming through the in-app file manager carries them; renaming with rclone, the dashboard or an S3 client does not.
6a. No access expiry dates; payment is manual (no gateway).
7. `listCourse` lists the whole bucket per cold isolate/cache expiry.
8. The schema helper only creates missing tables and adds missing columns, and the `schema_meta` version gate skips that work entirely on a matching cold start. Changing DDL requires bumping `SCHEMA_VERSION` (the hash test fails otherwise); there is still no manual migration command in the Git deploy.
9. The Worker is plain JavaScript with no tests; the frontend has no tests.
10. `ADMIN_PASSWORD` is authoritative: setting or changing it updates the stored hash on the next cold start, and removing it writes the unusable marker so only Google sign-in works for the owner.
11. The logo font is free for personal use only.

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
10. ~~GitHub Actions for build and type checks~~ **done** (`.github/workflows/ci.yml`: `npm ci`, `typecheck`, `build` on PRs and pushes to `main`).
11. A `sessions` table for instant revocation and device lists — single-session enforcement already ships via `users.sid` (one live student session, admins exempt).
12. A paid DRM or per-user watermarking service if leaks become a real problem.

## 7. Constraints to respect

- Stay on Cloudflare Workers, R2 and D1; keep cost near zero.
- Keep `wrangler.toml` bindings without IDs so Git deploys self-provision.
- Keep the deploy command `npm run deploy` (Angular build, then `wrangler deploy`).
- Keep the Angular major current (`ng update`); Angular 22 needs Node 22.22.3+/24.15+ and TypeScript 6.0+. The Workers Builds image defaults to Node 24; `.nvmrc` pins the same for local and CI.
- Keep the Worker `/api` contract and the Angular `Api` service in sync; change both together.
- Never commit secrets, `.dev.vars`, `node_modules`, `dist`, or media files.
- Upload media with `rclone`, never through git.
- YouTube lesson paths keep the R2 key shape (`<Course>/<Folder>/<Name>`); the first segment is the course, so it must match a course folder name to join an existing course. They live in D1 and are edited from Admin → Files; `worker/youtube.js` is a first-run seed only.

## 8. Run and test

```bash
npm install
cp .dev.vars.example .dev.vars     # SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, R2_* for uploads
npm run build
npm run api      # Worker on http://localhost:8787 (local D1 and R2)
npm start        # Angular on http://localhost:4200
```

In dev the bindings use local D1/R2, but multipart uploads are signed and sent through the S3 API with the `R2_*` values from `.dev.vars`, so a local upload run writes real parts to `<bucket-name>`. Clean up test keys after a run; a crashed run can leave an incomplete upload, which the bucket lifecycle rule aborts after 7 days.

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

If a lesson already lives on YouTube, add it in **Admin panel → Files** (the **YouTube** button) instead of uploading (see the README's "YouTube lessons" section and section 4d above). No R2 object, no upload, no cost, no redeploy.

Bucket: `<bucket-name>`. See the README for the folder mapping, the `rclone` setup and the MP4 `-movflags +faststart` fix (required for plain MP4 so playback starts without downloading the whole file).

```bash
rclone copy "/path/to/video.mp4" "r2:<bucket-name>/Course Name/" --progress
```

## 10. Prompt to give another AI

> Read `docs/HANDOFF.md`, `README.md` and `docs/PLAN-google-login.md` first, then review `worker/index.js` and `src/app/`. Do not change the platform (Cloudflare Workers, R2, D1) or the Git-based deploy flow. Start with section 6 of the handoff. For every change, explain what you changed and why, keep the Worker API and the Angular `Api` service consistent, and tell me anything you could not verify.
