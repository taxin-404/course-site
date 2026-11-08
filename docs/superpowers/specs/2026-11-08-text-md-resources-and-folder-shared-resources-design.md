# Text/Markdown support and folder-wide shared resources

Date: 2026-11-08
Status: design, awaiting approval

## 1. Intent and why

Two features for the course site:

1. **Text and Markdown everywhere.** Today the site only understands video files, `.pdf` files and YouTube lessons as lessons, and a lesson's **Resources** list only accepts a link or an uploaded **PDF**. The course owner wants `.txt` and `.md` supported **both** as resources and as lessons, and wants the resource panel to appear on **every** lesson type (it is currently absent on PDF lessons). The resource upload therefore becomes a four-way choice: **Link · PDF · TXT · MD**.
2. **Folder-wide shared resources.** Repeating the same reference file on every lesson in a module is busywork. The owner wants a reserved folder named **`RESOURCE`**: whatever is uploaded there is shown automatically on **every lesson under that folder, including nested subfolders**, so one upload covers a whole module (or a whole course).

## 2. Goals

- A resource can be a link, a PDF, a `.txt`, or a `.md`; `.txt`/`.md` open in an in-app reader (Markdown rendered, text preformatted).
- A `.txt`/`.md` file dropped into a course becomes a normal lesson (listed, openable, markable complete, commentable, with resources), exactly like a PDF lesson.
- The Resources panel (and the Discussion/Notes tabs) appears on **all** lesson kinds: video, YouTube, PDF and text.
- A `RESOURCE` folder at any course/module depth shares its files with every lesson beneath it, recursively. Several `RESOURCE` folders on the path (course-level and module-level) all contribute.
- No new dependencies. Managed entirely through the existing Admin → Files uploader (no new admin screens) for shared files, and through the existing resource form for per-lesson files.

## 3. Non-goals

- Editing the *contents* of a `.txt`/`.md` file in the app; they are upload-and-view only.
- Rich Markdown (tables, footnotes, raw HTML, task lists). A small, safe subset only.
- Folder-wide **link** resources or folder-wide notes. Only files placed in a `RESOURCE` folder are shared.
- Per-student annotations on text resources/lessons (annotations remain a PDF-only feature).
- Any change to course access, enrollment or the media throttle model.

## 4. Anti-goals (a failure even if it "works")

- Letting a `RESOURCE` folder leak into the course tree as a section/lesson.
- Letting `RESOURCE` files appear as lessons in the file manager (they carry no per-lesson data).
- Rendering Markdown in a way that can execute script (XSS) from file contents.
- Breaking the existing resource flow: a link stays a link, an existing PDF resource keeps its `file_key`, and its notes survive.

## 5. Constraints

- `main` = production, `dev` = test; deploy to `dev` only until the owner says "main now".
- Keep the current discipline: no new dependencies, `npm test` / `typecheck` / `build` / `check:scripts` green, update `docs/CHANGELOG.md` and `docs/HANDOFF.md`.
- Reserved R2 folder names are a precedent: `_resources` (uploaded resource files) and `_notes` (private note images) are already hidden from the course tree and file manager. `RESOURCE` joins them as reserved but **visible and manageable** in the file manager.
- The media gate (`Sec-Fetch-*` browser-header check, per-hour lesson cap, enrollment check) already covers anything served through `/api/media`, so text files inherit it for free.

## 6. Approaches considered

### Feature 2 — how shared resources are created

- **A. Reserved R2 folder `RESOURCE` (chosen).** Upload files into a folder named `RESOURCE`; the server derives the shared list by listing the ancestors' `RESOURCE/` prefixes at read time. No new table, no new screen, works with the existing uploader, and a rename/move/delete in the file manager just works (it is an ordinary R2 prefix). Trade-off: no per-file note/order/rename-in-app; the title is the file name.
- **B. A scope column / new table + a UI toggle ("apply to all lessons in this folder").** More control (title, note, order, per-lesson opt-out), but it needs a new admin screen or a new field in the resource form, new endpoints, and it duplicates what the file manager already does for files. Rejected: heavier for the same outcome, and the owner asked for the folder convention.
- **C. Physically copy a resource into every descendant lesson's D1 rows.** Rejected: duplicated rows, breaks when a new lesson is added, and a delete leaves strays.

### Feature 1 — there is one sensible way

Broaden the existing kind model (`link`/`pdf` → `link`/`pdf`/`txt`/`md`; lessons +`txt`/`md`), reuse the existing PDF/resource infrastructure, and add a small text viewer. No real alternative worth weighing.

## 7. Design

### 7.1 Resource kinds (link · pdf · txt · md)

**DB.** `resources.kind` already holds `'link'` or `'pdf'`; new rows may also be `'txt'` or `'md'`. No migration needed (the column is free text with a default). A file-backed resource is any kind other than `'link'`; its bytes live at `resources.file_key`, exactly as a PDF does today.

**Storage key.** File resources are stored at `<Course>/_resources/<uuid>.<ext>`, where `<ext>` is `pdf`, `txt` or `md` (today it is hard-coded `.pdf`).

**Upload endpoint.** Generalize the existing `POST /api/admin/lesson/<key>/resources/pdf`:
- Match both `…/resources/file` and the legacy `…/resources/pdf` (an already-cached SPA chunk keeps working); the frontend uses `…/resources/file`.
- Accept `.pdf`, `.txt`, `.md` and `.markdown` (`.markdown` maps to kind `md` everywhere, lessons included — see 7.2).
- Validate: PDF keeps the `%PDF-` magic-byte check and the 25 MB cap; TXT/MD must decode as text (reject a body containing a NUL byte) and are capped at 2 MB. Title defaults to the file name without its extension, max 120 chars; optional note max 300 chars.
- Insert with the matching `kind` and `file_key`.

**Read endpoint.** `GET /api/lesson/<key>/resources` returns each row's real `kind` and, for file kinds, `url = file_key` (today it collapses everything non-PDF to `link`).

**Edit.** `PATCH /api/admin/resources/<id>`: only a `link` accepts a new `url`; a file kind edits title and note only (its `file_key` is never replaced) — the current PDF-only rule generalizes to "kind === 'link' is the only editable URL".

**Delete.** Delete the row; for any file kind delete the R2 object; delete the `pdf_notes` row only when the kind is `pdf`.

**Serving.** `serve()` in `worker/index.js` gains `.txt`/`.md` to its allowed-extension regex, and `MEDIA_TYPES` gains `txt: 'text/plain; charset=utf-8'` and `md: 'text/markdown; charset=utf-8'`. They behave like PDFs for range/throttle purposes (no video range requirement); the existing `nosniff` and inline headers stay. A text file served as `text/plain` cannot execute.

**Lesson-lesson bookkeeping in `worker/files.js`.** The rename/move/delete logic already rewrites and copies `resources.file_key` and deletes resource files with their lesson. Generalize its comments/assumptions from "PDFs" to "any file resource" and make sure the extension is preserved when a resource is copied across courses (it copies under `_resources` with a fresh uuid — derive the uuid + original extension).

**Frontend (`lesson-resources.ts`, `api.ts`).**
- `ResourceItem.kind: 'link' | 'pdf' | 'txt' | 'md'` (plus the `shared`/`scope` fields from 7.3).
- The form's mode toggle becomes **Link · File**; the file input `accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"`; title defaults to the file name minus extension; messages and the 2 MB/25 MB caps are chosen by extension.
- Rows render by kind: `link` → `<a target=_blank>`; `pdf` → the existing PDF modal; `txt`/`md` → the new text viewer (7.2). Row icon and the small type label differ per kind.
- The Edit dialog: link shows the URL field; file kinds show the "delete and re-upload to replace" note.
- `uploadResourcePdf` → `uploadResourceFile` (posts to `…/resources/file`).

### 7.2 `txt`/`md` as lessons, and the text viewer

**Course listing (`listCourse`).** Treat `/\.(txt|md|markdown)$/i` as a lesson file in addition to PDF and video. Its `kind` is `'txt'` (`txt`/`text`) or `'md'` (`md`/`markdown`); its title is the file name without extension (`text`/`markdown` are treated exactly like `txt`/`md`). `listCourse` also skips any key that has a `RESOURCE` segment (7.3), like `_resources` today.

**File manager (`worker/files.js`).** `isLessonKey()` also accepts `.txt`/`.md`/`.markdown`, except for keys that live under a `RESOURCE` folder (those carry no per-lesson data). The Admin → Files row gains a text icon; uploads already accept any file type, so text uploads work unchanged.

**Serving.** Covered by the `serve()` change in 7.1 (`MEDIA_TYPES.markdown` added too).

**Viewer (`src/app/text-viewer.ts`, new).** Input `key` (a lesson id or a resource file key) and a `md` boolean. It fetches `/api/media/<key>` (same-origin, so the media gate's `Sec-Fetch-*` check passes), reads the body as text, and renders:
- `txt`: the text in a `<pre>` (HTML-escaped).
- `md`: a small **safe** Markdown renderer (`src/app/markdown.ts`, new, pure + unit-tested): **escape all HTML first**, then support ATX headings, fenced code blocks, unordered/ordered lists, blockquotes, horizontal rules, bold, italic, inline code, and links (only `http:`/`https:`, `rel="noopener noreferrer"`, `target="_blank"`). No raw-HTML passthrough, so file contents can never inject markup.
- Errors (fetch failed / not allowed) show a message with a Retry button, matching the existing viewer's error style.

**Lesson rendering (`course.ts`).** A text lesson opens like a PDF lesson: the standard lesson bar (Back, title, Mark complete) plus the text viewer in the body instead of the PDF viewer. It is markable complete, searchable, and commentable.

**Types.** `Lesson.kind` (and the `Row` kind unions in `course.ts`, `app.ts`, `admin-files.ts`) gain `'txt' | 'md'`. Search results and browser rows get a text/page icon.

### 7.3 Resources on every lesson, and the `RESOURCE` folder

**Resources panel on all lessons (`course.ts`).** Today `app-lesson-panel` is only rendered in the non-PDF branch. Render it for **every** lesson kind: below the video/YouTube player (unchanged two-column ≥1100px layout), and below the PDF/text viewer for those kinds (single column; the viewer area scrolls, then the panel). Discussion/Notes/Resources tabs are the existing shared component; Notes uses `video_notes`, which already works for any lesson key.

**The reserved folder.** A path segment exactly equal to `RESOURCE` (matched case-insensitively) is reserved. The folder that *contains* it is the **scope**:
- `MERN Stack/RESOURCE/*` → scope `MERN Stack` (the whole course).
- `MERN Stack/Module 01/RESOURCE/*` → scope `MERN Stack/Module 01` (that module and anything under it).

A lesson inherits files from **every** ancestor scope on its path. Only `.pdf`, `.txt`, `.md` files inside a `RESOURCE` folder are shared; other file types there are ignored.

There can be as many `RESOURCE` folders as the owner wants — a course-level one acts **global**, a per-module (or deeper) one is **private to that subtree**, and a lesson gets all of them that enclose it:

```
MERN Stack/
  RESOURCE/                  ← global: every lesson in the course
    syllabus.pdf
  Module 01/
    RESOURCE/                ← Module 01 (and anything under it) only
      cheatsheet.md
    Sub/
      RESOURCE/              ← Sub and deeper only
        notes.txt
      01 - Intro.mp4         ← inherits syllabus.pdf + cheatsheet.md + notes.txt
  Module 02/
    02 - Setup.mp4           ← inherits only syllabus.pdf
```

**Read (`GET /api/lesson/<key>/resources`).** After the lesson's own rows, compute the lesson's ancestor prefixes; for each, list `<scope>/RESOURCE/` recursively (`env.RESOURCES.list`, cursor-paged) and emit each eligible file as a synthetic resource:
```
{ id: 'shared:' + fileKey, title: <file name without extension>,
  url: fileKey, note: null, kind: 'pdf' | 'txt' | 'md',
  shared: true, scope: <last scope segment, or the course name for the course level> }
```
Order: the lesson's own resources first (by `created`), then shared ones **nearest scope first**, and within one scope by natural key order.

**Course tree / file manager exclusions.**
- `listCourse`: skip R2 keys whose segments include a `RESOURCE` folder (as `_resources` is skipped now), so a `RESOURCE` folder never becomes a section or lesson. The **YouTube** loop must filter the same way, and `files.js childDirsFromIds` must not invent a `RESOURCE` folder from a YouTube id.
- `files.js listFolder`: still **show** `RESOURCE` folders and their files (so the owner can upload, rename, move and delete them), but mark any file under a `RESOURCE` folder `lesson: false` and keep them out of `isLessonKey`, move/delete student-data migration, and the `_resources` copy rules.
- The banner scan and `_resources`/`_notes` handling are unaffected.

**`RESOURCE` is reserved on writes.** So an ordinary lesson can never be dumped into a shared folder (which would silently remove it from the course tree and orphan its student data):
- `POST /api/admin/youtube` refuses a `{course, folder, lesson}` whose folder or full id contains a `RESOURCE` segment (400), so the Admin → Files **YouTube** button cannot create a lesson there.
- `worker/files.js` move/rename refuses a destination that contains a `RESOURCE` segment, unless the source is already under `RESOURCE` (editing shared files in place stays allowed). This closes the folder-rename/move hole the `isLessonKey` single-file guard already covers for files.
- Deleting a `RESOURCE` folder is allowed (the owner's explicit action); it just removes shared files.

**Frontend (`lesson-resources.ts`).** A `shared` row is read-only for its *metadata*: no pencil/trash (those live in Admin → Files), a small "Shared" tag with its `scope`. Open behaviour by kind: a shared **PDF opens in the full in-app reader with its notes controls**, exactly like a lesson PDF (see the notes guard below); text rows open in the text viewer (view-only). The `count` emitted to the panel includes shared rows.

**Annotations on shared PDFs.** Every PDF is annotatable — lesson PDFs, uploaded resource PDFs, and shared `RESOURCE` PDFs. `pdf_notes` and `note_assets` are keyed by the file path, so a shared PDF's annotations are one document for every lesson that inherits it. Two guards widen to allow it:
- `/api/notes/<key>` and `/api/note-asset/<key>/<id>` accept a `.pdf` key that is (a) under a `RESOURCE` segment, (b) a real object (`env.RESOURCES.head(key)`), and (c) in a course the caller is enrolled in (or the caller is an admin) — alongside the existing lesson and resource-`file_key` checks. The existence check stops a student inventing `.../RESOURCE/anything.pdf` to fill D1.
- `worker/files.js` move/rename of a `RESOURCE` PDF carries its `pdf_notes` and `note_assets` (same as a lesson key), and deleting one removes them, so a shared file's annotations never orphan. Text shared files carry no notes.

## 8. Security review

- Markdown/XSS: escape-first renderer, no raw HTML, link scheme allow-list.
- Text files: served `text/plain`/`text/markdown` with `nosniff`, inline; cannot execute.
- `RESOURCE` folders are ordinary R2 prefixes behind the same `/api/media` enrollment + `Sec-Fetch` gate, so an ungranted student cannot fetch them by direct URL.
- The reserved-name check is applied to the path segments, so `…/RESOURCES/…` or `…/my-resource/…` are ordinary content and never match.

## 9. Testing

- `src/app/markdown.test.mjs`: escaping (`<script>` becomes text), headings, lists, code fences, links (and a `javascript:` link is dropped), bold/italic, paragraphs.
- `worker/resources.test.mjs` (new or extended): upload `.txt`/`.md` (kind + key extension), reject an oversized text and a NUL-containing "text", the legacy `/pdf` path still works, `GET` returns the real kind, `PATCH` ignores a URL for a file kind, `DELETE` removes the object.
- `worker/shared-resources.test.mjs` (new): a `RESOURCE` file is shared with a lesson in its scope and a nested one; a `RESOURCE` folder is not listed as a lesson/section; a file under `RESOURCE` is `isLessonKey === false`; nearest-scope ordering; a non-`RESOURCE` folder with the same files shares nothing; `POST /api/admin/youtube` under a `RESOURCE` folder is refused; a folder move/rename into `RESOURCE` is refused; `/api/notes` round-trips on a real shared PDF key but is refused for an invented `.../RESOURCE/x.pdf`, and `files.js` carries/deletes its `pdf_notes` on move/delete.
- Update existing tests that assert the old kind unions/`isLessonKey` behaviour.
- `npm test`, `npm run typecheck`, `npm run build`, `npm run check:scripts`.
- Live pass on `dev`: upload each of the four kinds on a video lesson; open a `.md` lesson; confirm the panel on a PDF lesson; drop a file in a module `RESOURCE` folder and confirm it appears on every lesson in that module and its subfolders.

## 10. Docs and rollout

- `docs/CHANGELOG.md` and `docs/HANDOFF.md`: new kinds, the reserved `RESOURCE` folder, the text viewer and renderer, and the panel now appearing on all lessons.
- Commit to `dev`; `main` only on the owner's "main now".

## 11. Settled by me (my calls)

- Reserved folder name is exactly `RESOURCE`, matched **case-insensitively** per path segment; documented as reserved.
- TXT/MD resource cap is **2 MB**; PDF stays 25 MB.
- Text lessons use kind `'txt'` / `'md'` (not a single `'text'`), so icons/labels/viewers pick the right one without re-parsing the id.
- The legacy `…/resources/pdf` route is kept as an alias for cached clients; the SPA uses `…/resources/file`.
- Shared resources are read-only for metadata in the lesson panel (managed in Admin → Files) and carry no note/order.
- **Every PDF is annotatable**, including shared `RESOURCE` PDFs. txt/md are view-only (no notes). Shared PDF annotations are keyed by the file, so they are shared across the lessons that inherit it.
- `.markdown` is treated as `md` everywhere (resources, lessons, serving).
- `RESOURCE` is enforced on writes: no YouTube lesson or lesson-bearing file/folder may be moved or created under it.
- Shared ordering is nearest-scope-first; own resources always first.

## 12. Left to the builder

- Exact Markdown subset edge cases (nested lists, mixed emphasis) — the listed subset is the required floor.
- CSS specifics for the PDF/text lesson + panel layout, and the shared-row tag styling.
- Whether the resource form's file input should show the chosen file name (nice-to-have).
