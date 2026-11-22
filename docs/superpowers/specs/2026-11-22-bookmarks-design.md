# Lesson bookmarks — design

Date: 2026-11-22
Status: APPROVED 2026-11-22 — ready for the implementation plan
Approach: 1 (dedicated `/bookmarks` page, opened from the `⋮` menu)

## Intent (why)

Students need a way to mark a whole lesson to come back to, and one place to find
those lessons. Today the site records completed lessons (`watched`), which answers
"what have I finished", not "what do I want to revisit". Bookmarks are per student
and private, like progress and notes.

This is lesson-level only: no video timestamps, PDF pages, notes or folders.

## Goals

- A bookmark toggle in the lesson bar for every lesson kind (video, YouTube, PDF,
  text, Markdown), beside **Mark as complete**.
- A **Bookmarks** item in the shared `⋮` menu that opens `/bookmarks`.
- `/bookmarks` lists the student's bookmarked lessons, newest first, each showing
  the lesson title and its course › section. Clicking a row opens the lesson; a
  separate remove control unsaves it.
- Bookmarks survive a lesson move or rename, and are deleted with the lesson or
  the user.
- A bookmark in a course the student can no longer access is hidden, but kept:
  restoring access brings it back.

## Non-goals / anti-goals

- No timestamps inside media, no page numbers, no folder bookmarks, no bookmark
  collections or tags.
- No bonus progress: `done` and `bookmarked` are independent.
- No bookmark indicator in the file browser, no count on course cards, no export.
- A bookmarked lesson in a locked course must not leak its title or existence.
- No change to how access is granted, nor to the media/notes/comments rules.
- No new dependencies.

## Constraints

- Angular templates and the one global `src/styles.css`; no component styles.
- D1 has no foreign-key cascades here. Cleanup is explicit, in the same places
  that clean `watched`, notes and comments.
- The schema is versioned. Changing DDL requires bumping `SCHEMA_VERSION` and
  updating the pinned schema hash in `worker/schema.test.mjs`.
- The app already loads every accessible course and lesson in `/api/course`.
  Locked courses arrive with `sections: []`, so their lesson data is withheld.
- Lesson access is checked with `lessonAccess()`, the same rule as
  `/api/progress`.

## Approaches considered

1. **Dedicated `/bookmarks` page from the `⋮` menu.** Full-width list, newest
   first, course/section labels, click to open, remove per row. Fits the router,
   breadcrumb and list styles already used by the course screens. **Picked.**
2. **Inline inside the `⋮` dropdown.** No new page, but the menu is a 210px
   popover that closes on any outside click; a real list becomes a cramped
   scrolling menu, and removing an item inside a menu is awkward.
3. **A Bookmarks card/filter on the home page.** Keeps navigation in the course
   browser, but the request puts it in the hamburger menu, and the header is
   hidden while a lesson is open, so it is less direct.

## The design

### 1. Schema (`worker/index.js`)

Add to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id INTEGER NOT NULL,
  lesson TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, lesson)
)
```

`created` is the bookmark time in milliseconds, used for newest-first ordering.
The primary key is `(user_id, lesson)`: a bookmark belongs to exactly one user,
and two users bookmarking the same lesson get two independent rows. There is no
foreign key, matching `watched` and `pdf_notes`. Bump `SCHEMA_VERSION` from `'1'`
to `'2'`; existing databases then run the full idempotent schema once and get the
table. Update the pinned DDL hash.

### 2. Worker API

**`/api/course`** already reads the student's `watched` rows. Read `bookmarks`
alongside them in one `DB.batch` and build a `Map(lesson → created)`. Pass the
timestamp into `publicLesson(lesson, done, bookmarkedAt)`, which returns:

```js
{ ..., done: true, bookmarked: true, bookmarkedAt: 1730000000000 }
```

`bookmarked` is always present; `bookmarkedAt` is present only when bookmarked.
This keeps the lesson bar and the bookmarks page on the one payload the app
already loads.

**`POST /api/bookmarks`** with `{ lesson, bookmarked }`, next to `/api/progress`:

1. Run `lessonAccess(env, u, lesson)`; reply 404/403 exactly like progress.
2. `bookmarked === true`: `INSERT OR IGNORE` with `Date.now()`. Re-bookmarking
   after a remove gets a fresh timestamp; repeated adds keep the first.
3. Otherwise: delete the row.
4. Reply `{ ok: true, bookmarked }`.

Every statement binds the signed-in user's `u.id`; the client never sends a user
id, so one user cannot read or change another user's bookmarks. `/api/course`
likewise selects only that user's rows, so `bookmarked` describes the current
viewer's list. Admins have their own list and no access to anyone else's.

No new `GET` endpoint: `/api/course` already carries every accessible lesson and
already withholds locked courses. A separate list endpoint would duplicate the
access filter and a copy of the lesson metadata, and the page is a view over data
the app already has.

### 3. Frontend data

`src/app/api.ts`:

- `Lesson` gains `bookmarked: boolean` and `bookmarkedAt?: number`.
- `setBookmark(id, bookmarked)` updates the course signal optimistically, like
  `setDone`: set the flag and timestamp, or clear them; roll back on a rejected
  request. A small private helper may be shared with `setDone` to avoid
  duplicating the immutable course/section/lesson walk.

### 4. Lesson button (`src/app/course.ts`)

In `.player-bar`, before the done button:

- A new `.bookmark-btn`, styled like `.done-btn`, with an outline bookmark icon
  when off and a filled primary-coloured icon when on.
- `aria-pressed`, label/title **Bookmark** when off and **Bookmarked** when on.
- On phones the text label is hidden and the control is a 40px icon, matching
  Back and Mark as complete.
- Click calls `api.setBookmark(l.id, !l.bookmarked)`; the optimistic signal update
  flips the icon immediately.

### 5. Bookmarks page (`src/app/bookmarks.ts`, `/bookmarks`)

- Lazy route `{ path: 'bookmarks', loadComponent: ... }` in `app.routes.ts`.
  `Shell.headerVisible` is already true because this is neither admin nor a
  lesson, so the header and its `⋮` menu stay.
- A breadcrumb `Courses / Bookmarks` (the Courses button goes home), a
  `page-title` **Bookmarks**, and a `.list` of rows.
- Rows are derived from `api.courses()` by a pure helper
  (`src/app/bookmark-rows.ts`): flatten lessons with `bookmarked`, attach course
  title and `section || ''`, and sort by `bookmarkedAt` descending with a stable
  course/section/title tie-break.
- Each row has its own open button (title, course › section) and a separate
  remove button, so no button is nested. The remove button has an
  `aria-label="Remove bookmark: <title>"`. Row actions stay visible on touch.
- Clicking the row runs `router.navigate(lessonUrl(row.course, row.lesson))`.
- Empty state: **No bookmarks yet. Open a lesson and use the bookmark button.**
- A failed remove rolls the row back (the optimistic update is reverted) and
  shows a short error line.

The course-root section has `title: null`, so its label is just the course name.
For a nested section the label is `Course / Section`, matching the header search.

### 6. Menu (`src/app/options-menu.ts`)

Add **Bookmarks** as the first entry for every signed-in user, with a bookmark
outline icon. It closes the menu and calls `router.navigateByUrl('/bookmarks')`.
It appears in the header, the admin shell and the admin file view because they
all share this component. Choosing it while already there is a harmless no-op.

### 7. Lifecycle

- `worker/files.js` `LESSON_ROWS`:
  `UPDATE OR REPLACE bookmarks SET lesson = ? WHERE lesson = ?` — moves and
  renames carry bookmarks, and a retry can land on an existing target row.
- `LESSON_DELETES`: `DELETE FROM bookmarks WHERE lesson = ?`.
- `LESSON_TABLES`: add `bookmarks`, so an interrupted delete can still find the
  lesson key.
- Deleting a course already enumerates and deletes its lessons through those
  lists, so its bookmarks go too.
- The admin YouTube delete route deletes its rows directly; add one
  `DELETE FROM bookmarks WHERE lesson = ?` there. (Its existing handling of
  watched/comments is left untouched; that is a separate cleanup.)
- Deleting a user adds `DELETE FROM bookmarks WHERE user_id = ?` to the existing
  batch.
- Revoking a course does not delete rows: `/api/course` withholds the course, and
  restoring enrollment makes the same rows visible again.

### 8. Tests

- `worker/limits.test.mjs`: `publicLesson` always includes `bookmarked`, includes
  `bookmarkedAt` only when bookmarked, and still never exposes the YouTube id.
- `worker/security.test.mjs`:
  - a bookmark toggle accepts only a real lesson in an enrolled course
    (404/403/200, mirroring the progress test);
  - `/api/course` reports the flag and timestamp after bookmarking, and clears
    both after unbookmarking;
  - a bookmark survives enrollment removal (course has no sections) and comes
    back when enrollment is restored;
  - the existing lesson-delete test also seeds a bookmark and asserts the row is
    gone;
  - the existing user-delete test also seeds a bookmark and asserts the row is
    gone.
- `worker/youtube-rename.test.mjs`: seed a bookmark and include `bookmarks` in
  the moved-tables loop.
- `src/app/bookmark-rows.test.mjs`: filtering, labels, newest-first order and the
  deterministic tie-break.
- `worker/schema.test.mjs`: updated hash; add `bookmarks` to the table-presence
  assertion.

## Calls I made (check these while reading)

- **No `GET /api/bookmarks`.** The page is derived from the existing course
  payload instead of adding a second source of the same data.
- **Newest first**, using a `created` timestamp exposed as `bookmarkedAt`; the
  alternative was the course/section order of the file browser.
- **Bookmarks are private per user.** The shared `⋮` component shows the item to
  everyone, but each person (admin included) opens only their own list.
- **YouTube delete gets only the bookmarks statement**, not a reuse of
  `LESSON_DELETES`; fixing its other orphaned student rows is out of scope.
- **Breadcrumb rather than a history Back button**, so a deep link to
  `/bookmarks` always has a working way home.

## What is left to the builder

- Exact icon path, row markup and CSS class names.
- Whether to extract the shared optimistic lesson updater or keep `setBookmark`
  self-contained.
- Wording of the error line.
