# Changelog

## Unreleased
### Added (courses, notes, theme)
- Multi-course access: `enrollments` table, `GET /api/admin/courses`, `POST /api/admin/users/<id>/courses`, `courses` on add/bulk add, course checkboxes in the Admin panel. Existing students keep every current course on first deploy.
- Worker checks the course on `/api/course`, `/api/media/*` and `/api/notes/*`.
- Course cards home screen and a sidebar folder tree (open/close, done counts, search, remembers open folders, expands to the current lesson).
- Private PDF notes: `pdf_notes` table, `GET/PUT/DELETE /api/notes/<key>`, auto-save, Hide my notes, Reset to original, full-window mode, all viewer tools except download and print.
- Color palette (`#202734`, `#36415A`, `#B7D894`, `#E0F8C7`) for dark mode, with a derived light mode.

### Security (courses and notes)
- Download is locked off in the PDF viewer (`supportsDownloading=false`, buttons hidden, Ctrl/Cmd+S and +P blocked).
- Notes are scoped to the signed-in user in every query.

### Added (earlier)
- Admin panel (`src/app/admin.ts`): list users, add user (optionally admin), reset password, grant/remove admin, delete user.
- Admin endpoints: `GET/POST /api/admin/users`, `POST /api/admin/users/<id>/password|role`, `DELETE /api/admin/users/<id>`.
- First admin (Owner) seeded from Cloudflare secrets `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
- Logo in *Curse of the Zombie* (bundled font, capitals only).
- Email and password validation on the server.
- Optional invite-only Google sign-in: `GET /api/config`, `POST /api/login/google`, `google_sub` column (auto-migrated), "Continue with Google" button, admin "Google only" users and a Google badge. Enabled by the `GOOGLE_CLIENT_ID` variable.
- Bulk user import in the Admin panel (paste or file; Google-only or generated passwords with CSV download) and `POST /api/admin/users/bulk`.
- `docs/PLAN-google-login.md`.

### Security
- Login lockout (8 failures per email+IP, 40 per IP, 15 min) stored in D1.
- Session versioning: password reset or role change signs the user out everywhere.
- CSRF origin check, security headers on API and pages, report-only CSP (`public/_headers`).
- Media gate: requires browser `Sec-Fetch-*` headers (blocks curl/yt-dlp/download managers and hotlinking); cap of 20 distinct lessons per student per hour; `Cross-Origin-Resource-Policy`.
- Slow-down for bulk downloading: video needs Range requests, 4 MB answers, per-student speed cap (`MAX_MBPS`, default 12 Mbit/s).
- Page printing disabled; `/api/me` no longer returns internal fields.
- New `docs/SECURITY.md`.

### Changed
- Full UI redesign (tokens, light/dark, cards, gradients) and a dedicated phone layout.
- "Mark as complete" updates instantly (optimistic), shows "✓ Completed", and Back returns to the same folder.
- PDF viewer fills the lesson area.
- Video uses the browser's native controls and fullscreen again.
- README and HANDOFF rewritten to match the code (course/folder structure, MP4 handling, API, limits).

### Removed
- `POST /api/setup` and the `SETUP_KEY` secret.
- The "Add student" dialog.
- The old `ALLOW_MP4` mention (the option no longer exists in the Worker).
