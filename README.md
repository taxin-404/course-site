# Course Site

A private video and PDF course on Cloudflare. Students log in and stream lessons; the course layout is read straight from your R2 bucket's folders. Videos are HLS-only and never exposed as downloadable files.

**Stack:** Angular 21 (standalone components, signals) frontend, Cloudflare Worker API, R2 (videos, PDFs), D1 (users, progress). hls.js and pdf.js are bundled and load only when a lesson needs them.

## Project structure

```
course-site/
  wrangler.toml        Worker config; serves the built Angular app from dist/web/browser
  package.json         Angular + wrangler; `npm run deploy` builds then deploys
  worker/index.js      API, auth, streaming (the Worker)
  src/app/             Angular app
    api.ts               API client and app state (signals)
    app.ts               shell: header, sign out, "Add student" dialog
    login.ts             sign-in form
    course.ts            lesson list with progress, lesson view
    player.ts            HLS video player with watermark
    pdf-viewer.ts        PDF reader with watermark
  tools/make-hls.sh    converts videos to HLS and copies PDFs
  docs/HANDOFF.md      how and why it was built, limits, and an optimization backlog
```

## How the bucket maps to the site

```
course-videos/
  01 Basics/
    01 Intro/index.m3u8 + seg_0000.ts ...   -> video lesson "01 Intro" in section "01 Basics"
    Notes.pdf                               -> "Notes (PDF)" in section "01 Basics"
  02 Advanced/
    01 Deep dive/index.m3u8 + ...
```

Folder = section, a folder containing `index.m3u8` = video lesson, a `.pdf` = PDF lesson. Names sort naturally, so prefix with `01`, `02`. New uploads appear within about a minute.

## Prepare and upload

```bash
# videos/<Section>/<Lesson>.mp4 (and any .pdf) -> hls/<Section>/<Lesson>/index.m3u8 (+ PDFs copied)
./tools/make-hls.sh videos hls
rclone copy ./hls r2:course-videos --progress
```

Set up the `r2` remote once with `rclone config` (S3, provider Cloudflare, endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, R2 API token). The converter needs `ffmpeg`.

## Deploy (Git auto-deploy)

1. Push this project to GitHub/GitLab with `wrangler.toml` at the repo root. Commit `package-lock.json`.
2. Cloudflare dashboard, Workers & Pages: create a Worker from the repo. Set the **Deploy command** to `npm run deploy` (it runs the Angular build, then `wrangler deploy`). The Worker name must be `course-site`.
3. If the build complains about the Node version, add a build variable `NODE_VERSION` set to `22` (Angular 21 needs Node 20.19+ or 22.12+).
4. After the first deploy, add Secrets under Settings, Variables and Secrets: `SESSION_SECRET` and `SETUP_KEY` (random, 32+ characters).
5. Create the admin (works once, while no users exist):
   ```bash
   curl -X POST https://YOUR-WORKER.workers.dev/api/setup \
     -H "x-setup-key: YOUR_SETUP_KEY" -H "content-type: application/json" \
     -d '{"email":"you@example.com","password":"a-strong-password"}'
   ```
6. Log in and use **Add student** to create accounts.

The D1 database and R2 bucket are created automatically on first deploy; tables are created on first request.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # local secrets
npm run build                      # once: the Worker needs dist/ to exist
npm run api                        # terminal 1: Worker on :8787 (local D1 + R2)
npm start                          # terminal 2: Angular on :4200, proxies /api to :8787
```

Create the first admin with the `/api/setup` request against `http://localhost:8787`. To test with local files:
`npx wrangler r2 object put "course-videos/01 Basics/Notes.pdf" --file ./Notes.pdf --local`

## Download protection (what it does and doesn't do)

- HLS only: no single video file exists, so there is no "Save video as" and download managers find nothing. MP4s in the bucket are ignored unless you set the variable `ALLOW_MP4=1`.
- Every playlist, segment, and PDF needs a logged-in session cookie. Opening a media URL directly in the address bar is refused.
- Native download, Picture-in-Picture, casting, and right-click are disabled in the video player.
- The student's email is shown as a moving watermark on video (including full screen) and tiled on every PDF page, so leaked recordings can be traced.
- PDFs are drawn onto canvases by pdf.js, so there is no browser PDF toolbar and no text to copy. The raw PDF still travels to a logged-in browser, so a technical student could fetch it with their own cookie. Treat PDF protection as a deterrent, not a lock.
- Not possible: stopping screen recording, or a technical student using a tool such as yt-dlp with their own session cookie. Only paid DRM services come close.

## Costs

About $0.015/GB-month on R2 with free egress (60 GB is roughly $0.75-$1/month). Workers and D1 free tiers cover a small cohort.

## API

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `POST /api/setup` | setup key | Create first admin |
| `POST /api/login`, `/api/logout` | public | Session |
| `GET /api/me` | student | Current user |
| `GET /api/course` | student | Sections, lessons, progress (from the bucket) |
| `GET /api/media/<key>` | student | Playlist, segment, or PDF |
| `POST /api/progress` | student | Mark lesson done/undone |
| `POST /api/admin/users` | admin | Add a student |
