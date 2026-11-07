# PDF notes hint — design

**Date:** 2026-11-07
**Status:** proposed

## What we're building

A one-time nudge in the PDF reader that tells a student they can write notes
directly on the PDF, that the notes save automatically, and that they are
private to that student. It stays for about 10 seconds, has a close button, and
shows at most once per student.

## Why

Students may not discover that a PDF can be annotated, or that their notes are
private. The hint teaches the feature once, without nagging.

## Goals

- Appear wherever a PDF is read: a PDF lesson (`course.ts`) and a resource PDF
  modal (`lesson-resources.ts`).
- Say three things: notes are possible, they save automatically, they are
  private to the student.
- Auto-hide after ~10s, with a thin progress bar along the bottom edge of the
  toast draining over the same 10 seconds.
- Use comfortably readable text (the confirmed mockup uses ~1rem).
- A close button dismisses it immediately.
- Show at most once per student.

## Non-goals

- Not a modal; it never blocks reading the PDF.
- No server change — notes already work and are already scoped to the student.
- No change to the PDF.js toolbar, the watermark, or the notes controls.
- No per-scroll or re-show behaviour.

## Approaches considered

1. **Add the hint to the shared `app-pdf-viewer`** (chosen). Both views render
   this one component (`course.ts:113`, `lesson-resources.ts:105`), so a single
   implementation covers "both viewers". Styled in the global `styles.css`.
2. Duplicate the markup in `course.ts` and `lesson-resources.ts`. Rejected: two
   copies drift, and the two views are not really separate components.
3. Reuse the notes-controls status strip. Rejected: it is compact and
   load-bearing (save status), so a tip there is cramped and competes with real
   status text.
4. A blocking modal. Rejected: heavier than a nudge and it interrupts the reader.

**Frequency — the one real choice.** (a) show on every open, (b) once per
student, (c) once per browser session. Chosen: **(b)** — it teaches the feature
once, and the close button then genuinely means "I know this".

## Design

- **Placement:** a small toast at the bottom-centre of the viewer, inside
  `.viewer-wrap` (already `position: relative`), so it floats over the page edge
  and never covers the document. Uses the existing theme variables.
- **Content:** `You can add notes right on this PDF — they're saved automatically
  and only you can see them.` set at ~1rem (larger than the viewer chrome), plus
  a close (×) button labelled "Dismiss".
- **Timing bar:** a 4px accent-coloured bar pinned to the toast's bottom edge
  (the toast clips it with `overflow: hidden`) drains from full to empty over
  10s via a CSS `scaleX` animation; the toast then fades out. The animation is
  (re)started whenever the toast is shown.
- **Behaviour:** on first mount, if the hint has not been shown for the
  signed-in student, show it, start the 10s bar animation and a matching 10s
  timer; when the timer fires, fade the toast out and stop the bar. The close
  button fades it immediately. Showing it (either way) records it as seen, so
  it never appears again.
- **Persistence:** `localStorage['pdf-hint-seen:<userId>'] = '1'`, keyed by the
  signed-in student's id (`Api.me().id`) so it is per student, not per browser.
  If the id is unavailable, skip the hint. Reads/writes are wrapped in
  `try`/`catch` (private-mode storage can throw).
- **Accessibility:** the toast is `role="status"` with `aria-live="polite"` so it
  is announced once; the close button has an accessible label. It is text, not a
  focus trap.
- **Left to the builder:** exact spacing/rounding to match the codebase, and the
  fade duration — follow whatever motion, if any, the rest of the UI uses.

## Verification

- `npm run typecheck`, `npm test`, `npm run build`, `npm run check:scripts`.
- Live, headless, on dev with a throwaway student: fresh storage → the hint
  appears in a PDF lesson with the bar draining and a readable font size; it
  auto-hides after ~10s; a reload does not show it again; and it appears inside
  the resource-PDF modal too. Then remove the throwaway student and any test
  data.
- Production cannot be UI-tested; it is verified by bundle and health checks
  only.
