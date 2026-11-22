// Small pure helpers for the per-student limits. They live in their own module so the
// Worker entry stays readable and the rules can be unit-tested without a D1/R2 environment.

/**
 * The lesson a media request belongs to. HLS parts (`.m3u8`, `.ts`, `.vtt`) are one lesson,
 * named by their folder, so a student opening a single HLS video counts once even though the
 * browser fetches many segments.
 */
export const lessonOf = (key) =>
  /\.(m3u8|ts|vtt)$/i.test(key) ? key.slice(0, key.lastIndexOf('/')) : key;

/** The hour bucket (UTC) used for the distinct-lessons-per-hour limit. */
export const hourBucket = (ms) => Math.floor(ms / 36e5);

/**
 * One step of a per-student token bucket, used to pace a media body. `rate` is bytes per
 * second and `burst` the largest stored credit — the bytes that may flow without waiting.
 * Given the bucket's `tokens` and how long `elapsedMs` has passed since they were read,
 * returns the new credit and how long to wait before sending `bytes`. Pure, so the pacing
 * rule is unit-tested without real timers.
 */
export const pace = (tokens, { rate, burst, bytes, elapsedMs }) => {
  const available = Math.min(burst, tokens + (elapsedMs / 1000) * rate);
  const left = available - bytes;
  if (left >= 0) return { tokens: left, waitMs: 0 };
  const waitMs = Math.min((-left / rate) * 1000, 30000);
  // Waiting refills the bucket by exactly what the wait cost, so the credit returns to zero.
  return { tokens: left + (waitMs / 1000) * rate, waitMs };
};

/**
 * The lesson shape sent to students. It deliberately never carries the YouTube video id:
 * ids are fetched one at a time from `/api/lesson/<id>/yt`, so a single `/api/course`
 * response cannot be scraped for every YouTube id at once. `subtitles` is kept for HLS.
 */
export const publicLesson = (lesson, done, bookmarkedAt) => {
  const out = { id: lesson.id, title: lesson.title, kind: lesson.kind, done: !!done, bookmarked: !!bookmarkedAt };
  if (bookmarkedAt) out.bookmarkedAt = bookmarkedAt;
  if (lesson.subtitles) out.subtitles = lesson.subtitles;
  return out;
};
