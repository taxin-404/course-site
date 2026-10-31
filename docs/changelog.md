# Changelog

## Unreleased
### Added
- Admin panel (`src/app/admin.ts`): list users, add user (optionally admin), reset password, grant/remove admin, delete user.
- Admin endpoints: `GET/POST /api/admin/users`, `POST /api/admin/users/<id>/password|role`, `DELETE /api/admin/users/<id>`.
- First admin (Owner) seeded from Cloudflare secrets `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
- Logo in *Curse of the Zombie* (bundled font, capitals only).
- Email and password validation on the server.
- `docs/PLAN-google-login.md`.

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
