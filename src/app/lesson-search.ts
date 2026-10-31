import { Injectable, signal } from '@angular/core';

/**
 * The lesson search sits in the app header, so the header and the course browser
 * share one query. The course flips `visible` while its file browser is on screen;
 * the header only renders the field then.
 */
@Injectable({ providedIn: 'root' })
export class LessonSearch {
  readonly query = signal('');
  readonly visible = signal(false);
  /** Phone only: the header has expanded into the search field. */
  readonly expanded = signal(false);

  open(): void {
    this.expanded.set(true);
  }

  /** Collapsing on a phone also clears the query: a hidden field must not keep filtering. */
  close(): void {
    this.expanded.set(false);
    this.query.set('');
  }

  reset(): void {
    this.visible.set(false);
    this.expanded.set(false);
    this.query.set('');
  }
}