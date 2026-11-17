/**
 * URL grammar for the course screens, kept free of Angular so it can be unit
 * tested directly:
 *
 *   /course/<course>                     the course root (folder browser)
 *   /course/<course>/folder/<a>/<b>      a folder inside the course
 *   /course/<course>/lesson/<a>/<b>      a lesson player
 *
 * `<course>` is the course's top-level folder name. A lesson id is
 * `<course>/<a>/<b>`, so the URL only carries the part after the course.
 * Folder names never contain a slash (a course is one top-level folder).
 */

export type CourseView =
  | { kind: 'browser'; course: string; path: string[] }
  | { kind: 'player'; course: string; lessonId: string; path: string[] };

const FOLDER = 'folder/';
const LESSON = 'lesson/';

/** Parse the part of the URL after `/course/<course>/`. */
export function parseCourseTail(course: string, tail: string): CourseView {
  if (tail.startsWith(LESSON)) {
    const lessonId = `${course}/${tail.slice(LESSON.length)}`;
    return { kind: 'player', course, lessonId, path: lessonId.split('/').slice(1, -1) };
  }
  const path = tail.startsWith(FOLDER) ? tail.slice(FOLDER.length).split('/').filter(Boolean) : [];
  return { kind: 'browser', course, path };
}

/** Router command for the course root. */
export function courseUrl(course: string): string[] { return ['/course', course]; }

/** Router command for a folder (the root when the path is empty). */
export function folderUrl(course: string, path: readonly string[]): string[] {
  return path.length ? ['/course', course, 'folder', ...path] : ['/course', course];
}

/** Router command for a lesson. */
export function lessonUrl(course: string, lessonId: string): string[] {
  return ['/course', course, 'lesson', ...lessonId.split('/').slice(1)];
}

/**
 * Percent-encode literal brackets in a URL path.
 *
 * Cloudflare's asset layer decodes `%28`/`%29` back to `(`/`)` before the app boots (they are
 * in `encodeURIComponent`'s "safe" set), and Angular reads a raw `(...)` as secondary-outlet
 * syntax — so a course, folder or lesson name that contains brackets is cut at the first one
 * on a reload or a shared link, and the screen comes up empty. The name is opaque text here,
 * so brackets are put back as `%28`/`%29` before the router reads the URL. Already-encoded
 * brackets are left alone, so this is safe to run on any URL.
 */
export function encodeBracketsInPath(path: string): string {
  return path.replace(/\(/g, '%28').replace(/\)/g, '%29');
}
