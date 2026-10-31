import { Component, ElementRef, afterRenderEffect, computed, inject, signal, viewChild } from '@angular/core';
import { Api, CourseData } from './api';
import { Login } from './login';
import { Course } from './course';
import { Admin } from './admin';
import { LessonSearch } from './lesson-search';

interface LessonHit {
  id: string;
  title: string;
  kind: 'video' | 'pdf';
  course: string;
  section: string;
  path: string[];
}

@Component({
  selector: 'app-root',
  imports: [Login, Course, Admin],
  host: {
    '(document:click)': 'onDocClick($event)',
    '(document:keydown.escape)': 'closeMenu()',
  },
  template: `
    @if (api.me(); as me) {
      <header [class.searching]="search.expanded()">
        <h2 class="logo">Course</h2>

        @if (!admin()) {
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
                      <span class="hr-kind" aria-hidden="true">📚</span>
                      <span class="hr-text"><span class="hr-name">{{ c.title }}</span></span>
                    </button>
                  }
                }
                @if (lessonHits().length) {
                  <p class="hr-label">Lessons</p>
                  @for (l of lessonHits(); track l.id) {
                    <button type="button" role="option" (click)="openLessonHit(l)">
                      <span class="hr-kind" aria-hidden="true">{{ l.kind === 'pdf' ? '📄' : '🎬' }}</span>
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
        }

        <div class="head-actions">
          @if (me.is_admin) {
            <button (click)="toggleAdmin()">{{ admin() ? 'Back to course' : 'Admin panel' }}</button>
          }
          <button (click)="signOut()">Sign out</button>
        </div>

        <button
          type="button"
          class="head-burger"
          [attr.aria-label]="menuOpen() ? 'Close account menu' : 'Open account menu'"
          [attr.aria-expanded]="menuOpen()"
          (click)="toggleMenu()"
        >
          @if (menuOpen()) {
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          } @else {
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          }
        </button>

        <div class="head-menu" [class.open]="menuOpen()" role="menu" aria-label="Account">
          @if (me.is_admin) {
            <button type="button" role="menuitem" (click)="toggleAdmin()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" /></svg>
              {{ admin() ? 'Back to course' : 'Admin panel' }}
            </button>
          }
          <button type="button" role="menuitem" (click)="signOut()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v16h-6" /><path d="m10 8-4 4 4 4" /><path d="M6 12h10" /></svg>
            Sign out
          </button>
        </div>
      </header>
      @if (admin() && me.is_admin) { <app-admin /> } @else { <app-course /> }
    } @else if (api.me() === null) {
      <app-login />
    }
  `,
})
export class App {
  protected readonly api = inject(Api);
  protected readonly search = inject(LessonSearch);
  protected readonly admin = signal(false);
  protected readonly menuOpen = signal(false);
  private readonly lessonInput = viewChild<ElementRef<HTMLInputElement>>('lessonQ');
  private readonly searchToggle = viewChild<ElementRef<HTMLButtonElement>>('searchToggle');
  private returnFocus = false;

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
  }

  /** Matching course titles, shown first so a course name still finds the course. */
  protected readonly courseHits = computed<CourseData[]>(() => {
    const q = this.search.query().trim().toLowerCase();
    if (!q) return [];
    return this.api.courses().filter((c) => c.title.toLowerCase().includes(q)).slice(0, 4);
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
    this.menuOpen.set(false);
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

  protected toggleMenu(): void {
    const open = !this.menuOpen();
    this.menuOpen.set(open);
    if (open) {
      this.search.query.set('');
      this.search.expanded.set(false);
    }
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  protected toggleAdmin(): void {
    this.menuOpen.set(false);
    this.search.query.set('');
    this.search.expanded.set(false);
    this.admin.set(!this.admin());
  }

  protected onDocClick(e: MouseEvent): void {
    const t = e.target as HTMLElement | null;
    if (this.menuOpen() && !t?.closest('.head-menu, .head-burger')) this.menuOpen.set(false);
    if (this.search.query() && !t?.closest('.head-search')) this.search.query.set('');
  }

  protected async signOut(): Promise<void> {
    this.menuOpen.set(false);
    this.admin.set(false);
    this.search.reset();
    await this.api.logout();
  }
}