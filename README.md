# Course Site

A private video and PDF course site on Cloudflare. Students sign in and watch lessons; the course layout is read straight from your R2 bucket's folders. Admins manage users from an in-app Admin panel.

**Stack:** Angular 21 (standalone components, signals), Cloudflare Worker API, R2 (videos, PDFs), D1 (users, progress). `hls.js` and `ngx-extended-pdf-viewer` load only when a lesson needs them.

## Project structure

```
course-site/
  wrangler.toml          Worker config; serves the built Angular app from dist/web/browser
  package.json           Angular + wrangler; `npm run deploy` builds then deploys
  worker/index.js        API, auth, admin, course listing, media streaming (the Worker)
  src/
    styles.css           All styling: tokens, light/dark, desktop + phone layouts
    curse-of-the-zombie.ttf   Logo font (bundled by the build; see License note)
    app/
      api.ts             API client and app state (signals)
      app.ts             Shell: header (logo, Admin panel toggle, Sign out)
      login.ts           Sign-in form + Google button
      course.ts          Course sidebar, folder browser, lesson view, Mark as complete
      player.ts          Video player with moving email watermark
      pdf-viewer.ts      PDF reader (ngx-extended-pdf-viewer, toolbar trimmed)
      admin.ts           Admin panel: list/add/reset password/promote/delete users
  tools/make-hls.sh      Optional: converts videos to HLS and copies PDFs
  docs/HANDOFF.md        How it was built, what is verified, limits, backlog
  docs/PLAN-google-login.md   Plan for the next feature (not built yet)
```

## How the bucket maps to the site

Bucket name: `course-sourse` (the spelling is in `wrangler.toml`; keep it unless you also change the binding).

```
<Course>/<file>                     lesson directly in a course
<Course>/<Folder>/<file>            lesson inside a folder
<Course>/<Folder>/<Sub>/<file>      nested folders
```

- Top-level folder = **course** (shown in the sidebar).
- Sub-folders = folders in the file browser (breadcrumb: `./Courses / Course / Folder /`).
- Files = **lessons**. Video: `.mp4 .webm .mkv .mov .avi .m4v .m3u8`. Documents: `.pdf`. HLS segments (`.ts`) are hidden from the list.
- For an HLS lesson, the title is its parent folder name (`<Lesson>/index.m3u8`).
- Names sort naturally, so prefix with `01`, `02`. New uploads appear within about a minute (the listing is cached 60 s per Worker instance).
- Progress is stored by object key, so renaming a file or folder resets that lesson's progress.

## Accounts and the Admin panel

- **The first admin comes from Cloudflare secrets** `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The Worker creates it on the first request and always keeps it an admin. It is the **Owner**: it cannot be deleted or demoted in the panel. Changing `ADMIN_PASSWORD` later does *not* overwrite the stored password; use **Reset password** in the panel.
- Admins see an **Admin panel** button in the header. In the panel they can add a user (optionally as admin), reset any password, grant or remove admin, and delete a user (their progress is removed too). Admins cannot delete or demote themselves.
- Passwords must be 8+ characters; emails are validated and stored lowercase.
- There is no self-signup. Users must be added by an admin first.
- **Google sign-in (optional, invite-only):** set the variable `GOOGLE_CLIENT_ID` and the login page shows "Continue with Google". It only works for emails an admin already added; the first Google login links that account to the Google user ID. Admins can add a user as **Google only** (no password).
- **Many users at once:** in the Admin panel, *Add many users* takes a pasted list or a `.csv`/`.txt` file of emails. *Google sign-in only* (default) adds hundreds instantly with no passwords; otherwise each user gets a generated password, shown once with Copy and Download CSV. Existing and invalid emails are skipped and reported. Setup steps: `docs/PLAN-google-login.md` section 1.

## Prepare and upload content

Upload with `rclone` (not through git; the dashboard and Wrangler stop at 300 MB per file).

```bash
rclone config update r2 \
  access_key_id=<R2_ACCESS_KEY_ID> secret_access_key=<R2_SECRET_ACCESS_KEY> \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com provider=Cloudflare no_check_bucket=true

rclone copy "/path/to/Course Name" "r2:course-sourse/Course Name" --progress
```

Option A, plain MP4 (simple): make it stream-friendly first, because screen recordings usually keep the `moov` metadata at the end and the browser cannot start until the whole file downloads.

```bash
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4   # no re-encode, ~30 s
```

Option B, HLS (harder to save as a single file): `./tools/make-hls.sh videos hls` turns `videos/<Folder>/<Lesson>.mp4` into `hls/<Folder>/<Lesson>/index.m3u8` plus segments, and copies PDFs. Needs `ffmpeg`.

## Deploy (Git auto-deploy)

1. Push this project to GitHub/GitLab with `wrangler.toml` at the repo root. Commit `package-lock.json`.
2. Cloudflare dashboard, Workers & Pages: create a Worker from the repo. Set the **Deploy command** to `npm run deploy` (Angular build, then `wrangler deploy`). The Worker name must be `course-site`.
3. If the build complains about Node, add a build variable `NODE_VERSION` = `22` (Angular 21 needs Node 20.19+ or 22.12+).
4. After the first deploy, add Secrets under Settings, Variables and Secrets: `SESSION_SECRET` (random, 32+ characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Optional: variable `GOOGLE_CLIENT_ID` for Google sign-in. Redeploy so the Worker sees them.
5. Open the site and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, then use **Admin panel** to add students.

The D1 database and R2 bucket are created automatically on first deploy; tables are created on the first request.

If the site shows an old version after a push, check the **Builds** tab: a failed build leaves the previous version live.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # set SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm run build                      # once: the Worker needs dist/ to exist
npm run api                        # terminal 1: Worker on :8787 (local D1 + R2)
npm start                          # terminal 2: Angular on :4200, proxies /api to :8787
```

Seed local R2 for testing:
`npx wrangler r2 object put "course-sourse/Demo/Notes.pdf" --file ./Notes.pdf --local`

## Look and feel

- Light and dark follow the system setting. Colors, radii and shadows are tokens at the top of `src/styles.css`.
- The logo uses *Curse of the Zombie*, which only has capital letters, so the CSS uppercases it.
- Phones (≤760 px): the sidebar becomes a swipeable row of course cards, the lesson bar stacks with a full-width "Mark as complete", the video runs edge to edge, and the Admin panel stacks into one column.
- Video uses the browser's native controls, including fullscreen.

## Download protection (what it does and doesn't do)

- Every playlist, segment, video and PDF needs a logged-in session cookie. Opening a media URL directly in the address bar is refused (`Sec-Fetch-Dest: document`).
- The player disables native download, remote playback, Picture-in-Picture and right-click. The student's email floats over the video as a watermark.
- **Plain MP4/WebM/MKV files in the bucket are served as well** (there is no `ALLOW_MP4` switch any more). A signed-in technical student can fetch those with their own cookie. Use HLS (`tools/make-hls.sh`) if you want to avoid a single downloadable file.
- The watermark is not shown in the browser's native fullscreen, because only the `<video>` element goes fullscreen.
- PDFs open in a viewer with print and download buttons removed, but the raw PDF still reaches a logged-in browser. Treat this as a deterrent, not a lock.
- Not possible: stopping screen recording, or a student using a tool such as `yt-dlp` with their own session cookie. Only paid DRM comes close.

## Costs

About $0.015/GB-month on R2 with free egress (60 GB is roughly $0.75-$1/month). Workers and D1 free tiers cover a small cohort.

## API

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `POST /api/login`, `/api/logout` | public | Session cookie |
| `GET /api/config` | public | `{googleClientId}` (empty when not configured) |
| `POST /api/login/google` | public | `{credential}` Google ID token; invite-only |
| `GET /api/me` | signed in | Current user (`id, email, is_admin`) |
| `GET /api/course` | signed in | `[{title, sections:[{title, lessons:[{id,title,kind,done}]}]}]` from the bucket |
| `GET /api/media/<key>` | signed in | Playlist, segment, video or PDF (range requests supported) |
| `POST /api/progress` | signed in | `{lesson, done}` |
| `GET /api/admin/users` | admin | List users with role and lessons done |
| `POST /api/admin/users` | admin | Add a user `{email, password, is_admin?, google_only?}` |
| `POST /api/admin/users/bulk` | admin | `{emails[], google_only?, is_admin?}`; up to 500 emails Google-only, or 20 with generated passwords per request; returns `{added, skipped}` |
| `POST /api/admin/users/<id>/password` | admin | Reset password `{password}` |
| `POST /api/admin/users/<id>/role` | admin | `{is_admin}`; not for the Owner or yourself |
| `DELETE /api/admin/users/<id>` | admin | Delete user and progress; not the Owner or yourself |

## License

MIT for the code (see `LICENSE`). The font *Curse of the Zombie* is **free for personal use only**; get a commercial license from its author before using it on a commercial site, or replace it in `src/styles.css`.
