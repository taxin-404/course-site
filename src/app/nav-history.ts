import { Injectable, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { isRestoredLoad, readNavIndex, resolveNavIndex, writeNavIndex } from './nav-index';

/** The kind of load the browser performed for this document, when it reports one. */
function navigationType(): string | null {
  const [nav] = performance.getEntriesByType('navigation');
  return nav && 'type' in nav ? String(nav.type) : null;
}

/**
 * Back for the app's own history.
 *
 * The browser owns the stack, so each entry is tagged with its position in
 * `history.state`. A popstate restores the tag (we know where we are); a fresh
 * navigation has no tag, so it becomes the next position. That is just enough to
 * grey out Back at the start without ever leaving the app — the button only ever
 * moves through history, never between lessons.
 *
 * A tag can go missing though: a redirect starts the entry with empty state, and
 * Cloudflare's asset layer 307s a name with brackets, so refreshing a bracketed course
 * or lesson drops it. The position is therefore also remembered per tab, and a refresh
 * picks it back up (see `nav-index`), so Back still leads where it led before.
 */
@Injectable({ providedIn: 'root' })
export class NavHistory {
  private readonly location = inject(Location);
  private readonly router = inject(Router);

  /** Position of the current entry; -1 until this service has seen one. */
  private index = -1;

  /** Whether this document re-showed an entry the browser already had (a refresh). */
  private readonly restored = isRestoredLoad(navigationType());

  readonly canBack = signal(false);

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => this.tag());
  }

  private tag(): void {
    const state = (history.state ?? {}) as Record<string, unknown>;
    const tagged = typeof state['__nav'] === 'number';
    const index = resolveNavIndex({
      stateNav: state['__nav'],
      seenIndex: this.index,
      rememberedIndex: readNavIndex(sessionStorage),
      restored: this.restored,
    });
    if (!tagged) history.replaceState({ ...state, __nav: index }, '');
    this.index = index;
    writeNavIndex(sessionStorage, index);
    this.canBack.set(index > 0);
  }

  back(): void { this.location.back(); }

  /**
   * Leave a temporary screen (the admin panel) without leaving a trail: go back when
   * this document has an earlier entry, otherwise replace the current one with the
   * fallback. That keeps a later Back on the fallback page from returning to the
   * screen that was just dismissed.
   */
  backTo(fallback: string): void {
    if (this.canBack()) this.location.back();
    else void this.router.navigateByUrl(fallback, { replaceUrl: true });
  }
}
