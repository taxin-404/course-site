# Course banners, resource editing, 3-up cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a per-course banner at the top of the home-screen course card, set by a `banner.<image>` file in the course folder; add an Edit dialog to lesson resources; make the course grid 3/2/1-up.

**Architecture:** A small worker module recognises the banner filename and picks one winner per course. `listCourse()` exposes the key; `/api/course` turns it into `/api/banner/<course>`, a new signed-in route that streams the image. The client renders it above the card body and drops the grid minimum to 340 px. Resource editing is one `PATCH` route plus a dialog in `lesson-resources.ts`.

**Tech Stack:** Angular 22 templates + the one global `src/styles.css`, Cloudflare Worker + D1 + R2, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-08-course-banners-resource-edit-design.md`

## Global Constraints

- Banner is exactly `<Course>/banner.jpg|jpeg|png|webp`, at the course root only, case-insensitive; when several exist the order is jpg, jpeg, png, webp.
- The banner appears **only** on the home-screen course card; the opened course page is unchanged.
- No schema change, no stored banner pointer, no banner upload dialog.
- `/api/banner/<course>` requires a signed-in user but **not** enrollment (locked-course cards still show their banner).
- Banner content types: `image/jpeg`, `image/png`, `image/webp` only. No SVG or GIF.
- Grid: `repeat(auto-fill, minmax(340px, 1fr))` in the existing 1240 px container; the `max-width:760px` single-column rule stays.
- Resource edit covers title, note and link URL. A PDF's title and note are editable; its file/`file_key` is not. Delete stays as it is.
- Plain text, sentence-case copy, existing CSS tokens, no new colours.
- Verification content is made on **dev** with throwaway test accounts. Never sign in as or modify the production owner.

## Review Focus

1. **A replaced or deleted banner lingers** because the course list is 60 s-cached — the home card must change immediately after the file-manager action. Live check in Task 7.
2. **A locked course's banner 403s** while its card is visible — an ungranted student must still see the image. Live check in Task 7.
3. **Two banner files (`.jpg` + `.png`) make the winner random** — one deterministic priority. Unit test in Task 1.
4. **A crafted PATCH on a PDF replaces its `file_key`/url** and the viewer breaks — the route must ignore `url` for PDFs. Live check in Task 7.
5. **A course name with a space, `&` or a percent sign breaks the banner URL** — `encodeURIComponent`/`decodeURIComponent` must round-trip. Live check in Task 7.

---

### Task 1: Banner key matcher

**Files:**
- Create: `worker/banners.js`
- Test: `worker/banners.test.mjs`

**Interfaces:**
- Produces: `bannerExt(key: string): 'jpg' | 'jpeg' | 'png' | 'webp' | null`
- Produces: `bannerKeys(keys: string[]): Map<string, string>` — course name → winning R2 key
- Produces: `BANNER_TYPES: { jpg: string; jpeg: string; png: string; webp: string }`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bannerExt, bannerKeys, BANNER_TYPES } from './banners.js';

test('accepts the four image extensions, case-insensitively', () => {
  assert.equal(bannerExt('Algebra/banner.jpg'), 'jpg');
  assert.equal(bannerExt('Algebra/banner.JPEG'), 'jpeg');
  assert.equal(bannerExt('Algebra/banner.png'), 'png');
  assert.equal(bannerExt('Algebra/banner.WebP'), 'webp');
  assert.equal(bannerExt('Algebra/Banner.PNG'), 'png');
});

test('only a course-root file named banner', () => {
  assert.equal(bannerExt('Algebra/Section/banner.jpg'), null);
  assert.equal(bannerExt('banner.jpg'), null);
  assert.equal(bannerExt('Algebra/banner.gif'), null);
  assert.equal(bannerExt('Algebra/banner.jpg.txt'), null);
  assert.equal(bannerExt('Algebra/my-banner.jpg'), null);
});

test('one winning key per course, jpg first', () => {
  const map = bannerKeys([
    'Algebra/banner.png',
    'Algebra/banner.jpg',
    'Geometry/banner.webp',
    'Geometry/lesson.mp4',
    'Algebra/Section/banner.png',
  ]);
  assert.equal(map.get('Algebra'), 'Algebra/banner.jpg');
  assert.equal(map.get('Geometry'), 'Geometry/banner.webp');
  assert.equal(map.size, 2);
});

test('exposes content types for the serving route', () => {
  assert.deepEqual(BANNER_TYPES, {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: `ERR_MODULE_NOT_FOUND` for `worker/banners.js`.

- [ ] **Step 3: Implement `worker/banners.js`**

```js
// Course banners are a named file at the course root; this module is the one
// place that decides what counts as one and which file wins when several exist.

const BANNER_EXTS = ['jpg', 'jpeg', 'png', 'webp'];

export const BANNER_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** The extension of a course banner key, or null. Only <course>/banner.<ext>. */
export function bannerExt(key) {
  if (typeof key !== 'string') return null;
  const m = /^[^/]+\/banner\.([a-z]+)$/i.exec(key);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return Object.hasOwn(BANNER_TYPES, ext) ? ext : null;
}

/** Picks one banner key per course; extensions earlier in BANNER_EXTS win. */
export function bannerKeys(keys) {
  const rank = new Map(BANNER_EXTS.map((ext, i) => [ext, i]));
  const out = new Map();
  for (const key of keys || []) {
    const ext = bannerExt(key);
    if (!ext) continue;
    const course = key.slice(0, key.indexOf('/'));
    const prev = out.get(course);
    if (!prev || rank.get(ext) < rank.get(bannerExt(prev))) out.set(course, key);
  }
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`
Expected: all suites pass; the four new tests are included.

- [ ] **Step 5: Commit**

```bash
git add worker/banners.js worker/banners.test.mjs
git commit -m "feat(banners): recognise course banner files"
```

---

### Task 2: Worker banner detection and serving route

**Files:**
- Modify: `worker/index.js:1-4` (imports)
- Modify: `worker/index.js:311-413` (`listCourse`)
- Modify: `worker/index.js:786-800` (`/api/course`)
- Modify: `worker/index.js:827` (new route, after `/api/order` and before `/api/media/`)

**Interfaces:**
- Consumes: `bannerKeys`, `BANNER_TYPES` from Task 1.
- Produces: every `listCourse()` course object gains `banner: string` — the R2 key, or `''`.
- Produces: every `/api/course` item gains `banner: string` — `/api/banner/<encoded course>`, or `''`.
- Produces: `GET /api/banner/<course>` → image bytes, or 404 JSON.

- [ ] **Step 1: Add the import**

At the top of `worker/index.js`, beside the other worker imports:

```js
import { BANNER_TYPES, bannerKeys } from './banners.js';
```

- [ ] **Step 2: Attach the banner key in `listCourse()`**

After the `keys` cursor loop and before the subtitle map:

```js
const banners = bannerKeys(keys);
```

Then change the returned course object at the end of `listCourse()`:

```js
return { title: courseName, description: descriptions.get(courseName) || '', banner: banners.get(courseName) || '', sections };
```

- [ ] **Step 3: Include the banner URL in `/api/course`**

In the `/api/course` map, beside `description`:

```js
banner: c.banner ? `/api/banner/${encodeURIComponent(c.title)}` : '',
```

- [ ] **Step 4: Add `GET /api/banner/<course>`**

Inside the signed-in block, between `/api/order` and `/api/media/`:

```js
if (path.startsWith('/api/banner/')) {
  const course = decodeURIComponent(path.slice('/api/banner/'.length));
  const c = (await listCourse(env)).find((x) => x.title === course);
  const ext = c && c.banner ? c.banner.split('.').pop().toLowerCase() : '';
  if (!ext || !BANNER_TYPES[ext]) return json({ error: 'Not found' }, 404);
  const obj = await env.RESOURCES.get(c.banner);
  if (!obj) return json({ error: 'Not found' }, 404);
  const h = new Headers();
  h.set('content-type', BANNER_TYPES[ext]);
  h.set('cache-control', 'private, no-store');
  h.set('x-content-type-options', 'nosniff');
  h.set('content-disposition', 'inline');
  h.set('cross-origin-resource-policy', 'same-origin');
  h.set('x-robots-tag', 'noindex');
  h.set('content-length', String(obj.size));
  return new Response(obj.body, { headers: h });
}
```

Deliberately no enrollment check: a locked course still shows its card and banner.
Deliberately `no-store`: replacing the image must not leave the old one in the browser.

- [ ] **Step 5: Verify syntax and tests**

Run: `node --input-type=module --check < worker/index.js`
Expected: no output.

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add worker/index.js
git commit -m "feat(banners): serve a course banner to signed-in users"
```

---

### Task 3: Course card type, markup, banner CSS and 3-up grid

**Files:**
- Modify: `src/app/api.ts:6` (`CourseData`)
- Modify: `src/app/course.ts:142-166` (home-screen card)
- Modify: `src/styles.css:154` (grid) and `src/styles.css:157-176` (card)

**Interfaces:**
- Consumes: `CourseData.banner?: string` from the `/api/course` response (Task 2).
- Produces: `.list.cards` grid 3/2/1; `.card-banner`; `.card-body`.

- [ ] **Step 1: Add the type**

```ts
export interface CourseData { title: string; description: string; banner?: string; locked?: boolean; sections: Section[] }
```

- [ ] **Step 2: Add the banner and body wrapper to the card**

In `course.ts`, the card becomes (existing children unchanged inside `.card-body`):

```html
<button class="course-card" [disabled]="c.locked" (click)="openCourse(c)">
  @if (c.banner) {
    <img class="card-banner" [src]="c.banner" alt="" loading="lazy" decoding="async" />
  }
  <span class="card-body">
    <span class="card-head">
      <span class="row-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" /></svg>
      </span>
      <span class="card-title">{{ c.title }}</span>
    </span>
    @if (c.description) { <span class="card-desc">{{ c.description }}</span> }
    <span class="card-foot">
      @if (courseTotal(c)) {
        <span class="course-bar" aria-hidden="true"><i [style.width.%]="coursePercent(c)"></i></span>
      }
      <span class="card-meta-row">
        <span class="row-meta">{{ courseDone(c) }}/{{ courseTotal(c) }} lessons</span>
        <span class="card-cta">{{ c.locked ? 'No access' : (courseDone(c) ? 'Continue' : 'Start') }}</span>
      </span>
    </span>
  </span>
</button>
```

- [ ] **Step 3: Update the CSS**

Line 154: change `minmax(460px,1fr)` to `minmax(340px,1fr)`.

Line 159: remove `gap:.8rem;` and `padding:1.25rem 1.4rem;`, and add `gap:0;padding:0;overflow:hidden;`. The line keeps `min-height:186px`.

Add after the `.course-card:hover` rule:

```css
.course-card .card-banner{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--hover)}
.course-card .card-body{display:flex;flex-direction:column;gap:.8rem;flex:1;min-width:0;padding:1.25rem 1.4rem}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no output.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/api.ts src/app/course.ts src/styles.css
git commit -m "feat(course): banner on the home card and a 3/2/1 grid"
```

---

### Task 4: File-manager banner recognition

**Files:**
- Modify: `src/app/admin-files.ts:82` (hint), `:155-171` (icon), `:391` (meta), class methods
- Modify: `src/styles.css` (new `.files-note`)

**Interfaces:**
- Consumes: the filename convention from Task 1 (mirrored client-side; display only).
- Produces: `isBanner(path: string): boolean`; `isImage(name: string): boolean`.

- [ ] **Step 1: Add the matchers and helpers**

At module level, beside the other constants:

```ts
/** Mirrors worker/banners.js; this copy only labels the row. */
const BANNER_FILE = /^[^/]+\/banner\.(jpe?g|png|webp)$/i;
const IMAGE_FILE = /\.(jpe?g|png|webp|gif)$/i;
```

In the component:

```ts
protected isBanner(path: string): boolean { return BANNER_FILE.test(path); }
protected isImage(name: string): boolean { return IMAGE_FILE.test(name); }
```

- [ ] **Step 2: Label the row**

In the `files` mapping inside `rows`, append to `meta`:

```ts
meta: this.size(f.size) + (f.lesson ? ' · lesson' : '') + (f.hls ? ' · HLS' : '') + (this.isBanner(f.key) ? ' · course banner' : ''),
```

- [ ] **Step 3: Show a picture glyph for images**

In the file-row icon branch, add before the final `@else`:

```html
@else if (isImage(row.name)) {
  <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></svg>
}
```

- [ ] **Step 4: Add the hint at a course root**

After `@if (error()) { ... }`:

```html
@if (path() && !path().includes('/')) {
  <p class="files-note">Card banner: upload banner.jpg, banner.png or banner.webp to this folder (landscape, about 16:9).</p>
}
```

CSS, beside the other `.files-*` rules:

```css
.files-note{margin:.2rem .2rem .5rem;color:var(--muted);font-size:12.5px;line-height:1.45}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Expected: no output.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin-files.ts src/styles.css
git commit -m "feat(files): label and hint the course banner image"
```

---

### Task 5: Resource PATCH route

**Files:**
- Modify: `worker/index.js:1091-1103` (the `/api/admin/resources/<id>` block)

**Interfaces:**
- Produces: `PATCH /api/admin/resources/<id>` with `{ title, note?, url? }` → `{ resource: ResourceItem }`.
- Consumes: `lessonAccess`, `accessError`, `json` (already in `index.js`).

- [ ] **Step 1: Add the route**

Inside the existing `{ const mr = ... }` block, before the `DELETE` branch:

```js
if (mr && m === 'PATCH') {
  const id = Number(mr[1]);
  const row = await env.DB.prepare('SELECT lesson, kind, file_key FROM resources WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'Not found' }, 404);
  const access = await lessonAccess(env, u, String(row.lesson));
  if (access !== 'ok') return accessError(access);
  const b = await req.json().catch(() => ({}));
  const title = String(b.title || '').trim();
  const note = String(b.note || '').trim();
  if (!title) return json({ error: 'Give the resource a title' }, 400);
  if (title.length > 120) return json({ error: 'Keep the title under 120 characters' }, 400);
  if (note.length > 300) return json({ error: 'Keep the note under 300 characters' }, 400);
  let url = '';
  if (row.kind !== 'pdf') {
    url = String(b.url || '').trim();
    if (!url || url.length > 800) return json({ error: 'Enter a link' }, 400);
    let parsed;
    try { parsed = new URL(url); } catch { return json({ error: 'Enter a valid http(s) link' }, 400); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return json({ error: 'Enter a valid http(s) link' }, 400);
    await env.DB.prepare('UPDATE resources SET title = ?, note = ?, url = ? WHERE id = ?').bind(title, note || null, url, id).run();
  } else {
    // A PDF's file is its file_key; a submitted url must never replace it.
    await env.DB.prepare('UPDATE resources SET title = ?, note = ? WHERE id = ?').bind(title, note || null, id).run();
  }
  return json({
    resource: {
      id,
      title,
      url: row.kind === 'pdf' ? String(row.file_key || '') : url,
      note: note || null,
      kind: row.kind === 'pdf' ? 'pdf' : 'link',
    },
  });
}
```

- [ ] **Step 2: Verify syntax and tests**

Run: `node --input-type=module --check < worker/index.js`
Expected: no output.

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "feat(resources): edit a resource over PATCH"
```

---

### Task 6: Resource edit API and dialog

**Files:**
- Modify: `src/app/api.ts:257` (beside `deleteResource`)
- Modify: `src/app/lesson-resources.ts` (template, state, methods, keydown)
- Modify: `src/styles.css` (`.lr-tools`, `.lr-edit`)

**Interfaces:**
- Consumes: `PATCH /api/admin/resources/<id>` from Task 5.
- Produces: `Api.updateResource(id: number, r: { title: string; url?: string; note?: string }): Promise<{ resource: ResourceItem }>`.

- [ ] **Step 1: Add the API method**

```ts
updateResource(id: number, r: { title: string; url?: string; note?: string }): Promise<{ resource: ResourceItem }> {
  return this.req(`admin/resources/${id}`, r, 'PATCH');
}
```

- [ ] **Step 2: Add the pencil beside the trash**

Replace the current `@if (isAdmin()) { <button class="lr-del">…` block with:

```html
@if (isAdmin()) {
  <span class="lr-tools">
    <button type="button" class="lr-edit" aria-label="Edit resource" title="Edit resource" (click)="edit(r)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13 7 4 4" /></svg>
    </button>
    <button type="button" class="lr-del" aria-label="Delete resource" title="Delete resource" (click)="remove(r)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
    </button>
  </span>
}
```

- [ ] **Step 3: Add the edit dialog**

After the `@if (opened(); as r) { ... }` block, still inside `.lr`:

```html
@if (editing(); as r) {
  <div class="adm-scrim" (click)="closeEdit()"></div>
  <div class="adm-dialog" role="dialog" aria-modal="true" aria-labelledby="lr-edit-title">
    <header class="adm-dialog-top">
      <h3 id="lr-edit-title">Edit resource</h3>
      <button type="button" class="adm-close" aria-label="Close" (click)="closeEdit()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
      </button>
    </header>
    <div class="adm-form">
      <label class="field">
        <span>Title</span>
        <input #editTitleInput [value]="editTitle()" (input)="editTitle.set($any($event.target).value)" maxlength="120" autocomplete="off" spellcheck="false" />
      </label>
      @if (r.kind === 'link') {
        <label class="field">
          <span>Link</span>
          <input type="url" [value]="editUrl()" (input)="editUrl.set($any($event.target).value)" maxlength="800" autocomplete="off" spellcheck="false" placeholder="https://..." />
        </label>
      } @else {
        <p class="adm-muted sm">To replace the PDF, delete it and upload a new one.</p>
      }
      <label class="field">
        <span>Note</span>
        <input [value]="editNote()" (input)="editNote.set($any($event.target).value)" maxlength="300" autocomplete="off" spellcheck="false" placeholder="Optional note" />
      </label>
      @if (editError()) { <p class="files-error">{{ editError() }}</p> }
    </div>
    <footer class="adm-dialog-foot">
      <button type="button" (click)="closeEdit()">Cancel</button>
      <button type="button" class="p" [disabled]="editBusy()" (click)="saveEdit()">{{ editBusy() ? 'Saving...' : 'Save' }}</button>
    </footer>
  </div>
}
```

- [ ] **Step 4: Add the component state and methods**

State, beside `opened`:

```ts
protected readonly editing = signal<ResourceItem | null>(null);
protected readonly editTitle = signal('');
protected readonly editUrl = signal('');
protected readonly editNote = signal('');
protected readonly editError = signal('');
protected readonly editBusy = signal(false);
protected readonly editTitleInput = viewChild<ElementRef<HTMLInputElement>>('editTitleInput');
```

Focus effect, beside the existing `backBtn` effect:

```ts
effect(() => {
  if (this.editing() && this.editTitleInput()) this.editTitleInput()!.nativeElement.focus();
});
```

Methods:

```ts
protected edit(r: ResourceItem): void {
  this.editError.set('');
  this.editing.set(r);
  this.editTitle.set(r.title);
  this.editUrl.set(r.kind === 'link' ? r.url : '');
  this.editNote.set(r.note ?? '');
  this.editBusy.set(false);
}

protected closeEdit(): void {
  if (this.editBusy()) return;
  this.editing.set(null);
  this.editError.set('');
}

protected async saveEdit(): Promise<void> {
  const r = this.editing();
  if (!r || this.editBusy()) return;
  this.editError.set('');
  this.editBusy.set(true);
  try {
    await this.api.updateResource(r.id, {
      title: this.editTitle().trim(),
      ...(r.kind === 'link' ? { url: this.editUrl().trim() } : {}),
      note: this.editNote().trim(),
    });
    this.editing.set(null);
    await this.load();
  } catch (e) {
    this.editError.set(e instanceof Error ? e.message : 'Could not save that resource.');
  } finally {
    this.editBusy.set(false);
  }
}
```

- [ ] **Step 5: Reset on lesson change and extend Escape**

In the lesson-change effect, beside `this.opened.set(null);`, add:

```ts
this.editing.set(null);
this.editError.set('');
```

Change the keydown handler to close the edit dialog first:

```ts
const esc = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  if (this.editing()) { e.preventDefault(); e.stopPropagation(); this.closeEdit(); return; }
  if (this.opened()) { e.preventDefault(); e.stopPropagation(); this.close(); }
};
```

- [ ] **Step 6: Add the CSS**

Beside the `.lr-del` rules:

```css
.lr-tools{display:flex;gap:.15rem;flex:none}
button.lr-edit{flex:none;display:grid;place-items:center;width:28px;height:28px;min-height:28px;padding:0;background:transparent;color:var(--muted)}
button.lr-edit:hover:not(:disabled){background:var(--hover);color:var(--primary)}
.lr-edit svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck`
Expected: no output.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/app/api.ts src/app/lesson-resources.ts src/styles.css
git commit -m "feat(resources): edit a resource from a dialog"
```

---

### Task 7: End-to-end verification on dev

**Files:** none planned; fix findings in the task that owns them.

- [ ] **Step 1: Run the full local suite**

Run: `npm test`
Expected: all suites pass (the previous 62 plus the 4 banner tests).

Run: `npm run typecheck`
Expected: no output.

Run: `npm run build`
Expected: build succeeds.

Run: `npm run check:scripts`
Expected: no output.

- [ ] **Step 2: Deploy the dev branch**

Run: `npm run deploy`
Expected: `Cloudflare account: … (branch "dev")`, build + deploy succeed, and the printed site URL is the dev Worker.

- [ ] **Step 3: Banner upload / replace / delete**

Sign in to the dev site as the **dev test admin** (never the production owner). In **Admin → Course files**, open a throwaway course (create one with **New folder** if needed) and upload a landscape JPG or PNG renamed to `banner.jpg` with the existing **Upload** button.

Check:
- The row says `… · course banner` and shows the picture glyph.
- The course root shows the banner hint.
- Going home shows the image at the top of that course's card.
- Uploading a visibly different `banner.jpg` and choosing **Replace** changes the card image immediately (Review Focus 1).
- A second `banner.png` in the same folder does not win over `banner.jpg` (Review Focus 3).
- Deleting the `banner.jpg` row makes the banner disappear and the card return to its no-banner look (Review Focus 1).
- Create a throwaway course whose name contains a space and `&`, upload a banner, and confirm it loads (Review Focus 5). Delete both throwaway courses afterwards.

- [ ] **Step 4: Locked-course banner**

Using a throwaway student, grant only one course that has a banner. Sign in as the student and confirm a different course with a banner still shows its image while its card says **No access** (Review Focus 2).

- [ ] **Step 5: Resource edit**

On a video lesson's **Resources** tab as the dev admin:
- Add a link resource; click the pencil; change the title, note and URL; Save; confirm the row updates in place (same position).
- Add a PDF resource; edit its title and note; confirm the PDF still opens.
- Send a crafted same-origin `fetch('/api/admin/resources/<id>', { method:'PATCH', ... })` for that PDF with a `url` — expect `200`, and confirm the PDF still opens and the row's URL is still the file key (Review Focus 4).
- Delete the test resources.

- [ ] **Step 6: Layout and themes**

Check the course grid at ~1280 px (3 columns), ~900 px (2), ~390 px (1). Check light and dark themes, and that a banner card's title/description/footer do not overflow at 320 px.

- [ ] **Step 7: Fix and re-check**

Fix anything that failed in the task that owns it, rerun that task's checks, and re-run the live check. Commit fixes with the owning task's scope.

---

### Task 8: Documentation

**Files:**
- Modify: `README.md:55`, `:81`, `:97` (course structure, grid, file manager)
- Modify: `docs/CHANGELOG.md` (Unreleased)
- Modify: `docs/HANDOFF.md` (decision log, file map, API table, last-updated line)

- [ ] **Step 1: README**

- Line 55: add the banner to the card description.
- Line 81: replace “two per row on desktop” with “three per row on a wide screen, two when narrower, one on phones”.
- After the **Description** bullet in the File manager section, add:

```markdown
- **Card banner:** upload an image named `banner.jpg`, `banner.png` or `banner.webp` into a course folder and it appears at the top of that course's card on the home screen. Landscape, about 16:9, 800 px wide or more; the card centre-crops it. Replace it by uploading the same name and choosing **Replace**, or delete the row to remove the banner. It is an ordinary R2 object and the course tree ignores it. The opened course page is unchanged.
```

- [ ] **Step 2: CHANGELOG**

Under `## Unreleased`, add the four bullets: banner, resource edit, 3/2/1 grid, and the verification line with the actual `npm test` count and live checks from Task 7.

- [ ] **Step 3: HANDOFF**

- Decision log: add a row for the named-file banner convention and one for resource editing.
- File map: add `worker/banners.js`.
- API table: add `GET /api/banner/<course>` (session; image bytes) and `PATCH /api/admin/resources/<id>` (admin; title/note/link URL).
- “Last updated” line: append the banner/resource-edit/grid work.

- [ ] **Step 4: Verify docs build nothing**

Run: `npm run typecheck` (docs-only change, but cheap).
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/CHANGELOG.md docs/HANDOFF.md
git commit -m "docs: course banners, resource editing and the 3/2/1 grid"
```

---

### Task 9: Ship to production

**Files:** none.

- [ ] **Step 1: Push and merge**

```bash
git push origin dev
git checkout main
git merge --ff-only dev
git push origin main
```

Expected: fast-forward merge; both branches at the same commit.

- [ ] **Step 2: Deploy production**

Run: `npm run deploy`
Expected: `Cloudflare account: … (branch "main")` and a successful deploy to the production Worker.

- [ ] **Step 3: Smoke-test production without touching owner data**

- Open the production login screen; it renders.
- `GET /api/config` returns `200`.
- Do **not** sign in as the production owner and do not upload, edit or delete any production content.

- [ ] **Step 4: Return to the working branch**

```bash
git checkout dev
git status --short
```

Expected: clean tree on `dev`.

---

## Self-review notes

- Spec coverage: banner convention + route (Tasks 1–2), card + grid (Task 3), file manager (Task 4), resource PATCH + dialog (Tasks 5–6), verification (Task 7), docs (Task 8), rollout (Task 9).
- Type consistency: `banner` is an R2 key inside `listCourse` and a URL on `CourseData`; `updateResource` uses the same `ResourceItem` shape as the list.
- Deliberate choices left to the implementer: exact icon paths, hint wording placement, and the 320–360 px grid minimum if 340 px reads badly on the live cards.
