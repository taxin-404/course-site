# Handoff: how this project was built

This document is written for a developer or AI assistant who will review and optimize the project. It records the requirements, the decisions and why they were made, what was actually verified, and where the weak points are. Read it fully before changing anything.

## 1. Goal and requirements

A private video course site for a small cohort (about 6 students, expected to grow to a few hundred at most).

- About 30 GB of video now, planned 60 GB, plus PDFs.
- Videos must be stream-only. The owner wanted "no one can download it", which was explained to be impossible in absolute terms. The agreed target is to make downloading hard and leaks traceable.
- The site must show lessons organized exactly like the folders in the storage bucket.
- Cost must stay very low. The owner already has a Cloudflare account with R2 enabled (billing attached).
- Deploys must happen automatically when the Git repo is connected to the Cloudflare dashboard (Workers Builds).
- Frontend must be Angular.

## 2. Decision log

| Decision | Reason |
| --- | --- |
| Not YouTube unlisted | The video ID is visible in DevTools and the link is permanent. Hiding the ID in a Cloudflare secret does not help, because the browser must receive it to play the video. |
| Cloudflare R2 for storage | Egress is free, storage is about $0.015/GB-month. 60 GB costs roughly $0.75 to $1 per month. |
| Cloudflare Worker serves media | Lets the server check a login before any byte is sent. Supports HTTP range requests, so seeking works. |
| HLS only (m3u8 plus .ts segments) | No single video file exists to "save as", and download-manager extensions find nothing. A `<video>` plays it through hls.js (Media Source Extensions). Safari plays HLS natively. |
| Session cookie instead of signed URLs | Media URLs only work with a valid `HttpOnly` session cookie, so a copied link is useless to anyone else. This is simpler than per-URL signed tokens and equally effective against link sharing. |
| Course structure derived from the bucket | The owner wanted the site to mirror bucket folders. No lesson table exists. Uploading files is the only content-management step. |
| D1 for users and progress only | Small relational data. Progress is keyed by the R2 object key string. |
| Schema created lazily by the Worker | The Git deploy flow has no safe place to run migrations before the first deploy (the database does not exist yet). The Worker runs `CREATE TABLE IF NOT EXISTS` once per isolate. Pattern copied from the NodeWarden project. |
| `wrangler.toml` bindings without IDs | Cloudflare automatically provisions the D1 database and R2 bucket on the first Git deploy. No manual setup, no IDs committed. Also taken from NodeWarden. |
| Angular 21, not 22 | Angular 22 requires Node 22.22.3 or newer. Cloudflare's build image may be older. Angular 21 supports Node 20.19+ and 22.12+. |
| No Angular router, no UI library | One screen after login. Fewer dependencies. |
| hls.js and pdfjs-dist from npm, lazy-loaded | Keeps the first load small (about 51 kB) and avoids a third-party CDN. |
| PDFs drawn to canvas with pdf.js | Removes the browser PDF toolbar (download and print buttons) and lets a watermark be baked into the page pixels. |
| Passwords with PBKDF2-SHA256, 100,000 iterations | Available in Web Crypto inside Workers. 100,000 is the maximum Workers allows. |

## 3. Architecture

```
Browser (Angular SPA)
   |  fetch /api/*  (cookie: s=...)
   v
Cloudflare Worker  (worker/index.js)
   |-- static assets: dist/web/browser   (served directly, Worker not invoked)
   |-- D1  binding DB      users, watched
   '-- R2  binding VIDEOS  <Section>/<Lesson>/index.m3u8 + seg_*.ts, <Section>/*.pdf
```

`wrangler.toml` uses `run_worker_first = ["/api/*"]`, so only API paths hit the Worker code. Everything else is served as a static asset from the Angular build output.

### File map

| Path | Purpose |
| --- | --- |
| `worker/index.js` | Entire backend: auth, course listing, media streaming, progress, admin |
| `src/app/api.ts` | `Api` service: fetch wrapper and app state as signals (`me`, `course`) |
| `src/app/app.ts` | Root component: header, sign out, admin toggle; `admin.ts` is the admin panel |
| `src/app/login.ts` | Sign-in form |
| `src/app/course.ts` | Sidebar with sections, lessons, progress bars, and the lesson view |
| `src/app/player.ts` | HLS video player with a moving watermark |
| `src/app/pdf-viewer.ts` | pdf.js reader, renders pages to canvases with a tiled watermark |
| `src/styles.css` | All styling, light and dark via `prefers-color-scheme` |
| `angular.json` | Copies `pdf.worker.min.mjs` from pdfjs-dist to `/pdf/` as a static asset |
| `tools/make-hls.sh` | ffmpeg conversion to HLS, copies PDFs unchanged |
| `proxy.conf.json` | Dev only: proxies `/api` from `ng serve` to `wrangler dev` on port 8787 |

### Data model (D1)

```sql
users   (id INTEGER PK, email TEXT UNIQUE, pass TEXT, is_admin INTEGER)   -- pass = "<b64 salt>.<b64 PBKDF2 hash>"
watched (user_id INTEGER, lesson TEXT, PRIMARY KEY (user_id, lesson))      -- lesson = R2 object key
```

### API

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /api/login`, `/api/logout` | none | Sets or clears the cookie |
| `GET /api/me` | session | `{id, email, is_admin}` |
| `GET /api/course` | session | `[{title, lessons:[{id, title, kind:'video'|'pdf', done}]}]` |
| `GET /api/media/<url-encoded key>` | session | Serves `.m3u8`, `.ts`, `.pdf` (and `.mp4`/`.webm` only if env `ALLOW_MP4=1`) |
| `POST /api/progress` | session | `{lesson, done}` |
| `POST /api/admin/users` | admin | `{email, password}` |

Secrets (set in the dashboard, never in git): `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (first admin is seeded from these). Optional variable: `ALLOW_MP4`.

### Course discovery (`listCourse` in the Worker)

1. List all R2 keys (paginated, 1000 per call). Cached in module memory for 60 seconds per isolate.
2. Keep keys ending in `.m3u8` or `.pdf` (plus mp4/webm if `ALLOW_MP4=1`).
3. Section = the directory path joined with " / " (or "Lessons" if the file is at the root).
4. For `.m3u8` the lesson title is the parent folder name. For PDFs it is the file name without extension.
5. Sort sections and lessons with a numeric-aware collator, so `02` sorts before `10`.

### Media serving (`serve` in the Worker)

- Allow-list of extensions; everything else returns 403.
- Refuses requests with `Sec-Fetch-Dest: document`, so opening a media URL in the address bar fails.
- Passes the request headers to `R2.get(key, {range})` and builds a 200 or 206 response with `Content-Range`.
- Sets `Cache-Control: private, no-store`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`.

### Auth

- Cookie `s=<base64url(JSON{uid,exp})>.<base64url(HMAC-SHA256 with SESSION_SECRET)>`, `HttpOnly; Secure; SameSite=Strict`, 7 days.
- Each request re-reads the user row, so deleting a user row ends their sessions.
- CSRF relies on `SameSite=Strict` plus JSON request bodies.

### Download deterrents (frontend)

- Video: `controlsList="nodownload noremoteplayback"`, `disablePictureInPicture`, context menu disabled, native fullscreen button hidden in Chromium (a custom button fullscreens the wrapper so the watermark stays visible). The student's email moves to a random position every 15 seconds.
- PDF: canvas rendering, no toolbar, text not selectable, email tiled at 12% opacity into each page canvas.

## 4. What has and has not been verified

Verified in a sandbox:

- `ng build` succeeds (Angular 21.2, TypeScript strict templates).
- The Worker ran under `wrangler dev` with local D1 and R2 seeded with a fake HLS lesson, an MP4, and a PDF. Checked with curl: first-admin setup, wrong and right login, unauthenticated rejection, course listing built from keys, playlist and PDF content types, a 206 range response with the correct `Content-Range`, MP4 blocked by default, `Sec-Fetch-Dest: document` blocked, progress saved, student rejected from the admin endpoint, static site and `/pdf/pdf.worker.min.mjs` served.

Not verified (treat as unknown):

- Any click-through in a real browser: layout, the lesson list, watermark placement, fullscreen behavior.
- Real HLS playback with hls.js, and Safari native HLS.
- pdf.js v6 rendering. `page.render` is called with both `canvas` and `canvasContext` to be safe across versions; confirm there are no console warnings.
- An actual Cloudflare Git-connected deploy, including automatic provisioning of the D1 database and R2 bucket and the Node version in the build image.
- Behavior on the Workers Free plan CPU limit (10 ms). PBKDF2 at 100,000 iterations may exceed it on login.
- Behavior with large libraries (hundreds of lessons) and 30 to 60 GB of real video.

## 5. Known limitations and risks

1. A signed-in technical student can still capture the stream (for example `yt-dlp` with their cookie), and anyone can screen-record. There is no DRM.
2. The video watermark is a DOM element and can be removed with DevTools. The PDF watermark is baked into the canvas pixels but not into the raw PDF that is fetched.
3. HLS segments are not encrypted. Protection relies on the session cookie only.
4. No login rate limiting or lockout.
5. No password change or reset, no student list, no delete or disable student. Admin can only add students.
6. Progress is keyed by R2 object key, so renaming a folder or file loses that lesson's progress.
7. `listCourse` lists the whole bucket per cold isolate and cache expiry (cheap, but it grows with bucket size).
8. The schema helper only creates missing tables. Altering a table needs a manual `wrangler d1 execute`.
9. The Worker is plain JavaScript with no tests and no types.
10. The converter re-encodes everything to a single 6-second-segment H.264 rendition. There is no adaptive bitrate, so slow connections may buffer.

## 6. Optimization backlog (suggested order)

1. Run it in a browser end to end and fix whatever breaks (player, PDF reader, fullscreen, mobile layout).
2. Add login rate limiting with the Workers Rate Limiting binding or a Cloudflare rule.
3. Admin features: list, disable, delete students, reset password. Add `DELETE` and `PATCH` endpoints and a small admin view.
4. Resume playback position per lesson (store seconds in D1) and deep links such as `#lesson=<key>`.
5. Multi-bitrate HLS (for example 360p, 720p, 1080p) with a master playlist.
6. Encrypt HLS segments with AES-128 and serve the key from an authenticated endpoint with a short-lived, per-session key URL.
7. Generate a `manifest.json` during upload (extend `make-hls.sh`) so the Worker does not list the bucket, or cache the listing in KV.
8. Render PDF pages lazily with `IntersectionObserver` for very long documents.
9. Port `worker/index.js` to TypeScript, split into modules (auth, course, media), and add tests using Vitest with `@cloudflare/vitest-pool-workers`.
10. Add GitHub Actions for build and type checks on pull requests.
11. Move to stateful sessions (a `sessions` table) if instant revocation and device management are needed.
12. Consider a paid DRM or per-user server-side watermarking service if leaks become a real problem.

## 7. Constraints to respect while optimizing

- Keep it on Cloudflare Workers, R2, and D1, and keep the cost near zero.
- Keep `wrangler.toml` bindings without IDs, so Git deploys self-provision.
- Keep the deploy command `npm run deploy` (builds Angular, then `wrangler deploy`).
- Keep Angular 21 unless the Cloudflare build Node version is confirmed to support a newer release.
- Keep the Worker `/api` contract and the Angular `Api` service in sync; change both together.
- Never commit secrets, `.dev.vars`, `node_modules`, `dist`, or any video or PDF files.
- Videos and PDFs are uploaded with `rclone` to R2, never through git.

## 8. Run and test

```bash
npm install
cp .dev.vars.example .dev.vars
npm run build
npm run api      # terminal 1: Worker on http://localhost:8787 (local D1 and R2)
npm start        # terminal 2: Angular on http://localhost:4200
```

Seed local R2 for testing:

```bash
npx wrangler r2 object put "course-videos/01 Basics/Notes.pdf" --file ./Notes.pdf --local
```

Smoke test (cookie jar `-c`/`-b`):

```bash
curl -X POST localhost:8787/api/setup -H "x-setup-key: setup123" -H "content-type: application/json" -d '{"email":"a@x.com","password":"longpassword1"}'
curl -c jar -X POST localhost:8787/api/login -H "content-type: application/json" -d '{"email":"a@x.com","password":"longpassword1"}'
curl -b jar localhost:8787/api/course
curl -b jar -H "Range: bytes=0-99" "localhost:8787/api/media/01%20Basics/Notes.pdf" -i
```

## 9. Prompt to give another AI

> Read `docs/HANDOFF.md` and `README.md` first, then review the code in `worker/index.js` and `src/app/`. Do not change the platform (Cloudflare Workers, R2, D1) or the Git-based deploy flow. Start with section 6 of the handoff, items 1 to 4. For every change, explain what you changed and why, keep the Worker API and the Angular `Api` service consistent, and tell me anything you could not verify.

## 10. Uploading course videos to R2

### Bucket name
`course-sourse`

### R2 structure
- Top-level folder = Course name (shown in sidebar)
- Sub-folder inside course = Section (shown as a labeled group)
- Files at any level = Lessons

Examples:
```
Python Basics/intro.mp4                        → course "Python Basics", lesson "intro"
Python Basics/Chapter 1/variables.mp4          → course "Python Basics", section "Chapter 1", lesson "variables"
Another Course/lesson1.mp4                     → separate course "Another Course"
```

### Upload large files (300MB+) with rclone

The Cloudflare dashboard and Wrangler both have a 300MB upload limit. Use rclone for larger files.

Configure rclone (one time):
```bash
rclone config update r2 \
  access_key_id=<R2_ACCESS_KEY_ID> \
  secret_access_key=<R2_SECRET_ACCESS_KEY> \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  provider=Cloudflare \
  no_check_bucket=true
```

Upload a file:
```bash
rclone copy "/path/to/video.mp4" r2:course-sourse/CourseName/ --progress
```

### Fix mp4 files before uploading (required)

Raw or screen-recorded mp4s usually have their `moov` atom (metadata) at the end of the file. The browser cannot start streaming until it downloads the entire file. Fix this before uploading:

```bash
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```

This does not re-encode — it only moves the metadata to the front. Takes ~30 seconds even for large files.

Fix all mp4s in a folder at once:
```bash
for f in /path/to/course/*.mp4; do
  ffmpeg -i "$f" -c copy -movflags +faststart "${f%.mp4}_fixed.mp4"
done
```

Always upload the `_fixed` version to R2.

## 11. Next planned feature

Google login (invite-only, ID-token flow): see `docs/PLAN-google-login.md`.
