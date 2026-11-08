# Security and download protection

## The honest limit
A browser has to receive the video and PDF bytes to show them, so **nobody can make downloading truly impossible**. A signed-in student can always screen-record, and a determined technical one can write a script that behaves like a browser. What this site does is make casual and automated downloading hard, limit the damage, and keep leaks traceable. Against browser extensions and screen recording, **a DRM video host is the only real protection**; everything here raises the effort and makes leaks traceable. Only paid DRM (Widevine/FairPlay, e.g. via a video platform such as Bunny Stream, Mux, Vimeo or VdoCipher) goes further. A burned-in per-student watermark makes leaks traceable.

## What is in place

### Accounts
- Passwords: PBKDF2-SHA256, salted, 100,000 iterations. Google sign-in is invite-only and checks the token's signature, issuer, audience, expiry and verified email.
- **Login timing:** a failed sign-in always runs one PBKDF2 derive — even for an email that does not exist, or a Google-only account with no usable password — and always answers "Wrong email or password". Response time and message therefore do not reveal whether an email exists.
- **Login throttling:** 8 failed password attempts per email+IP, 40 failures per IP, and 30 per email, lock sign-in for 15 minutes. The counters live in a SQLite-backed Durable Object (one object per key), so they hold across all Worker instances; the D1 `attempts` table remains an automatic fallback if an object errors or stalls. Google sign-in failures count per IP.
- **Sessions:** HMAC-signed `HttpOnly; Secure; SameSite=Strict` cookie, 7 days. Each session carries a version number; **resetting a password or changing a role signs that user out everywhere**. Deleting a user ends their session immediately. A new login also replaces the account's session id, so a student's older devices are signed out.
- **Sign out everywhere (admins):** `POST /api/logout/all` bumps the session version, ending every session for that account, and is exposed as "Sign out everywhere" in the options menu. It is shown to admins only. An admin is exempt from the single-session rule and can be signed in on several devices at once, so the menu gives them one way to end all of them. Students do not see it: a student already has exactly one live session — a new login displaces the old device — so plain "Sign out" is the whole of it.
- **`SESSION_SECRET` must be set and be at least 32 characters.** The Worker answers a generic `500 Server error` on every API call when it is missing or too short (fail closed, with no detail about the variable in the response).
- **Owner (admin):** the Owner is created from `ADMIN_EMAIL` and is **Google-only in production** — leave `ADMIN_PASSWORD` unset. When it is unset, the stored password is an unusable marker, so password sign-in for the Owner fails and no hashing cost is paid. Add `ADMIN_PASSWORD` only to allow password sign-in, and remove it again to go back to Google-only.
- **CSRF:** `SameSite=Strict`, plus the Worker rejects any state-changing request whose `Origin`/`Sec-Fetch-Site` is not this site.
- No self-signup; only admins create users. The Owner cannot be deleted or demoted in the app.

### Headers
Pages are served from `public/_headers` with `nosniff`, `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` (so the site cannot be embedded), HSTS `max-age=31536000; includeSubDomains` (no `preload`), a referrer policy, a locked-down permissions policy, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (needed for the Google popup), and `X-Robots-Tag: noindex, nofollow`. The Worker adds the same core set to every API response — `nosniff`, `X-Frame-Options: DENY`, HSTS, the referrer and permissions policies, `Cross-Origin-Resource-Policy: same-origin` — plus `cache-control: no-store`. (`_headers` covers the static assets only, so the CSP and the opener policy are on the pages, which is where they matter.)

The Content-Security-Policy is **enforced**, not report-only. It contains no `unsafe-eval` and no `script-src 'unsafe-inline'`: the theme bootstrap is an external `public/theme-init.js`, and the production build does not inline critical CSS. It deliberately allows:
- Video.js: `script-src 'self' 'wasm-unsafe-eval'`, blob workers (`worker-src blob:`), same-origin media (`media-src 'self' blob:`);
- PDF.js: `worker-src 'self' blob:` and same-origin assets;
- Google sign-in: `script-src https://accounts.google.com/gsi/client`, `style-src https://accounts.google.com/gsi/style`, `frame-src https://accounts.google.com/gsi/`, `connect-src https://accounts.google.com/gsi/`;
- YouTube: `script-src https://www.youtube.com` (the IFrame API) and `frame-src https://www.youtube.com https://www.youtube-nocookie.com`;
- uploads straight to R2: `connect-src https://*.r2.cloudflarestorage.com`.

A new third-party host must be added to this list deliberately. The only wildcard is the existing R2 endpoint wildcard (the account id differs per fork) and `https://*.googleusercontent.com` for Google profile images.

### File manager and uploads
- Every file-manager route lives under `/api/admin/` behind the existing admin check, so students cannot list, read, write or delete course files. The CSRF rule above applies to all of them.
- Uploads go **browser → R2** with presigned S3 URLs that expire in **one hour**. The signing credentials (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) live only in Worker secrets; the browser never sees them. A presigned URL is a bearer token for one object (or one part) until it expires — do not paste one into a chat or a ticket.
- The R2 API token should be scoped to the bucket (`<bucket-name>` — the real name is the `bucket_name` in `wrangler.toml`) with Object Read & Write only, and rotated if it ever leaks. It is not the Cloudflare account API token.
- The bucket name itself is not a secret, but it is kept out of the docs: it appears only where deployment needs it (`wrangler.toml`, the fallback in `worker/s3.js`, and `scripts/cloudflare.mjs`). R2 buckets cannot be renamed, so changing it in `wrangler.toml` alone would break existing objects — change the binding and the bucket together, or leave it.
- Bucket CORS is written by `npm run deploy` / `npm run setup:r2`, not by hand: it keeps the origins already there, adds the deployed site plus localhost (and `UPLOAD_ORIGINS`), allows methods `GET, HEAD, PUT, POST` and the `content-type` header, and exposes only `ETag`. `npm run doctor` verifies it. The CSP's `connect-src` uses `https://*.r2.cloudflarestorage.com` because the browser talks to the bucket directly and the account endpoint differs per fork.
- Uploads accept any file type (the owner uploads PDFs, videos, and handouts); size is capped at 500 GB and keys must stay inside a course. Only files with a lesson extension become lessons and carry student data.
- Moves and deletes run in the Worker through the R2 binding and are admin-only. A move is copy → rewrite D1 → delete originals: if the record rewrite fails partway the copies stay, so no student row ever points at a missing object, and re-running the same move finishes it.
- The `R2_*` secrets are optional: without them everything except uploads still works, and uploads answer `503`.

### Media (videos, YouTube and PDFs)
- Every request needs the session cookie **and an enrolled course**: students only get media, notes and the course list for the courses an admin gave them (admins get all), checked on every request in the Worker. `GET /api/order` applies the same rule to the saved position map, so it reveals nothing about courses the student cannot see.
- **Browser-only gate:** the Worker requires `Sec-Fetch-Site: same-origin` and a media-type `Sec-Fetch-Dest`. Browsers send these automatically; `curl`, `wget`, `yt-dlp` and most download managers do not, and other websites cannot fake them. Opening a media URL in the address bar, an iframe or a new tab is refused. `Cross-Origin-Resource-Policy: same-origin` stops hotlinking.
- **YouTube ids are fetched one at a time:** `GET /api/lesson/<id>/yt` (`Cache-Control: no-store`) runs the same access check as media, counts toward the same per-hour lesson limit, and answers `{ yt }` only for a YouTube lesson the user may open. `GET /api/course` never includes a `yt` field, so a single catalogue response cannot be scraped for every video id. The Admin YouTube routes still return `yt` for management.
- **Scrape limit (across Worker instances):** a student can open at most **20 distinct lessons per hour**. The counter lives in a SQLite-backed Durable Object (`lessons:<userId>`: one row per user, hour and lesson, written only when a lesson is new for that hour and cleaned up on access), so every Worker instance shares it; the D1 table `lesson_hits` remains the fallback if the object errors or stalls. Admins are exempt; `MAX_LESSONS_PER_HOUR` changes the limit. Both `/api/media/*` and `/api/lesson/<id>/yt` count. Grabbing a whole course in one go gets `429`.
- **Slow-down (against extensions such as FetchV, and download managers):**
  - Video files (`mp4 webm mkv mov avi m4v`) are served only to *range* requests, which is how every browser plays video. A plain "download this URL" request is refused.
  - Each answer is at most 4 MB, so a whole file needs hundreds of requests.
  - Each student's total media speed is capped at `MAX_MBPS` (default 12 Mbit/s, with a 20-second burst for buffering and seeking). Requests above the cap are delayed, not rejected, so playback stays smooth while bulk downloading is slow. Admins are exempt. **This cap is per Worker instance, so it is best effort** and does not coordinate across instances.
  - Raise `MAX_MBPS` if a high-bitrate video buffers; lower it to slow downloads further.
  - **PDFs are paced by body, not by request.** PDF.js always opens a PDF with one plain `GET` (it only switches to byte ranges for files larger than twice its chunk size, and that first request — like a downloader's — carries no `Range`), so a PDF request cannot be refused or chunk-capped without breaking the viewer. Instead every PDF body flows through a per-student token bucket at `MAX_PDF_MBPS` (default: `MAX_MBPS`) with a 5-second burst, so a single response cannot dump a whole file at wire speed. The bytes still arrive, just slowly, and opening the first pages is unaffected.
- Player: native download, remote playback and Picture-in-Picture are off, right-click is off, and the student's email floats over the video.
- PDF viewer: print, download and open buttons are removed, `supportsDownloading` is `false`, `Ctrl/Cmd+S` and `+P` are blocked, drag-and-drop open is off and the context menu is off. Download must stay disabled. The same drifting **per-student email watermark** the video player uses is drawn over the pages, in a dark translucent ink so it shows on light pages.
- PDF responses are `Cache-Control: private, no-store`, like video, and the viewer/worker scripts are prefetched, so the bytes are not kept by the browser. The body is paced (`MAX_PDF_MBPS`), so grabbing the file is slow.
- PDF notes are private: every `/api/notes` query is scoped to the signed-in user and the course is checked; notes are capped at about 1.5 MB per PDF.
- Images pasted into PDF notes are **not** stored in the notes row. PDF.js serializes a stamp as a full-resolution base64 PNG, which would blow the 2 MB D1 row limit and — fetched back as a `data:` URL — is blocked by the page CSP. Instead the browser uploads each image once to R2 under a private `_notes/<user>/<sha256>` key (`PUT /api/note-asset/<lesson>/<id>`), and the note keeps the short same-origin URL. The route is scoped to the signed-in user and the course exactly like notes, serves only the whitelisted image types (`image/*`; SVG is sandboxed), caps one image at 16 MB and 500 images per account, and the objects are swept when the notes, the lesson or the student are deleted. The `_notes` prefix is hidden from the course list and the admin file manager.
- `POST /api/progress` now requires the lesson to exist and the course to be granted (404/403 otherwise), like comments, notes and resources.
- Printing or "Save as PDF" of the web page itself produces a blank page.

## Browser extensions (FetchV, Video DownloadHelper, etc.)
These run *inside* the student's browser. They watch the same requests the player makes, with the same cookie, and many replay them from the page, so the server cannot tell them from the real player. They also save the raw file, **without the on-screen email watermark**. The slow-down above makes them take much longer, but nothing short of DRM stops them.

## Known gaps (what a determined student can still do)
1. Copy the cookie and the `Sec-Fetch-*` headers into a script or `yt-dlp` and download. The browser gate raises the effort; it is not a lock.
2. Plain MP4/WebM files are a single downloadable object once a script passes the gate. HLS (`tools/make-hls.sh`) splits them into segments, which is more work to reassemble (`yt-dlp` still can). Encrypting HLS segments with AES-128 helps little, because the key must be given to the legitimate player too. A PDF likewise comes down in one request, but its body is paced (`MAX_PDF_MBPS`), so a full grab is slow.
3. Screen recording and phone cameras cannot be stopped. The email watermark makes leaks traceable, but it is not visible in the browser's native fullscreen.
4. The scrape limit is shared across instances (Durable Object, D1 fallback), but a script that passes the `Sec-Fetch` gate can still open up to 20 lessons an hour; the speed cap is still per instance and best effort.
5. Sessions last 7 days. A student account has one live session at a time (a new login displaces the old device), and an admin can end every one of their own sessions with "Sign out everywhere". There is no per-device list or per-device revocation.
6. A stolen **admin** session can rewrite or delete course files, because the file manager trusts the session like the rest of the panel. Admin accounts deserve strong, unique credentials, the Owner is Google-only in production, and Cloudflare Access in front of `/api/admin/*` (below) is the strongest next step.

## Free-plan capacity
- Every HLS segment is a separate Worker request. The free plan allows about **100,000 requests per day**, so a busily-watched HLS lesson uses that budget quickly (a two-hour video can be hundreds of segments per view). Prefer a single MP4 where the larger single-file download risk is acceptable, or keep HLS and watch the request count. A formula is `~100k / average segments per lesson` lessons served per day.
- D1 is used for the fallback rate-limit tables, notes and progress. The lesson counter is normally a Durable Object that writes one row per new lesson per hour and deletes old hours on access, keeping writes low.

## Manual checklist (you do these)
Cloudflare dashboard (free plan):
1. **WAF → Rate limiting rules:** one rule covering `/api/login*` and `/api/media/*` (e.g. 60 requests per minute per IP, action Block for 60 s). Free plan allows one rate-limiting rule.
2. **Security → Settings:** turn **Bot Fight Mode** on.
3. **SSL/TLS → Edge Certificates:** turn **Always Use HTTPS** on.
4. **Security → Settings:** set **Security Level** to **Medium**.
5. Optional but recommended: put **Cloudflare Access** (free, up to 50 users) in front of `/api/admin/*` (Zero Trust → Access → Applications → Self-hosted, path `*.example.com/api/admin/*`, policy = the Owner's email), and turn on **2-step verification** for the Owner's Google account.

History scan (run from the repo):
```
git log --all --full-history -- .dev.vars
gitleaks detect --no-banner --redact
trufflehog git file://. --only-verified
```
If either finds a value: **rotate the R2 API token and `SESSION_SECRET`**, and consider making the repo private (git history keeps removed files).

## Recommended next steps (highest value first)
0. For real protection against extensions, use a DRM video host (Bunny Stream, Mux, Vimeo, VdoCipher). A burned-in per-student watermark makes leaks traceable.
1. Put Cloudflare Access in front of `/api/admin/*` and enable 2-step verification on the Owner's Google account (see the checklist).
2. Serve video as HLS only and remove MP4s from the bucket, then watch the free-plan request budget (see "Free-plan capacity").
3. Per-user burned-in watermarking, or a DRM/video service, if leaks become a real problem.
4. Extend the Worker tests. The suite already covers the security routes — login throttling and enumeration, the media browser gate and range-only rule, the per-hour limit, progress access, per-lesson YouTube ids and sign-out-everywhere — by driving the real entry point against an in-memory D1 (`node:sqlite`) and a fake R2 (`worker/security.test.mjs`). Admin-permission routes are the next addition.

## Environment options
| Name | Purpose |
| --- | --- |
| `MAX_LESSONS_PER_HOUR` | Distinct lessons per student per hour (default 20; admins exempt) |
| `MAX_MBPS` | Per-student media speed cap in Mbit/s (default 12), best effort per Worker instance. Raise it if high-bitrate videos buffer |
| `RELAX_FETCH_METADATA=1` | Turns off the `Sec-Fetch` check if a very old browser cannot play media |
