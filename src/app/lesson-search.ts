import { Injectable, signal } from '@angular/core';

/** A request from the header search for the course component to open something. */
export interface SearchRequest {
  course: string;
  lesson: string | null;
  path: string[];
}

/**
 * The search sits in the app header, so the header and the course screens share
 * one query. The header only renders the field outside the admin panel.
 */
@Injectable({ providedIn: 'root' })
export class LessonSearch {
  readonly query = signal('');
  /** Phone only: the header has expanded into the search field. */
  readonly expanded = signal(false);
  /** Set by the header, consumed by the course component. */
  readonly request = signal<SearchRequest | null>(null);

  open(): void {
    this.expanded.set(true);
  }

  /** Collapsing on a phone also clears the query: a hidden field must not keep filtering. */
  close(): void {
    this.expanded.set(false);
    this.query.set('');
  }

  reset(): void {
    this.expanded.set(false);
    this.query.set('');
    this.request.set(null);
  }
}
