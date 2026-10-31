# Course Site

A private video and PDF course site on Cloudflare. Students sign in and watch lessons; the course layout is read straight from your R2 bucket's folders. Admins manage users from an in-app Admin panel.

**Stack:** Angular 21 (standalone components, signals), Cloudflare Worker API, R2 (videos, PDFs), D1 (users, progress, course access, private PDF notes). `hls.js` and `ngx-extended-pdf-viewer` load only when a lesson needs them.

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
      course.ts          Course cards (home), outline sidebar (folder tree + search), folder browser, lesson view, Mark as complete
      player.ts          Video player with moving email watermark
      pdf-viewer.ts      PDF reader with private notes, hide/reset and full-window mode (download and print stay off)
      admin.ts           Admin panel: list/add/reset password/promote/delete users, give courses
  tools/make-hls.sh      Optional: converts videos to HLS and copies PDFs
  docs/HANDOFF.md        How it was built, what is verified, limits, backlog
  docs/PLAN-google-login.md   Google sign-in plan (implemented)
  docs/SECURITY.md       Security model, download protection, gaps, next steps
  public/_headers        Security headers for the static pages
```

## How the bucket maps to the site

Bucket name: `course-sourse` (the spelling is in `wrangler.toml`; keep it unless you also change the binding).

```
<Course>/<file>                     lesson directly in a course
<Course>/<Folder>/<file>            lesson inside a folder
<Course>/<Folder>/<Sub>/<file>      nested folders
```

- Top-level folder = **course** (shown as a card on the home screen; inside a course the sidebar is its folder outline).
- Sub-folders = folders in the file browser (breadcrumb: `./Courses / Course / Folder /`).
- Files = **lessons**. Video: `.mp4 .webm .mkv .mov .avi .m4v .m3u8`. Documents: `.pdf`. HLS segments (`.ts`) are hidden from the list.
- For an HLS lesson, the title is its parent folder name (`<Lesson>/index.m3u8`).
- Names sort naturally, so prefix with `01`, `02`. New uploads appear within about a minute (the listing is cached 60 s per Worker instance).
- Progress is stored by object key, so renaming a file or folder resets that lesson's progress.

## Accounts and the Admin panel

- **The Owner comes from the Cloudflare secret `ADMIN_EMAIL`.** The Worker creates that account on the first request (as an admin) and always keeps it an admin, so that address can sign in with **Google** straight away — the first Google login links the account by matching the verified email. It cannot be deleted or demoted in the panel.
- `ADMIN_PASSWORD` is optional and takes effect whenever it changes: set it and the Owner can also sign in with email + password; remove the secret and the stored password is replaced by an unusable marker, so only Google works. Because of that, the Owner's password cannot be changed from the Admin panel (no other admin can reset it and sign in as the Owner) — change the secret instead.
- Admins see an **Admin panel** button in the header. In the panel they can add a user (optionally as admin), reset any password, grant or remove admin, and delete a user (their progress is removed too). Admins cannot delete or demote themselves.
- Passwords must be 8+ characters; emails are validated and stored lowercase.
- There is no self-signup. Users must be added by an admin first.
- **Google sign-in (optional, invite-only):** set the variable `GOOGLE_CLIENT_ID` and the login page shows "Continue with Google". It only works for emails an admin already added; the first Google login links that account to the Google user ID. Admins can add a user as **Google only** (no password).
- **Many users at once:** in the Admin panel, *Add many users* takes a pasted list or a `.csv`/`.txt` file of emails. *Google sign-in only* (default) adds hundreds instantly with no passwords; otherwise each user gets a generated password, shown once with Copy and Download CSV. Existing and invalid emails are skipped and reported. Setup steps: `docs/PLAN-google-login.md` section 1.

## Courses and access

- A student sees only the courses an admin gave them; admins see all. The Worker checks the course (the first folder of the key) on `/api/course`, `/api/media/*` and `/api/notes/*`, so a copied file address for another course returns `403`.
- Admin panel: tick **Courses for new users** before adding one or many users, or use the **Courses** button on a student's row to change it later.
- On the first request after this feature is deployed, every existing student is given every current course, so nobody loses access. After that, access is exactly what the admin sets.
- Payment is manual for now: the student pays you (for example bKash or Nagad), then you give the course in the Admin panel.
- Access is tied to the **folder name**. Renaming a course folder in R2 removes access to it (and resets progress).
- Home screen: course cards with progress (a student with one course goes straight in). Inside a course the sidebar shows the folder tree: folders open and close at any depth, show done/total, expand to the open lesson, remember what was open, and a search box filters lessons.

## PDF notes

- In the PDF viewer students can highlight, write text, draw, add stamps/images, erase and undo. Notes are **private to each student**, saved automatically to their account (D1 table `pdf_notes`, one row per student and PDF) and reloaded on any device.
- **Hide my notes** shows the clean original and keeps the notes; **Reset to original** deletes them after a confirmation. The PDF in R2 is never changed.
- **Full window** fills the browser window (not the whole screen) with the toolbar inside; `Esc` exits.
- Limit: about 1.5 MB of notes per PDF (large stamp images can hit it).
- **Download stays off, always:** download/save buttons are removed, `supportsDownloading` is `false`, `Ctrl/Cmd+S` and `Ctrl/Cmd+P` are blocked, and print and open-file are off. Do not enable them.

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
4. After the first deploy, add Secrets under Settings, Variables and Secrets: `SESSION_SECRET` (random, 32+ characters) and `ADMIN_EMAIL` (the Owner, e.g. your Gmail). `ADMIN_PASSWORD` is optional — add it only if the Owner should also be able to sign in with a password. Set `GOOGLE_CLIENT_ID` for Google sign-in. Redeploy so the Worker sees them.
5. Open the site and sign in as the Owner with **Continue with Google** (or `ADMIN_EMAIL` / `ADMIN_PASSWORD` if you set the password), then use **Admin panel** to add students.

The D1 database and R2 bucket are created automatically on first deploy; tables are created on the first request.

If the site shows an old version after a push, check the **Builds** tab: a failed build leaves the previous version live.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # set SESSION_SECRET, ADMIN_EMAIL (ADMIN_PASSWORD optional)
npm run build                      # once: the Worker needs dist/ to exist
npm run api                        # terminal 1: Worker on :8787 (local D1 + R2)
npm start                          # terminal 2: Angular on :4200, proxies /api to :8787
```

Seed local R2 for testing:
`npx wrangler r2 object put "course-sourse/Demo/Notes.pdf" --file ./Notes.pdf --local`

## Look and feel

- Light and dark follow the system setting. Colors, radii and shadows are tokens at the top of `src/styles.css`.
- The logo uses *Curse of the Zombie*, which only has capital letters, so the CSS uppercases it.
- Colors follow a four-color palette (`#202734`, `#36415A`, `#B7D894`, `#E0F8C7`) in dark mode; light mode is derived from it.
- Phones (≤760 px): the course outline is a scrollable box (up to 38% of the screen) above the lesson, the lesson bar stacks with a full-width "Mark as complete", the video runs edge to edge, and the Admin panel stacks into one column.
- Video uses the browser's native controls, including fullscreen.

## Security and download protection

See **`docs/SECURITY.md`** for the full list, known gaps and next steps. Summary:

- Login throttling (15-minute lockout), signed sessions that are revoked on password reset, CSRF and security headers, a report-only CSP.
- Media is browser-only (`Sec-Fetch-*` check blocks curl/yt-dlp/download managers), same-origin only, and capped at 20 distinct lessons per student per hour.
- Video downloads are slowed: range-only, 4 MB chunks, per-student speed cap (`MAX_MBPS`). Browser extensions like FetchV can still save a video, only slowly; only DRM stops them.
- Printing the page gives a blank sheet.

### Details (older notes)

- Every playlist, segment, video and PDF needs a logged-in session cookie. Opening a media URL directly in the address bar is refused (`Sec-Fetch-Dest: document`).
- The player disables native download, remote playback, Picture-in-Picture and right-click. The student's email floats over the video as a watermark.
- **Plain MP4/WebM/MKV files in the bucket are served as well** (there is no `ALLOW_MP4` switch any more). A signed-in technical student can fetch those with their own cookie. Use HLS (`tools/make-hls.sh`) if you want to avoid a single downloadable file.
- The watermark is not shown in the browser's native fullscreen, because only the `<video>` element goes fullscreen.
- PDFs open in a viewer with print and download buttons removed, but the raw PDF still reaches a logged-in browser. Treat this as a deterrent, not a lock.
- Not possible: stopping screen recording, or a student using a tool such as `yt-dlp` with their own session cookie. Only paid DRM comes close.

## Costs

R2 includes 10 GB-month free; beyond that it is $0.015/GB-month (about $0.30 per month for 30 GB). Downloads are free. **If a payment fails, R2 can be suspended** (the site then cannot serve videos or PDFs) and data may be deleted after 30 days without a valid payment method; keep a second card, a budget alert and your own backup of the originals.

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
| `GET/PUT/DELETE /api/notes/<url-encoded pdf key>` | signed in | The student's own notes for one PDF (`PUT {data: []}`); `403` for a course they do not have |
| `GET /api/admin/courses` | admin | Course names found in the bucket |
| `POST /api/admin/users/<id>/courses` | admin | `{courses: []}` replaces the student's courses |
| `GET /api/admin/users` | admin | List users with role and lessons done |
| `POST /api/admin/users` | admin | Add a user `{email, password, is_admin?, google_only?, courses?}` |
| `POST /api/admin/users/bulk` | admin | `{emails[], google_only?, is_admin?, courses?}`; up to 500 emails Google-only, or 20 with generated passwords per request; returns `{added, skipped}` |
| `POST /api/admin/users/<id>/password` | admin | Reset password `{password}` |
| `POST /api/admin/users/<id>/role` | admin | `{is_admin}`; not for the Owner or yourself |
| `DELETE /api/admin/users/<id>` | admin | Delete user and progress; not the Owner or yourself |

## License

MIT for the code (see `LICENSE`). The font *Curse of the Zombie* is **free for personal use only**; get a commercial license from its author before using it on a commercial site, or replace it in `src/styles.css`.
