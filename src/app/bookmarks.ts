import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Api } from './api';
import { BackButton } from './back-button';
import { bookmarkRows, type BookmarkRow } from './bookmark-rows';
import { lessonUrl } from './course-route';

/** The private, newest-first list of lessons this student bookmarked. */
@Component({
  selector: 'app-bookmarks',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [BackButton],
  template: `
    <main data-scroll-top>
      <div class="list">
        <nav class="breadcrumb" aria-label="Location">
          <app-back-button />
          <button class="bc-btn" (click)="home()">Courses</button>
          <span class="bc-sep">/</span>
          <span>Bookmarks</span>
        </nav>
        <h1 class="page-title">Bookmarks</h1>
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
        @for (b of rows(); track b.lesson) {
          <div class="bm-row">
            <button type="button" class="bm-open" (click)="open(b)">
              <span class="row-glyph" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z" /></svg>
              </span>
              <span class="bm-text">
                <span class="row-name">{{ b.title }}</span>
                <span class="bm-path">{{ b.course }}{{ b.section ? ' / ' + b.section : '' }}</span>
              </span>
            </button>
            <button type="button" class="icon-btn bm-remove"
              [attr.aria-label]="'Remove bookmark: ' + b.title" title="Remove bookmark" (click)="remove(b)">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" /></svg>
            </button>
          </div>
        } @empty {
          <p class="empty">No bookmarks yet. Open a lesson and use the bookmark button.</p>
        }
      </div>
    </main>
  `,
})
export class Bookmarks {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly rows = computed(() => bookmarkRows(this.api.courses()));
  protected readonly error = signal('');

  protected open(b: BookmarkRow): void {
    void this.router.navigate(lessonUrl(b.course, b.lesson));
  }

  protected async remove(b: BookmarkRow): Promise<void> {
    this.error.set('');
    try {
      await this.api.setBookmark(b.lesson, false);
    } catch {
      this.error.set('Could not update the bookmark. Please try again.');
    }
  }

  protected home(): void {
    void this.router.navigateByUrl('/');
  }
}
