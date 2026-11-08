# Course card banners, resource editing, 3-up cards — design

Date: 2026-11-08
Status: APPROVED 2026-11-08 — ready for the implementation plan
Approach: banner as a named file in the course folder, served by a dedicated route;
resource edit via `PATCH` + a dialog; auto-fill 3/2/1 grid.

## Intent (why)

Four owner requests, one release:

1. **A banner image on each course card.** The home screen is the course catalog; the
   owner wants an image at the top of each card so the list reads at a glance. The
   opened course page keeps its current header — the banner is **home screen only**.
2. **Image upload in the file manager.** The file manager already uploads any file,
   but an uploaded image currently has no purpose and no recognition. It should become
   the way a course banner is set.
3. **Edit and Delete in the resource section.** Delete exists today as the trash icon;
   add Edit so a wrong title, note or link can be fixed without deleting the resource
   and adding it again.
4. **Three cards per line.** 3-up on wide screens, 2-up when the window is narrower,
   1-up on phones.

The banner needs no new admin screen: the file manager is already the place where a
course folder is opened and files are uploaded. A file named `banner.<image>` in the
course folder is the banner, and the existing upload/replace/delete flow manages it.

## Goals

- A course card shows a 16:9 banner at its top when the course has one; without a
  banner the card looks exactly as it does today.
- The banner is set entirely from **Admin → Course files**: upload `banner.jpg`,
  `banner.png` or `banner.webp` into the course's folder; overwrite it to replace it;
  delete it to remove it.
- The file manager identifies that file as the course banner (row label + image icon)
  and states the convention at a course root.
- An admin resource row gets an Edit action (pencil, beside the existing trash) that
  opens a small dialog for title, note and — for links only — the URL.
- `.list.cards` is 3-up at wide widths, 2-up at medium, 1-up on phones.

## Non-goals

- No banner inside the opened course page; no second banner placement.
- No crop, focal-point, zoom or image-editing UI. The image is cropped to fill by CSS.
- No D1 column or banner table; no separate banner upload dialog.
- No thumbnail preview of arbitrary images in the file manager.
- No PDF file replacement through Edit: a PDF's title and note are editable, its file
  is not. Replacing a PDF remains delete + upload.
- No change to resource add/upload forms, visibility, ordering or access rules.
- No GIF or SVG banners.

## Constraints

- **Key = structure.** A course is a top-level R2 folder, and `listCourse()` builds the
  student tree from keys. `isLessonKey()` accepts only PDF/video, so
  `<Course>/banner.jpg` is ignored by the tree and cannot become a lesson.
- **`/api/media` cannot serve images.** Its guard (`mediaRequestOk`) requires
  `sec-fetch-dest` to be `video`, `audio`, `empty` or `track`; an `<img>` sends `image`
  and would get a 403. Banners need a small dedicated route.
- **Locked courses still render cards.** The course catalog lists every course with
  its title and description; a locked one shows a card with `No access`. Its banner
  must render too, so the banner route requires a session but **not** enrollment.
- **Uploads are already unrestricted.** The client picker has no `accept` filter and
  `uploadKey()`/`uploadSize()` do not check extensions. Nothing in the upload path
  needs to change.
- One global `src/styles.css`; no component styles.
- `listCourse()` is cached for 60 s and every admin upload/move/delete already calls
  `invalidateCourse()`, so banner changes are visible immediately.
- The banner should survive a course rename: because it lives inside the course folder,
  the existing folder move carries it automatically.
- All copy sentence case, product voice.

## The design

### 1. Banner file convention

Exactly one file at the **course root** names the banner:

```
<Course>/banner.jpg
<Course>/banner.jpeg
<Course>/banner.png
<Course>/banner.webp
```

- Case-insensitive (`Banner.PNG` works).
- Only the course root counts; `Course/Section/banner.jpg` does not.
- If several exist, one wins deterministically: `.jpg`, then `.jpeg`, `.png`, `.webp`.
- No file, or a file of another type (e.g. `.gif`), means no banner.

`listCourse()` records the matching key while it scans the bucket and attaches it to
the internal course object as `banner`. `/api/course` maps it to a URL:

```js
banner: c.banner ? `/api/banner/${encodeURIComponent(c.title)}` : '',
```

`CourseData` in `src/app/api.ts` gains `banner?: string`.

Because the key is derived from the live listing, there is no stored pointer to go
stale: overwrite the file to replace the image, delete it to remove the banner.

### 2. Serving route

```
GET /api/banner/<course>
```

- Inside the authenticated block, beside `/api/media/`; **not** admin-only and not
  enrollment-checked, so locked-course cards keep their image.
- Resolve the course with the cached `listCourse()`, take its `banner` key, read the
  object from R2; 404 when either is missing.
- Headers: correct `content-type` (`image/jpeg` / `image/png` / `image/webp`),
  `cache-control: private, no-store`, `x-content-type-options: nosniff`,
  `content-disposition: inline`, `cross-origin-resource-policy: same-origin`,
  `x-robots-tag: noindex`, `content-length`.
- `no-store` keeps a replaced banner from lingering in the browser.
- No range handling and no media pacing: this is one small card image, not a lesson.

### 3. Home card

Only the home-screen card changes. Template, inside the existing card `<button>`:

```html
@if (c.banner) {
  <img class="card-banner" [src]="c.banner" alt="" loading="lazy" decoding="async" />
}
<span class="card-body">
  <!-- the existing head, description and footer markup, unchanged -->
</span>
```

```
.course-card{padding:0;gap:0;overflow:hidden}
.course-card .card-banner{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--hover)}
.course-card .card-body{display:flex;flex-direction:column;gap:.8rem;flex:1;min-width:0;padding:1.25rem 1.4rem}
```

- The image is full-bleed to the card's rounded corners (`overflow:hidden`).
- `aspect-ratio:16/9` + `object-fit:cover` gives every card the same image height and
  centre-crops whatever the owner uploads.
- The card keeps its `min-height:186px`; the body's `flex:1` keeps the footer at the
  bottom on both banner and no-banner cards.
- `alt=""` is deliberate: the course title sits directly below the image, so the image
  is decorative.
- Hover/focus already changes the card background and border; the image is a passive
  child of the button and needs no separate hover state.
- Recommended source size, stated in the file-manager hint: landscape, about 16:9,
  800 px wide or more.

### 4. Three / two / one grid

```
.list.cards{grid-template-columns:repeat(auto-fill,minmax(340px,1fr));...}
```

- Max width stays 1240 px. 340 px + the 1.1 rem gap gives 3 columns from roughly a
  1100 px viewport upward and 2 columns between that and the existing phone rule.
- The existing `@media (max-width:760px)` rule already forces `1fr`; it stays.
- Cards still stretch to equal height per row; the title's `nowrap` + ellipsis and the
  description's 3-line clamp stay as they are.

### 5. File manager feedback

No new uploader. The existing Upload button and drag-and-drop already accept images;
the change is recognition and a visible convention:

- On a row whose key matches `<course>/banner.<image>`, the meta line gains
  `· course banner`.
- Image files get a picture glyph instead of the generic document glyph.
- At a course root (a non-empty path with no `/`), a muted one-line hint under the
  toolbar: **“Card banner: upload banner.jpg, banner.png or banner.webp to this folder
  (landscape, about 16:9).”**
- Replacing uses the uploader's existing conflict → Replace flow; deleting uses the
  row's existing trash.

### 6. Resource editing

**Worker:** `PATCH /api/admin/resources/:id`, inside the admin block beside the
existing DELETE.

- Load the row's `lesson` and `kind`; 404 when it does not exist.
- Check `lessonAccess(env, u, lesson)` like the add routes do.
- Validate: title required, trimmed, ≤120 characters; note trimmed, ≤300 characters
  and stored as `null` when empty; for `kind = 'link'`, the URL is required, ≤800,
  and must parse as `http:`/`https:`.
- PDFs ignore any submitted URL; `url` stays `''` and `file_key` is untouched.
- Update `title`, `note` and (links only) `url`; return the same shape the list uses
  (`url` is the file key for PDFs).
- Editing does not change `created`, so the resource keeps its position.

**Client:** `updateResource(id, patch)` in `api.ts`, sent as `PATCH` (the existing
`req()` already accepts a method).

**UI:** each admin row gets a pencil button beside the trash:

- `.lr-edit` mirrors `.lr-del` (28 px, muted) but hovers to `--primary` / `--hover`
  instead of the danger colours; `title="Edit resource"`, `aria-label="Edit resource"`.
- Clicking opens a small modal built from the existing global `.adm-scrim` /
  `.adm-dialog` / `.adm-*` classes (already used by the admin panels), with Title,
  Note, and Link URL for links only.
- For a PDF, the URL field is absent and the dialog says the file itself is replaced by
  deleting and uploading a new one.
- Save calls `updateResource`, then `reload()`, then closes. Errors show inside the
  dialog; the row stays untouched until the save succeeds.
- Cancel, Escape and the backdrop close without changes. Escape is added to the
  component's existing document keydown handler, before its PDF-viewer branch.
- The existing trash button and its confirm flow are unchanged.

### 7. Accessibility / quality floor

- The Edit control is a real button with `title` and `aria-label`; touch targets stay
  at the existing 28 px icon size used by the trash, with the row's padding around it.
- The modal has `role="dialog"`, `aria-modal="true"`, a labelled heading, focus moved
  to the first field when it opens, and Escape to close.
- The banner `<img>` has empty alt (decorative); the card's accessible name still comes
  from its visible text.
- Banner rows in the file manager keep the readable `n B · course banner` meta text,
  so the meaning does not depend on the icon.
- Both themes use existing tokens; no new colours.
- Keep the grid usable at 320 px: the existing phone rule collapses it to one column.

## Approaches considered

### Banner source / upload

- **A — named file in the course folder (chosen).** `banner.<ext>` is the banner.
  No schema, no pointer to maintain, uses the file manager upload the owner asked for,
  travels with the folder on rename, and replaces/deletes through the existing flows.
  Cost: a convention the UI has to state.
- **B — “Set as banner” action on image rows + a D1 pointer.** Any filename works and
  the action is explicit, but a stored key breaks when the file is renamed, moved or
  deleted; it needs a schema change, a new route and extra lifecycle handling.
- **C — dedicated Banner dialog on the course row, uploaded to `_banners/`.** Most
  discoverable, but duplicates the uploader and leaves the file manager untouched —
  the opposite of the owner's “image upload in the file manager” request.

### Resource editing

- **A — PATCH + modal (chosen).** One route, one dialog, no reordering and no loss of
  the PDF's file.
- **B — inline row editing.** Keeps context but adds per-row form state and is cramped
  at phone widths.
- **C — delete + re-add.** Loses the original position and cannot edit a PDF's metadata
  without re-uploading it.

### Grid

- **A — `auto-fill` + 340 px minimum (chosen).** 3/2/1 falls out of the available width;
  the existing phone rule remains the only breakpoint.
- **B — explicit breakpoints per column count.** More CSS for the same result.

## Decisions

1. Banner is `<Course>/banner.jpg|jpeg|png|webp` at the course root; case-insensitive;
   priority jpg, jpeg, png, webp when several exist.
2. The banner appears **only on the home-screen course card**, at its top, 16:9,
   centre-cropped; the opened course page is unchanged.
3. No schema change and no stored banner pointer; the live listing is the source of
   truth.
4. The banner is visible to any signed-in user, including courses they cannot open.
5. Upload uses the existing file manager Upload/drop flow; the file manager labels the
   banner row and prints the convention at a course root.
6. Grid minimum 340 px: 3-up on wide screens, 2-up at medium, 1-up below the existing
   760 px phone breakpoint.
7. Resource Edit covers title, note and link URL; PDF title/note only; Delete stays as
   it is.
8. The edit UI is a small modal reusing the admin dialog classes.

## Left to the builder

- Exact SVG shapes for the pencil and picture glyphs.
- Placement/wording of the file-manager hint, and whether the hint hides once a banner
  exists.
- Whether the description clamp drops from 3 lines to 2 when a banner is present.
- The exact minimum column width (340 px is the target; 320–360 px is acceptable if
  the live card title reads badly).

## Rollout

1. Worker: banner detection in `listCourse()`, `/api/banner/<course>`, `CourseData`
   mapping in `/api/course`.
2. Worker: `PATCH /api/admin/resources/:id`.
3. Client: `api.ts` types/methods; `course.ts` card markup; `styles.css` card/banner,
   grid and `.lr-edit`.
4. Client: `admin-files.ts` banner label/icon/hint; `lesson-resources.ts` edit dialog.
5. Docs: README, CHANGELOG (unreleased), HANDOFF.
6. Verify: `npm run typecheck`, `npm run build`, `npm test`; then on dev with the test
   admin — upload/replace/delete a banner, check 3/2/1 widths, check a locked course's
   banner, edit a link and a PDF, delete a resource, both themes, phone width.
7. Deploy to production; smoke-test the routes. No production course content changes
   unless the owner supplies an image.

## Open questions

- None blocking. A focal point / crop control, more image sizes and a banner preview in
  the file manager are additive later.
