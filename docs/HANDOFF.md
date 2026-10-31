# Handoff: how this project was built and where it stands

For a developer or AI assistant who will review, optimize or extend the project. Read it fully before changing anything. Last updated after the admin panel, UI redesign and mobile pass.

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
   |-- D1  binding DB      users, watched
   '-- R2  binding VIDEOS  <Course>/<Folder>/.../<file>
```

`wrangler.toml` uses `run_worker_first = ["/api/*"]`.

### File map

| Path | Purpose |
| --- | --- |
| `worker/index.js` | Entire backend: auth, admin seeding and endpoints, course listing, media streaming, progress |
| `src/app/api.ts` | `Api` service: fetch wrapper (GET/POST/DELETE) and app state signals (`me`, `courses`); user-admin calls |
| `src/app/app.ts` | Root: header (logo, Admin panel toggle, Sign out), switches course/admin views |
| `src/app/login.ts` | Sign-in form |
| `src/app/course.ts` | Sidebar, folder browser with breadcrumb, lesson view, Mark as complete |
| `src/app/player.ts` | Video element + moving email watermark (native controls) |
| `src/app/pdf-viewer.ts` | PDF reader configuration |
| `src/app/admin.ts` | Admin panel UI |
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
```

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
| `GET /api/admin/users` | admin | Users with `watched` count and `owner` flag |
| `POST /api/admin/users` | admin | `{email, password, is_admin?, google_only?}`; `google_only` stores an unusable random password hash |
| `POST /api/admin/users/bulk` | admin | Bulk add; Google-only rows store the marker `'!'` as `pass` (no hashing, `checkPw` rejects it); password rows are hashed one by one, so capped at 20 per request (the UI chunks) |
| `POST /api/admin/users/<id>/password` | admin | Reset password |
| `POST /api/admin/users/<id>/role` | admin | `{is_admin}`; blocked for the Owner and yourself |
| `DELETE /api/admin/users/<id>` | admin | Deletes user and their `watched` rows; blocked for the Owner and yourself |

Secrets (dashboard, never in git): `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Variable: `GOOGLE_CLIENT_ID` (public; enables Google sign-in).

### Course discovery (`listCourse`)

1. List all R2 keys (paginated, 1000 per call); cached in memory for 60 s per isolate.
2. Keep videos (`mp4 webm mkv mov avi m4v m3u8`) and `.pdf`; skip `.ts` segments and root-level files.
3. Course = first path segment. Section = remaining directories joined by `" / "` (empty = course root).
4. `.m3u8` lessons are titled by their parent folder; others by file name without extension.
5. Sort with a numeric-aware collator.

The Angular browser (`course.ts`) rebuilds the folder tree from `section.title` and shows only the current level.

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

## 5. Known limitations and risks

1. A signed-in technical student can still capture or fetch media with their cookie (`yt-dlp`, or the file URL for plain MP4/PDF). No DRM.
2. The video watermark is a DOM element, removable with DevTools, and absent in native fullscreen. PDFs have no watermark.
3. HLS segments are not encrypted; protection is the session cookie only.
4. No login rate limiting or lockout.
5. No password change by the student, no self-service reset, no "disable" (only delete).
6. Progress is keyed by R2 object key, so renaming loses it.
7. `listCourse` lists the whole bucket per cold isolate/cache expiry.
8. The schema helper only creates missing tables; altering a table needs a manual `wrangler d1 execute` or a try/catch `ALTER` step.
9. The Worker is plain JavaScript with no tests; the frontend has no tests.
10. Changing `ADMIN_PASSWORD` after the first run does not update the stored hash.
11. The logo font is free for personal use only.
12. `@angular/router` is listed in `package.json` but not used.

## 6. Backlog (suggested order)

1. Run `npm run build`, open the site, and fix whatever breaks (PDF layout, admin flows, mobile).
2. Google login is implemented; do the Google Cloud setup in `docs/PLAN-google-login.md` and test it end to end (the JWT verification was unit-tested with a locally generated key, not against real Google).
3. Login rate limiting (Workers Rate Limiting binding or a Cloudflare rule).
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
cp .dev.vars.example .dev.vars     # SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
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

Bucket: `course-sourse`. See the README for the folder mapping, the `rclone` setup and the MP4 `-movflags +faststart` fix (required for plain MP4 so playback starts without downloading the whole file).

```bash
rclone copy "/path/to/video.mp4" "r2:course-sourse/Course Name/" --progress
```

## 10. Prompt to give another AI

> Read `docs/HANDOFF.md`, `README.md` and `docs/PLAN-google-login.md` first, then review `worker/index.js` and `src/app/`. Do not change the platform (Cloudflare Workers, R2, D1) or the Git-based deploy flow. Start with section 6 of the handoff. For every change, explain what you changed and why, keep the Worker API and the Angular `Api` service consistent, and tell me anything you could not verify.
