/** Where this tab last recorded it stood in the app's own history. */
export const NAV_INDEX_KEY = 'course-site-nav-index';

export interface NavIndexStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The position to record for a history entry, from three things:
 *
 * - what the entry itself says, when it carries a tag — a restored entry knows where it is;
 * - what this document has already seen, when the entry is a fresh navigation — it continues
 *   from the last position;
 * - what the tab remembered, when the browser re-showed an entry it already had (a refresh)
 *   but the tag is missing. A redirect starts the entry with empty state, and Cloudflare's
 *   asset layer 307s a name with brackets, so a bracketed course or lesson loses its tag on
 *   every refresh — without this the app would read the lesson as the start of its history.
 *
 * The first entry of a directly opened tab is position 0, so Back is greyed out at the start.
 */
export function resolveNavIndex(entry: {
  /** `history.state.__nav`, when this entry carries a tag. */
  stateNav: unknown;
  /** Position of the last entry this document tagged; -1 before the first. */
  seenIndex: number;
  /** Position this tab last recorded, or null when it has none. */
  rememberedIndex: number | null;
  /** Whether the browser re-showed an entry it already had rather than navigating afresh. */
  restored: boolean;
}): number {
  if (typeof entry.stateNav === 'number') return entry.stateNav;
  if (entry.seenIndex >= 0) return entry.seenIndex + 1;
  if (entry.restored && entry.rememberedIndex !== null && entry.rememberedIndex > 0) {
    return entry.rememberedIndex;
  }
  return 0;
}

/** The position this tab last recorded, or null when there is none. */
export function readNavIndex(store: NavIndexStore): number | null {
  try {
    const raw = store.getItem(NAV_INDEX_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Record the current position for the next load; safe when storage is unavailable. */
export function writeNavIndex(store: NavIndexStore, index: number): void {
  try {
    store.setItem(NAV_INDEX_KEY, String(index));
  } catch {
    /* private mode: Back just greys out after a refresh */
  }
}

/** Whether the browser re-showed an entry it already had — a refresh or Back/Forward. */
export function isRestoredLoad(navigationType: string | null | undefined): boolean {
  return navigationType === 'reload' || navigationType === 'back_forward';
}
