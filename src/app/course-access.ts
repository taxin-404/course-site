/**
 * Bulk course access in the Users view: give a course to, or take it from, many
 * users at once. The per-user endpoint replaces the whole list, so the client
 * computes each user's next list from the one they already have. This module is
 * pure (no Angular) so its rules can be checked on their own.
 */

export type AccessMode = 'add' | 'remove';

/**
 * The full course list to send after giving or removing `chosen`.
 * Order is kept (existing first, newly given courses appended) and duplicates
 * never appear, so a bulk give is a union and a bulk remove a difference.
 */
export function applyCourseAccess(current: string[], chosen: string[], mode: AccessMode): string[] {
  const set = new Set(current);
  for (const c of chosen) {
    if (mode === 'add') set.add(c);
    else set.delete(c);
  }
  return [...set];
}
