/** How long the one-time PDF notes hint stays on screen. The toast binds this to its bar. */
export const PDF_HINT_MS = 10_000;

const KEY_PREFIX = 'pdf-hint-seen:';

export interface HintStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function hintKey(userId: number | string): string {
  return KEY_PREFIX + userId;
}

/** True when this student has not seen the hint in this browser. */
export function shouldShowHint(store: HintStore, userId: number | string | null | undefined): boolean {
  if (userId === null || userId === undefined || userId === '') return false;
  try { return store.getItem(hintKey(userId)) !== '1'; } catch { return false; }
}

/** Remember that this student has seen the hint; safe when storage is unavailable. */
export function markHintSeen(store: HintStore, userId: number | string): void {
  try { store.setItem(hintKey(userId), '1'); } catch { /* private mode: it just shows once per page */ }
}
