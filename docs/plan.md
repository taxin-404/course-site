# Plan: Google login

Status: planned, not implemented. Part of the backlog in `docs/HANDOFF.md` (section 6).

The Worker, `Api` service and admin panel referenced below are described in `README.md` and `docs/HANDOFF.md`.

## Goal
Let students sign in with "Continue with Google" as well as email + password, without opening the site to the public.

## Decisions to keep
- **Invite-only.** Google login only works for emails an admin has already added in the Admin panel. No self-signup. An unknown Google account gets "This account has not been invited".
- **Same session cookie.** After Google verifies the user, the Worker issues the normal `s=` cookie. Nothing else in the app changes.
- **Password login stays**, so the owner account (from `ADMIN_EMAIL`/`ADMIN_PASSWORD`) can always get in.
- **Google Identity Services (ID token) flow**, not the full OAuth redirect. The browser gets a signed ID token from Google, the Worker verifies it. No client secret, no callback URL, no token storage.

## 1. Google Cloud setup (one time, manual)
1. console.cloud.google.com: create a project, then APIs & Services, OAuth consent screen (External; app name, support email; publish to Production so non-test users can sign in. Only basic scopes are used, so no review is needed).
2. Credentials, Create OAuth client ID, type **Web application**.
3. Authorized JavaScript origins: `https://course-site.taxin.workers.dev`, your custom domain if any, and `http://localhost:4200` for dev. Redirect URIs are not needed for this flow.
4. Copy the **Client ID**. It is public, not a secret.
5. Cloudflare: add `GOOGLE_CLIENT_ID` as a variable (also in `.dev.vars`, and `.dev.vars.example`).

## 2. Database
`users` today: `id, email UNIQUE, pass NOT NULL, is_admin`.
- Add `google_sub TEXT` (Google's stable user id) with a unique index.
- `pass` is NOT NULL, so Google-only users store a random unusable hash (generate 32 random bytes, hash it, never reveal it). That avoids rebuilding the table.
- `ensureSchema` only runs `CREATE TABLE IF NOT EXISTS`, so add a small migration step: `ALTER TABLE users ADD COLUMN google_sub TEXT` inside try/catch (ignore "duplicate column"), then `CREATE UNIQUE INDEX IF NOT EXISTS users_sub ON users(google_sub)`.

## 3. Worker (`worker/index.js`)
New endpoint `POST /api/login/google` with body `{ credential }`:
1. Fetch Google's public keys from `https://www.googleapis.com/oauth2/v3/certs` (JWKS). Cache in module memory for about an hour, honoring `Cache-Control`.
2. Split the JWT, read the header `kid`, import the matching RSA key with Web Crypto (`RSASSA-PKCS1-v1_5`, SHA-256), and verify the signature.
3. Check claims: `iss` is `https://accounts.google.com` or `accounts.google.com`; `aud` equals `env.GOOGLE_CLIENT_ID`; `exp` is in the future; `email_verified` is true.
4. Look up the user:
   - by `google_sub` first (returning user);
   - otherwise by lowercased `email`; if found, save `google_sub` on that row (first login links the account);
   - otherwise return 403 "not invited".
5. If the row already has a *different* `google_sub`, reject. This stops a recycled email address from taking over an account.
6. Issue the normal session cookie.
Extras: reuse one error message for all failures, and add rate limiting (see the handoff backlog).

Admin endpoint change: `POST /api/admin/users` accepts a missing `password` when `google_only: true`, and creates the user with the unusable hash.

## 4. Frontend
- `index.html` or lazily from `login.ts`: load `https://accounts.google.com/gsi/client` (async, defer).
- `login.ts`: call `google.accounts.id.initialize({ client_id, callback })` and `renderButton` into a div under the form, with an "or" divider. The callback sends `credential` to `api.loginGoogle()`.
- `api.ts`: add `loginGoogle(credential)` (POST `login/google`, then `init()`), and expose `GOOGLE_CLIENT_ID` through a new `GET /api/config` (public) so it is not hard-coded in the bundle.
- `admin.ts`: in "Add user", make the password optional with a "Google sign-in only" checkbox. Show a "Google" badge on users who have linked.
- Styling: match the existing inputs (full-width, 46px high on phones); let Google render its own button (it handles dark/light theme options).

## 5. Security notes
- Verify `aud` strictly. A token minted for another app must not work here.
- Match on `google_sub` once linked; email alone is only used for the first link.
- Keep `email_verified` required.
- Cookie stays `HttpOnly; Secure; SameSite=Strict`. The token is POSTed with `fetch` from the same origin, so no CSRF change is needed.
- Optional: send a `nonce` from the Worker and check it in the token.
- Disabling/deleting a user in the Admin panel already ends their sessions (the user row is re-read each request).

## 6. Rollout
1. Google Cloud client and `GOOGLE_CLIENT_ID` variable.
2. Migration + `/api/login/google` + `/api/config` (deploy; password login keeps working).
3. Login button and admin tweaks.
4. Test (below), then announce to students.

## 7. Test checklist
- Invited Gmail signs in; second sign-in uses the `google_sub` path.
- Uninvited Gmail is rejected with the "not invited" message.
- Token with wrong `aud`, expired token, tampered signature, and `email_verified:false` are all rejected.
- Same email, different Google account (different `sub`) is rejected after linking.
- Password login still works for the owner and students.
- Admin can add a Google-only user; deleting the user blocks the next request.
- Works on phone widths and in Safari/Firefox (GIS popup not blocked).

## 8. Open questions
- Should students be allowed to log in with either method, or should Google-only users have password login disabled? (Plan assumes either.)
- Custom domain? If yes, add it to the authorized origins before launch.
- Do you want an "unlink Google" action in the Admin panel?

## Effort
About half a day: ~120 lines in the Worker, ~40 in the Angular app, plus the Google Cloud setup.
