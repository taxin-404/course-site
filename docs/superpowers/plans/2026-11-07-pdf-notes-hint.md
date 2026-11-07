# PDF Notes Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a one-time, auto-dismissing toast in the PDF reader telling each student they can annotate the PDF and that their notes are private.

**Architecture:** Pure browser-storage helpers live in a testable module; the toast itself is added once to the shared `PdfViewer` component, which both the PDF lesson and the resource-PDF modal render, so one implementation covers both views. Styling goes in the single global stylesheet.

**Tech Stack:** Angular 22 template + signals, the global `src/styles.css`, `node:test` with `--experimental-strip-types` for the pure helpers.

**Spec:** `docs/superpowers/specs/2026-11-07-pdf-notes-hint-design.md`

## Global Constraints

- No new dependencies. No per-component styles; use `src/styles.css`.
- Exact copy: `You can add notes right on this PDF — they're saved automatically and only you can see them.`
- Show at most once per student, keyed by the signed-in user id.
- The toast is not a modal: it must not block reading the PDF.
- Do not touch the PDF.js built-in toolbar, the watermark, or the notes controls.
- No server change — notes already exist and are scoped per student.
- Pure logic is tested with `npm test`; UI is verified live on dev.
- Never sign in as or modify the real owner. Use a throwaway student created through the admin API and delete it afterwards.
- Dev account: `CLOUDFLARE_ACCOUNT_ID=d5d15d42e8e4fd5a159feb81ae38f036`. Prod is `main` / `817cb083445c5dea901e5294b34edd46`.

## Review Focus

- A student's first PDF with empty storage → the hint appears.
- A second PDF or a reload → it does not appear again.
- A different student on the same browser → it appears for them.
- `localStorage` unavailable or throwing → no crash, hint skipped.
- The toast must not block the PDF and must disappear on its own after 10 s.

---

### Task 1: Hint persistence helpers

**Files:**
- Create: `src/app/pdf-hint.ts`
- Test: `src/app/pdf-hint.test.mjs`

**Interfaces:**
- Produces:
  - `PDF_HINT_MS: number` — `10_000`
  - `HintStore` — `{ getItem(key: string): string | null; setItem(key: string, value: string): void }`
  - `hintKey(userId: number | string): string`
  - `shouldShowHint(store: HintStore, userId: number | string | null | undefined): boolean`
  - `markHintSeen(store: HintStore, userId: number | string): void`

- [ ] **Step 1: Write the failing test**

Create `src/app/pdf-hint.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDF_HINT_MS, hintKey, shouldShowHint, markHintSeen } from './pdf-hint.ts';

const store = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
};

test('the hint lasts ten seconds', () => assert.equal(PDF_HINT_MS, 10_000));

test('the key is per student', () => {
  assert.equal(hintKey(7), 'pdf-hint-seen:7');
  assert.notEqual(hintKey(7), hintKey(8));
});

test('show until this student has seen it', () => {
  const s = store();
  assert.equal(shouldShowHint(s, 7), true);
  markHintSeen(s, 7);
  assert.equal(shouldShowHint(s, 7), false);
});

test('one student seeing it does not hide it for another', () => {
  const s = store();
  markHintSeen(s, 7);
  assert.equal(shouldShowHint(s, 7), false);
  assert.equal(shouldShowHint(s, 8), true);
});

test('no signed-in id means no hint', () => {
  const s = store();
  assert.equal(shouldShowHint(s, undefined), false);
  assert.equal(shouldShowHint(s, null), false);
  assert.equal(shouldShowHint(s, ''), false);
});

test('a storage that throws never breaks the viewer', () => {
  const bad = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(shouldShowHint(bad, 7), false);
  assert.doesNotThrow(() => markHintSeen(bad, 7));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test src/app/pdf-hint.test.mjs`
Expected: FAIL — `Cannot find module './pdf-hint.ts'`.

- [ ] **Step 3: Implement the helpers**

Create `src/app/pdf-hint.ts`:

```ts
/** How long the one-time PDF notes hint stays on screen. The toast binds this to its bar. */
export const PDF_HINT_MS = 10_000;

const KEY_PREFIX = 'pdf-hint-seen:';

export interface HintStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function hintKey(userId: number | string): string {
  return KEY_PREFIX + userId;
}

/** True when this student has not seen the hint in this browser. */
export function shouldShowHint(store: HintStore, userId: number | string | null | undefined): boolean {
  if (userId === null || userId === undefined || userId === '') return false;
  try { return store.getItem(hintKey(userId)) !== '1'; } catch { return false; }
}

/** Remember that this student has seen the hint; safe when storage is unavailable. */
export function markHintSeen(store: HintStore, userId: number | string): void {
  try { store.setItem(hintKey(userId), '1'); } catch { /* private mode: it just shows once per page */ }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --experimental-strip-types --test src/app/pdf-hint.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/pdf-hint.ts src/app/pdf-hint.test.mjs
git commit -m "feat(pdf): per-student one-time hint helpers"
```

---

### Task 2: Show the toast in the shared PDF viewer

**Files:**
- Modify: `src/app/pdf-viewer.ts`
- Modify: `src/styles.css` (append near the `app-pdf-viewer` rules, ~line 253)
- Modify: `docs/CHANGELOG.md` (`## Unreleased`)

**Interfaces:**
- Consumes from Task 1: `PDF_HINT_MS`, `shouldShowHint`, `markHintSeen`, `HintStore`.

- [ ] **Step 1: Wire the state into `PdfViewer`**

Add the import and fields:

```ts
import { PDF_HINT_MS, markHintSeen, shouldShowHint, type HintStore } from './pdf-hint';
```

```ts
protected readonly hint = signal(false);
protected readonly hintMs = PDF_HINT_MS;
private hintTimer: ReturnType<typeof setTimeout> | undefined;
```

In the existing `inject(DestroyRef).onDestroy(...)` callback, add `clearTimeout(this.hintTimer);`.

Add these methods:

```ts
private maybeShowHint(): void {
  const id = this.api.me()?.id;
  if (id === undefined) return;
  let store: HintStore;
  try { store = localStorage; } catch { return; }
  if (!shouldShowHint(store, id)) return;
  markHintSeen(store, id); // once per student, even if it times out
  this.hint.set(true);
  this.hintTimer = setTimeout(() => this.dismissHint(), PDF_HINT_MS);
}

protected dismissHint(): void {
  clearTimeout(this.hintTimer);
  this.hintTimer = undefined;
  this.hint.set(false);
}
```

Call `this.maybeShowHint();` from `ngOnInit()` after the `loadNotes` line.

- [ ] **Step 2: Add the toast to the template**

Inside `.viewer-wrap`, after the `ngx-extended-pdf-viewer` element:

```html
@if (hint()) {
  <div class="pdf-hint" role="status" aria-live="polite">
    <span class="pdf-hint-text">You can add notes right on this PDF — they're saved automatically and only you can see them.</span>
    <button type="button" class="pdf-hint-x" aria-label="Dismiss" title="Dismiss" (click)="dismissHint()">&times;</button>
    <span class="pdf-hint-bar" aria-hidden="true" [style.animationDuration.ms]="hintMs"></span>
  </div>
}
```

- [ ] **Step 3: Add the styles**

Append to `src/styles.css`:

```css
/* One-time notes hint over the PDF: readable, bottom-centre, drains over 10s. */
.pdf-hint{position:absolute;left:50%;bottom:1rem;z-index:5;width:min(600px,calc(100% - 2rem));display:flex;align-items:center;gap:.75rem;padding:.8rem .7rem .8rem 1.05rem;transform:translateX(-50%);background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--r-dialog);overflow:hidden;box-shadow:0 10px 34px rgb(15 23 42 / 28%)}
.pdf-hint-text{flex:1;font-size:1.02rem;line-height:1.4}
.pdf-hint-x{flex:none;width:32px;height:32px;border:0;border-radius:var(--r-ctl);background:var(--hover);color:var(--text);font-size:20px;line-height:1;cursor:pointer}
.pdf-hint-x:hover{background:var(--border)}
.pdf-hint-bar{position:absolute;left:0;bottom:0;width:100%;height:4px;background:var(--primary);transform-origin:left;animation:pdf-hint-drain 10s linear forwards}
@keyframes pdf-hint-drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@media (prefers-reduced-motion:reduce){.pdf-hint-bar{display:none}}
```

- [ ] **Step 4: Add the changelog entry**

Under `## Unreleased` in `docs/CHANGELOG.md`, add a subsection matching the file's voice:

```markdown
### Added (PDF notes hint)
- **A one-time hint now tells students they can annotate a PDF and that their notes are private.** It lives in the shared `app-pdf-viewer`, so it appears in both a PDF lesson and the resource-PDF modal. It shows once per student (`localStorage['pdf-hint-seen:<userId>']`), sits at the bottom-centre over the page at ~1rem, drains a 4px bar over 10s, and has a labelled dismiss button that hides it immediately. `prefers-reduced-motion` drops the bar. Verified with `npm test` (6 helper tests) plus `typecheck`, `build`, `check:scripts`, and a live headless check on dev.
```

- [ ] **Step 5: Run the checks**

```bash
npm run typecheck && npm test && npm run build && npm run check:scripts
```

Expected: all pass (`npm test` now 62 tests).

- [ ] **Step 6: Deploy to dev**

```bash
CLOUDFLARE_ACCOUNT_ID=d5d15d42e8e4fd5a159feb81ae38f036 npm run deploy
```

- [ ] **Step 7: Verify live on dev with a throwaway student**

Create a student through the admin API (`POST /api/admin/users`, `is_admin: 0`, `courses: []`), sign in via a same-origin `fetch('/api/login')` in the headless browser (this sidesteps the password-manager extension), then check:

1. Empty `localStorage` → open a PDF lesson → `.pdf-hint` is visible; its computed `font-size` is ~16px; `.pdf-hint-bar` exists.
2. Wait ~10.5 s → `.pdf-hint` is gone.
3. Reload and reopen the PDF → `.pdf-hint` is absent.
4. `localStorage.removeItem('pdf-hint-seen:<id>')` → open the resource-PDF modal on a non-PDF lesson with a PDF resource → `.lr-viewer .pdf-hint` is visible.
5. Delete the throwaway student and any scratch lesson/resource created for step 4.

- [ ] **Step 8: Commit**

```bash
git add src/app/pdf-viewer.ts src/styles.css docs/CHANGELOG.md
git commit -m "feat(pdf): one-time notes hint in the shared viewer"
```

---

### Task 3: Ship to production

**Files:** none.

- [ ] **Step 1: Fast-forward `main` and deploy**

```bash
git checkout main && git merge --ff-only dev
CLOUDFLARE_ACCOUNT_ID=817cb083445c5dea901e5294b34edd46 npm run deploy
```

- [ ] **Step 2: Verify the served bundle and health**

```bash
# the served chunk must be byte-identical to dist/web/browser's copy
CHUNK=$(grep -rl "pdf-hint-seen" dist/web/browser/*.js | xargs -n1 basename)
curl -s -o /tmp/opencode/prod.js "https://course-site.cspg.workers.dev/$CHUNK"
sha256sum "dist/web/browser/$CHUNK" /tmp/opencode/prod.js
curl -s -o /dev/null -w '%{http_code}\n' https://course-site.cspg.workers.dev/api/config
```

Expected: matching hashes; `/api/config` is `200`.

- [ ] **Step 3: Push and return to `dev`**

```bash
git push origin main && git push origin dev && git checkout dev
```
