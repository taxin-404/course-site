import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterRenderEffect, computed, inject, signal, viewChild } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Api, CourseData } from './api';
import { Login } from './login';
import { LessonSearch } from './lesson-search';
import { Shell } from './shell';
import { OptionsMenu } from './options-menu';

interface LessonHit {
  id: string;
  title: string;
  kind: 'video' | 'pdf' | 'youtube';
  course: string;
  section: string;
  path: string[];
}

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [Login, OptionsMenu, RouterOutlet],
  host: {
    '[class.no-head]': '!shell.headerVisible()',
    '(document:click)': 'onDocClick($event)',
  },
  template: `
    @if (api.me()) {
      <!-- The header exists only on the course list and folder browser. -->
      @if (shell.headerVisible()) {
        <header [class.searching]="search.expanded()">
          <h2 class="wordmark"><span>Course</span><span>Site.</span></h2>

          <div class="head-search">
            <div class="head-field">
              <svg class="head-mag" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
              <input
                #lessonQ
                type="search"
                placeholder="Search courses and lessons..."
                aria-label="Search courses and lessons"
                [value]="search.query()"
                (input)="search.query.set($any($event.target).value)"
                (keydown.escape)="closeSearch()"
              />
              @if (search.query()) {
                <button type="button" class="head-clear" aria-label="Clear search" (click)="search.query.set(''); lessonQ.focus()">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
                </button>
              }
            </div>
            <button #searchToggle type="button" class="head-toggle" aria-label="Search" [attr.aria-expanded]="search.expanded()" (click)="openSearch()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>
            </button>
            <button type="button" class="head-close" aria-label="Close search" (click)="closeSearch()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>

            @if (search.query().trim()) {
              <div class="head-results" role="listbox" aria-label="Search results">
                @if (courseHits().length) {
                  <p class="hr-label">Courses</p>
                  @for (c of courseHits(); track c.title) {
                    <button type="button" role="option" (click)="openCourseHit(c)">
                      <span class="hr-kind" aria-hidden="true">
                        <svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" /></svg>
                      </span>
                      <span class="hr-text"><span class="hr-name">{{ c.title }}</span></span>
                    </button>
                  }
                }
                @if (lessonHits().length) {
                  <p class="hr-label">Lessons</p>
                  @for (l of lessonHits(); track l.id) {
                    <button type="button" role="option" (click)="openLessonHit(l)">
                      <span class="hr-kind" aria-hidden="true">
                        @if (l.kind === 'pdf') {
                          <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></svg>
                        } @else if (l.kind === 'youtube') {
                          <svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="4" /><path d="m10 9 5 3-5 3z" /></svg>
                        } @else {
                          <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 9 5 3-5 3z" /></svg>
                        }
                      </span>
                      <span class="hr-text">
                        <span class="hr-name">{{ l.title }}</span>
                        <span class="hr-path">{{ l.course }}{{ l.section ? ' / ' + l.section : '' }}</span>
                      </span>
                    </button>
                  }
                }
                @if (!courseHits().length && !lessonHits().length) {
                  <p class="hr-empty">Nothing matches “{{ search.query().trim() }}”.</p>
                }
              </div>
            }
          </div>

          <app-options-menu />
        </header>
      }

      <router-outlet />

      <!-- Back to top: appears once any long section (or the page) is scrolled down. -->
      @if (showTop()) {
        <button type="button" class="to-top" aria-label="Back to top" (click)="goTop()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
        </button>
      }
    } @else if (api.me() === null) {
      @defer (on immediate) {
        <app-login />
      } @placeholder {
        <div class="defer-fill" aria-live="polite">Loading...</div>
      } @error {
        <div class="defer-fill" role="alert">Could not load the sign-in form. Check your connection and try again.</div>
      }
    }
  `,
})
export class App {
  protected readonly api = inject(Api);
  protected readonly search = inject(LessonSearch);
  protected readonly shell = inject(Shell);
  private readonly lessonInput = viewChild<ElementRef<HTMLInputElement>>('lessonQ');
  private readonly searchToggle = viewChild<ElementRef<HTMLButtonElement>>('searchToggle');
  private returnFocus = false;

  /** True while some long section (or the page) is scrolled down, showing the "back to top" button. */
  protected readonly showTop = signal(false);
  /** The scroll container that most recently went past the threshold, if any. */
  private topTarget: HTMLElement | null = null;
  private pageScrolled = false;
  /** Ignore the scroll events produced by our own smooth scroll, so the button doesn't flicker back. */
  private resetting = false;
  private resetTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    void this.api.init();
    // On a phone the header swaps to the full-width field; move focus with it, and
    // hand focus back to the magnifier when the field collapses (after it is visible).
    afterRenderEffect(() => {
      if (this.search.expanded()) {
        this.lessonInput()?.nativeElement.focus();
        return;
      }
      if (this.returnFocus) {
        this.returnFocus = false;
        this.searchToggle()?.nativeElement.focus();
      }
    });
    // Scroll events don't bubble, so listen in the capture phase to see every scrollable
    // section. Only containers marked data-scroll-top (plus the page itself) count.
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    // A session displaced by another device is only discovered by asking the server;
    // re-check when this device comes back to the foreground, so an idle tab notices.
    window.addEventListener('focus', this.onFocus);
    document.addEventListener('visibilitychange', this.onVisible);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('scroll', this.onScroll, { capture: true });
      window.removeEventListener('focus', this.onFocus);
      document.removeEventListener('visibilitychange', this.onVisible);
      clearTimeout(this.resetTimer);
    });
  }

  private readonly onFocus = (): void => { void this.api.refreshMe(); };
  private readonly onVisible = (): void => { if (document.visibilityState === 'visible') void this.api.refreshMe(); };

  private readonly onScroll = (e: Event): void => {
    if (this.resetting) return;
    const doc = document;
    const t = e.target;
    if (t === doc || t === doc.documentElement || t === doc.scrollingElement) {
      this.pageScrolled = (window.scrollY || doc.documentElement.scrollTop || 0) > 280;
      this.topTarget = null;
    } else if (t instanceof HTMLElement && t.dataset['scrollTop'] !== undefined) {
      this.pageScrolled = false;
      if (t.scrollTop > 220) this.topTarget = t;
      else if (this.topTarget === t) this.topTarget = null;
    } else {
      return;
    }
    this.showTop.set(this.pageScrolled || this.topTarget !== null);
  };

  /** Scroll the section the button belongs to — or the page — back to the top. */
  protected goTop(): void {
    const el = this.topTarget;
    this.resetting = true;
    (el ?? window).scrollTo({ top: 0, behavior: 'smooth' });
    this.topTarget = null;
    this.pageScrolled = false;
    this.showTop.set(false);
    clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => (this.resetting = false), 800);
  }

  /** Matching course titles, shown first so a course name still finds the course. */
  protected readonly courseHits = computed<CourseData[]>(() => {
    const q = this.search.query().trim().toLowerCase();
    if (!q) return [];
    return this.api.courses().filter((c) => !c.locked && c.title.toLowerCase().includes(q)).slice(0, 4);
  });

  /** Matching lessons across every course, each labelled with its full location. */
  protected readonly lessonHits = computed<LessonHit[]>(() => {
    const q = this.search.query().trim().toLowerCase();
    if (!q) return [];
    const hits: LessonHit[] = [];
    for (const c of this.api.courses()) {
      for (const s of c.sections) {
        for (const l of s.lessons) {
          if (l.title.toLowerCase().includes(q)) {
            hits.push({
              id: l.id,
              title: l.title,
              kind: l.kind,
              course: c.title,
              section: s.title ?? '',
              path: s.title ? s.title.split(' / ') : [],
            });
          }
        }
      }
    }
    return hits.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })).slice(0, 8);
  });

  protected openSearch(): void {
    this.search.open();
  }

  protected closeSearch(): void {
    if (this.search.expanded()) this.returnFocus = true;
    this.search.close();
  }

  protected openCourseHit(c: CourseData): void {
    this.search.query.set('');
    this.search.expanded.set(false);
    this.search.request.set({ course: c.title, lesson: null, path: [] });
  }

  protected openLessonHit(h: LessonHit): void {
    this.search.query.set('');
    this.search.expanded.set(false);
    this.search.request.set({ course: h.course, lesson: h.id, path: h.path });
  }

  protected onDocClick(e: MouseEvent): void {
    const t = e.target as HTMLElement | null;
    if (this.search.query() && !t?.closest('.head-search')) this.search.query.set('');
  }
}
