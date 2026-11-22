# YouTube CSV import: `"no.","name","link"`

Date: 2026-11-23
Status: awaiting approval

## Intent

Admins have spreadsheets whose header is `"no.","name","link"`. The current
importer already accepts that file (it finds the link column and the name column
and ignores the rest), so the file imports, but the `no.` column is thrown away:
lessons land in the folder in file order, then display by their default order.
Two additions make that file the intended format rather than an accident:

1. `no.` becomes the lesson order in the folder.
2. The dialog can hand back a template in exactly that shape.

## Goals

- A file starting `"no.","name","link"` imports with lessons numbered in that
  order, once, in one request.
- Rows without a usable number, or with duplicate numbers, still import in file
  order (the column is never a reason to reject a row).
- A "Download template" control in the dialog produces a file with that header.
- The dialog and README state the format plainly.

## Non-goals

- No per-row course/folder column; a file still targets the folder that is open.
- No new CSV flavour (tabs, semicolons), no server-side file upload.
- No reordering of lessons the admin already arranged by hand beyond appending
  the imported block.

## Anti-goals

- Making `no.` required, or rejecting a file because its numbers are odd.
- One HTTP request per lesson just to set positions.
- Treating an arbitrary numeric column (a year, a row count that repeats) as an
  order and scrambling a folder.

## How it works today

- `src/app/youtube-csv.ts` splits RFC-4180 CSV, detects the link column by its
  YouTube URLs and the name column beside it, and rejects rows with no name, a
  `/` in the name, or a non-YouTube link.
- `src/app/admin-files.ts` previews the parse and then loops
  `POST /api/admin/youtube` once per row.
- Order is `content_order(path, position)`; `setEntryPosition` renumbers a whole
  folder, re-listing R2 each call, so calling it N times is O(N × folder size).

## Approaches

**A. Reorder client-side after the loop.** Keeps the API untouched; calls the
existing order endpoint once per lesson. Rejected: N × (R2 list + folder
renumber) for a 100-row file, and a failed call leaves half-ordered lessons.

**B. One bulk import endpoint (chosen).** `POST /api/admin/youtube` also accepts
`lessons: [{ lesson, link }]`. The server validates every row, inserts them in a
single D1 batch, and — only when the client says the rows are numbered — appends
them to the folder in the given order and writes `content_order` in one pass.
One request, one renumber, all-or-nothing validation.

**C. Template only.** Cheapest, but leaves the `no.` column a lie. Rejected
because the file is the reason for the request.

## Design

### Parser (`src/app/youtube-csv.ts`)

- `CsvRow` gains `no: number | null`.
- After the existing link/name detection, find the numbering column:
  - with a header row, a column whose header normalises to `no`, `nr`, `number`,
    `#`, `order`, `position`, `pos`, `sn`, `s.no` or `sr.no` wins outright;
  - otherwise the leftmost remaining column whose every data cell is an integer
    from 1 to 9999 and whose values are all different.
- If such a column exists, read `no` per row and return `rows` sorted by it. If
  a row is missing a number or two rows share one, ignore the column entirely
  and keep file order (each row's `no` is then `null`).
- Link/name detection and the rejection rules do not change.

### API (`worker/index.js`)

- `POST /api/admin/youtube` accepts either the current object or
  `{ course, folder, lessons: [{ lesson, link }], order: true }`.
- Validation mirrors the parser: course and every lesson name are required, no
  `/`, every link must resolve to a video id (invalid → `400` naming the first
  bad row), reserved segments refused.
- Inserts run as one `env.DB.batch(...)` of upserts.
- With `order: true`: take the folder's current effective order, append the new
  lessons in the order given, write `content_order` 1..N for that folder once.
  Without it, nothing about order changes.
- Response: `{ ok, added, order: boolean, shadowed: string[] }` where `shadowed`
  names lessons whose id is also a real R2 file (checked concurrently, small
  batches).

### Client (`src/app/admin-files.ts`)

- `importCsv` sends one bulk request; toasts added/shadowed counts; reports a
  server error inline instead of per-name failures.
- The dialog shows the format line `"no.","name","link"`, a one-line note that
  `no.` sets the order (blank keeps file order), and a **Download template**
  button that saves `youtube-lessons.csv` with a UTF-8 BOM and the header only.

### Docs

`README.md` §"Adding many at once" documents the header, the order behaviour and
the template.

### Tests

- `src/app/youtube-csv.test.mjs` (new): numbered file sorted; duplicate, missing
  and repeated-value columns fall back to file order; a year and a date column
  are not mistaken for numbers; quoted header; values above 9999 ignored.
- `worker/youtube-bulk.test.mjs` (new): many rows inserted in one call; order
  applied with existing entries preserved and the block appended; invalid row
  rejected with 400 and nothing inserted; non-admin refused.

## Constraints

- D1 writes stay per-folder-once; no change to `setEntryPosition` semantics.
- Single-lesson dialog keeps using the object form.
- Existing exports (`worker/index.js` schema exports) and `worker/entry.js` stay
  as they are.
- `npm test`, `npm run typecheck`, `npm run build` must pass.

## Left to the builder

- Exact header alias list and error wording.
- Whether the template carries a BOM (yes, for Excel) and its filename.
- How many shadow checks run concurrently.
