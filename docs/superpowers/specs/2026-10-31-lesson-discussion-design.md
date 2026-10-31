# Lesson discussion, private notes and resources

Date: 2026-10-31
Status: proposed

## Intent

A video lesson is currently a dead end: you watch it, mark it complete, and leave.
Students have nowhere to ask a question about what they just saw, nowhere to keep
their own notes in one place, and no way to find the links a lesson refers to.

This adds a panel under a video with three tabs:

- **Discussion** — threaded comments, like X: post, reply, like, delete.
- **Notes** — a private area where the signed-in student writes their own notes,
  saved automatically. Nobody else can read them.
- **Resources** — links and short descriptions that an admin attaches to the
  lesson (slides, repos, references).

It applies to video lessons only. PDF lessons keep the existing annotation notes
and get none of these tabs.

## Goals

- Ask and answer questions under the exact lesson they belong to.
- Keep personal notes per lesson, private, saved without a save button.
- Give admins one place to attach the links a lesson refers to.
- Feel native to the current theme: filled surfaces, soft shadows, no hairline
  strokes; 44px touch targets on phones.

## Non-goals

- No notifications, mentions, follows or reposts.
- No editing a comment after posting (delete and repost instead).
- No moderation queue or reporting; admins can delete any comment.
- No comments on PDF lessons, no resources attached to a course or section.
- No rich text: links in comments stay plain text.
- No real-time updates; the list refreshes when the tab is opened.

## Data model (D1, created in `ensureSchema` like the existing tables)

```sql
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson TEXT NOT NULL,             -- R2 key, same id the player uses
  user_id INTEGER NOT NULL,
  parent_id INTEGER,                -- NULL = top level; else the top-level comment
  body TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_lesson ON comments(lesson, created);

CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS video_notes (
  user_id INTEGER NOT NULL,
  lesson TEXT NOT NULL,
  body TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (user_id, lesson)
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  note TEXT,
  created_by INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_lesson ON resources(lesson, created);
```

Deleting a user already deletes `watched` and `pdf_notes`; it must now also delete
their comments, their likes and their `video_notes`. Resources they authored are
kept: lesson content outlives the admin who added it.

Deleting a top-level comment removes its replies and the likes on the comment and
on each reply, so no `comment_likes` rows are left pointing at deleted ids.

## API

All routes require a session and run the existing `me()` lookup.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/lesson/:key/comments` | – | `{ comments: [...] }` |
| POST | `/api/lesson/:key/comments` | `{ body, parent? }` | `{ comment }` |
| POST | `/api/comments/:id/like` | – | `{ liked, likes }` |
| DELETE | `/api/comments/:id` | – | `{ ok: true }` |
| GET | `/api/lesson/:key/notes` | – | `{ body }` |
| PUT | `/api/lesson/:key/notes` | `{ body }` | `{ ok: true }` |
| GET | `/api/lesson/:key/resources` | – | `{ resources: [...] }` |
| POST | `/api/admin/lesson/:key/resources` | `{ title, url, note? }` | `{ resource }` |
| DELETE | `/api/admin/resources/:id` | – | `{ ok: true }` |

A comment row is:

```json
{ "id": 12, "parent_id": null, "body": "…", "created": 1761900000000,
  "name": "taxin", "initial": "T", "likes": 3, "liked": true,
  "own": true, "can_delete": true }
```

### Access and validation

- `lesson` must exist in the bucket: it is looked up through the cached
  `listCourse()` result, matching the lesson `id` exactly. Unknown keys are `404`.
- The caller must be able to see that course: admins always can, students need an
  `enrollments` row for the first path segment. Otherwise `403`. This check runs
  on every route, including notes and likes, so a key cannot be used to peek.
- Comment body: trimmed, 1–1000 characters, control characters stripped.
  Rendering uses Angular interpolation, which escapes HTML; no `innerHTML`.
- `parent` must be a top-level comment on the same lesson; replies cannot nest
  further than one level.
- Rate limit: at most 10 comments per user per 5 minutes (counted from
  `comments.created`), answered with `429` and a plain message.
- Resource title 1–120, URL 1–800 and must parse as `http:`/`https:`, note ≤ 300.
  At most 100 resources per lesson. Admin only.
- Notes body ≤ 20 000 characters.
- `GET …/comments` returns every comment for the lesson, capped at the 500 most
  recent rows as a guard; the tabs' badges count what was returned.
- Names shown to other students are the local part of the email (before `@`);
  the full address stays visible only in the admin panel.

## UI

The panel lives inside `.player-body`, directly under the video, so the existing
scroll container handles it; PDF layout is untouched.

```
[← Back]  Lesson title                    [Mark as complete]
+-------------------------- video --------------------------+
[ Discussion 4 | Notes | Resources 2 ]
… active tab …
```

Tabs are buttons with `aria-pressed`; the active one uses the accent fill. The
panel is a rounded surface (`--panel`, `--shadow`), 14px radius, no border.

### Discussion

- Composer: avatar circle (initial), textarea "Ask a question or leave a comment…",
  a character counter that appears past 900, and a **Post** button, disabled while
  empty or posting. `Ctrl/Cmd+Enter` posts.
- List: newest first. Each item is avatar, name, relative time ("2h", "3d"),
  body, then `♡ 3` (filled when liked), `Reply`, and a delete `×` for the author
  or an admin (confirmation first).
- One reply level, indented under its parent, oldest first, with
  "Show 3 replies" when collapsed. Replies use the same composer inline.
- Empty state: "No comments yet. Start the discussion."
- Deleting a comment with replies deletes the replies too; the confirmation says so.
- After posting, the new comment is fetched with the list (no optimistic fake rows).

### Notes

- The note is loaded when the lesson opens, not when the tab is first clicked, so
  an autosave can never beat the initial `GET` and blank out existing text.
- A plain textarea (`min-height: 220px`) with a small status line:
  "Saved", "Saving…", "Could not save". Saves 800 ms after the last keystroke,
  and again on tab switch or leaving the lesson.
- Every pending save remembers the lesson key it belongs to. Switching lessons
  flushes the pending edit against the old key first, then loads the new lesson's
  note; a save is never issued against the wrong lesson.
- Placeholder: "Your notes for this lesson. Only you can see them."
- The header line mirrors the PDF notes bar: muted lock note, "Private to you"
  on phones.

### Resources

- Each row: title (link, opens in a new tab with `noopener noreferrer`), the
  hostname in muted text, and the optional note underneath.
- Empty state: "No resources for this lesson yet."
- Admins additionally see an inline "Add resource" form (title, URL, note) and a
  delete icon per row. Students never see those controls.
- Admins see the same form regardless of which tab is active? No — only inside
  the Resources tab.

### Phones (≤760px)

- Tabs fill the width, 44px tall, labels only.
- Composer stacks: textarea full width, Post button full width below it.
- Comment text wraps; actions stay on one row; the delete `×` is 44×44.
- The panel uses the page gutter (`.8rem`), matching the rest of the mobile layout.

### Loading and errors

- On opening a lesson, comments and resources load in the background; tabs show
  their counts once loaded.
- A failed load shows "Could not load comments." with a **Retry** button.
- Failed post/save keeps the text in the box and shows the server message.

## What I decided (my calls, easy to change)

1. One reply level, newest-first top level, replies oldest-first.
2. No comment editing in the first version.
3. Likes are a simple toggle, allowed on your own comment too.
4. Students see only the local part of another student's email.
5. Notes are plain text, not timestamped markers or markdown.
6. The admin resource form sits in the Resources tab rather than the admin panel,
   so a resource is added while looking at the lesson it belongs to.

## Testing

There is no test runner in this repo (`package.json` has no test script, the
Angular project has no test target), so verification is done against
`wrangler dev` and the browser rather than pretending otherwise:

- Worker, with a scripted `curl` pass against local D1: access control
  (non-enrolled key → 403, admin → 200, unknown key → 404), reply parent
  validation, rate limit, URL validation, cascade delete of replies and likes,
  notes isolation between two users, and the 500-row guard.
- UI: post → reply → like → delete; notes autosave, reload, and switching lessons
  mid-edit without losing or cross-writing text; admin add/delete resource;
  student cannot see admin controls; phone layout at 393px and 320px.
- Regression: PDF lessons show none of the new UI and their annotation notes
  still save.