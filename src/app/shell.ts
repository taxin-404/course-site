import { Injectable, computed, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { Api } from './api';
import { LessonSearch } from './lesson-search';
import { NavHistory } from './nav-history';

/**
 * Cross-screen shell state that used to live in the header: which top-level panel
 * is open, whether a lesson is open, and the actions the shared options menu runs.
 * With the router in charge, both are derived from the current URL instead of
 * being toggled by hand.
 */
@Injectable({ providedIn: 'root' })
export class Shell {
  private readonly api = inject(Api);
  private readonly search = inject(LessonSearch);
  private readonly router = inject(Router);
  private readonly nav = inject(NavHistory);

  /** Where "Back to course" returns to; remembered when the admin panel opens. */
  private returnUrl = '/';

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /** The admin panel is open. */
  readonly admin = computed(() => this.url().startsWith('/admin'));
  /** A lesson player is open (the header collapses). */
  readonly lessonOpen = computed(() => /^\/course\/[^/]+\/lesson\//.test(this.url()));
  /** The slim header only exists on the course list and folder browser. */
  readonly headerVisible = computed(() => !this.admin() && !this.lessonOpen());

  toggleAdmin(): void {
    this.search.reset();
    if (this.admin()) {
      // The panel is one history entry (its Users/Files tabs replace the URL), so going
      // back lands on the page that opened it instead of stacking a second copy.
      this.nav.backTo(this.returnUrl);
      this.returnUrl = '/';
    } else {
      this.returnUrl = this.router.url || '/';
      void this.router.navigateByUrl('/admin');
    }
  }

  async signOut(): Promise<void> {
    this.search.reset();
    await this.api.logout();
    void this.router.navigateByUrl('/');
  }

  /** Same local cleanup as signOut(), but ends every session for the account. */
  async signOutEverywhere(): Promise<void> {
    this.search.reset();
    await this.api.logoutEverywhere();
    // admin/lessonOpen derive from the URL, so returning to the list clears them.
    void this.router.navigateByUrl('/');
  }
}
