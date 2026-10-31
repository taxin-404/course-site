# Security and download protection

## The honest limit
A browser has to receive the video and PDF bytes to show them, so **nobody can make downloading truly impossible**. A signed-in student can always screen-record, and a determined technical one can write a script that behaves like a browser. What this site does is make casual and automated downloading hard, limit damage, and keep leaks traceable. Only paid DRM (Widevine/FairPlay, e.g. via a video platform) goes further.

## What is in place

### Accounts
- Passwords: PBKDF2-SHA256, salted, 100,000 iterations. Google sign-in is invite-only and checks the token's signature, issuer, audience, expiry and verified email.
- **Login throttling:** 8 failed password attempts per email+IP, and 40 failures per IP, lock sign-in for 15 minutes (stored in D1, so it holds across all Worker instances). Google sign-in failures count per IP.
- **Sessions:** HMAC-signed `HttpOnly; Secure; SameSite=Strict` cookie, 7 days. Each session carries a version number; **resetting a password or changing a role signs that user out everywhere**. Deleting a user ends their session immediately.
- **CSRF:** `SameSite=Strict`, plus the Worker rejects any state-changing request whose `Origin`/`Sec-Fetch-Site` is not this site.
- No self-signup; only admins create users. The Owner (from Cloudflare secrets) cannot be deleted or demoted in the app.

### Headers
Served for the pages (`public/_headers`) and for every API response (Worker): `nosniff`, `X-Frame-Options: DENY` (and CSP `frame-ancestors 'none'`, so the site cannot be embedded), HSTS, referrer policy, a locked-down permissions policy, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (needed for the Google popup), `noindex`, and `no-store` on API responses.

A full Content-Security-Policy is shipped in **report-only** mode (it logs violations in the browser console but blocks nothing). After deploying, open the site, play a video, open a PDF and use Google sign-in; if the console shows no violations, change the header name in `public/_headers` from `Content-Security-Policy-Report-Only` to `Content-Security-Policy` to enforce it.

### Media (videos and PDFs)
- Every request needs the session cookie **and an enrolled course**: students only get media, notes and the course list for the courses an admin gave them (admins get all), checked on every request in the Worker.
- Every request needs the session cookie.
- **Browser-only gate:** the Worker requires `Sec-Fetch-Site: same-origin` and a media-type `Sec-Fetch-Dest`. Browsers send these automatically; `curl`, `wget`, `yt-dlp` and most download managers do not, and other websites cannot fake them. Opening a media URL in the address bar, an iframe or a new tab is refused. `Cross-Origin-Resource-Policy: same-origin` stops hotlinking.
- **Scrape limit:** a student can open at most 20 distinct lessons per hour (admins exempt; `MAX_LESSONS_PER_HOUR` to change). Grabbing a whole course in one go gets `429`.
- **Slow-down (against extensions such as FetchV, and download managers):**
  - Video files (`mp4 webm mkv mov avi m4v`) are served only to *range* requests, which is how every browser plays video. A plain "download this URL" request is refused.
  - Each answer is at most 4 MB, so a whole file needs hundreds of requests.
  - Each student's total media speed is capped at `MAX_MBPS` (default 12 Mbit/s, with a 20-second burst for buffering and seeking). Requests above the cap are delayed, not rejected, so playback stays smooth while bulk downloading is slow (a 1 GB file takes about 12 minutes instead of seconds). Admins are exempt. The cap is per Worker instance, so it is best effort.
  - Raise `MAX_MBPS` if a high-bitrate video buffers; lower it to slow downloads further.
- Player: native download, remote playback and Picture-in-Picture are off, right-click is off, and the student's email floats over the video.
- PDF viewer: print, download and open buttons are removed, `supportsDownloading` is `false`, `Ctrl/Cmd+S` and `+P` are blocked, drag-and-drop open is off and the context menu is off. Download must stay disabled.
- PDF notes are private: every `/api/notes` query is scoped to the signed-in user and the course is checked; notes are capped at about 1.5 MB per PDF.
- Printing or "Save as PDF" of the web page itself produces a blank page.

## Browser extensions (FetchV, Video DownloadHelper, etc.)
These run *inside* the student's browser. They watch the same requests the player makes, with the same cookie, and many replay them from the page, so the server cannot tell them from the real player. They also save the raw file, **without the on-screen email watermark**. The slow-down above makes them take much longer, but nothing short of DRM stops them.

## Known gaps (what a determined student can still do)
1. Copy the cookie and the `Sec-Fetch-*` headers into a script or `yt-dlp` and download. The browser gate raises the effort; it is not a lock.
2. Plain MP4/WebM files are a single downloadable object once a script passes the gate. HLS (`tools/make-hls.sh`) splits them into segments, which is more work to reassemble (`yt-dlp` still can). Encrypting HLS segments with AES-128 helps little, because the key must be given to the legitimate player too.
3. Screen recording and phone cameras cannot be stopped. The email watermark makes leaks traceable, but it is not visible in the browser's native fullscreen, and PDFs have no watermark.
4. The scrape limit and `Sec-Fetch` gate are best effort; the per-lesson counter lives in each Worker instance's memory.
5. Sessions last 7 days and there is no "sign out everywhere" button (a password reset does it).
6. A shared password or Google account can be used by two people; there is no device limit.

## Recommended next steps (highest value first)
0. For real protection against extensions, use a DRM video host (Bunny Stream, Mux, Vimeo, VdoCipher). A burned-in per-student watermark makes leaks traceable.
1. Enforce the CSP after checking the console (see above).
2. **Cloudflare dashboard:** turn on Bot Fight Mode, add a WAF rate-limiting rule for `/api/login*` and `/api/media/*`, and require HTTPS (Always Use HTTPS). Put the site on your own domain and enable "Security Level: Medium".
3. Serve video as HLS only and remove MP4s from the bucket (stops a single-file download).
4. Per-user burned-in watermarking, or a DRM/video service, if leaks become a real problem.
5. Add a "sign out everywhere" action and a one-active-session option for shared-account abuse.
6. Add tests for the Worker (login throttle, media gate, admin permissions).

## Environment options
| Name | Purpose |
| --- | --- |
| `MAX_LESSONS_PER_HOUR` | Distinct lessons per student per hour (default 20) |
| `MAX_MBPS` | Per-student media speed cap in Mbit/s (default 12). Raise it if high-bitrate videos buffer |
| `RELAX_FETCH_METADATA=1` | Turns off the `Sec-Fetch` check if a very old browser cannot play media |
