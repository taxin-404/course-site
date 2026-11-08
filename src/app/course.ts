import { ChangeDetectionStrategy, Component, computed, effect, inject, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { Api, CourseData, Lesson } from './api';
import { Player } from './player';
import { YtPlayer } from './yt-player';
import { PdfViewer } from './pdf-viewer';
import { LessonSearch } from './lesson-search';
import { LessonPanel } from './lesson-panel';
import { NotesControls } from './notes-controls';
import { BackButton } from './back-button';
import { statusMark, type StatusMark } from './lesson-status';
import { courseUrl, folderUrl, lessonUrl, parseCourseTail, type CourseView } from './course-route';

type View = CourseView;

@Component({
  selector: 'app-course',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [Player, YtPlayer, PdfViewer, LessonPanel, NotesControls, BackButton],
  template: `
    <div class="layout">

      <!-- Main area -->
      <main data-scroll-top>
        @if (view(); as v) {

          <!-- Breadcrumb (browser mode only) -->
          @if (v.kind === 'browser') {
            <nav class="breadcrumb" aria-label="Location">
              <button class="bc-btn" (click)="home()">Courses</button>
              <span class="bc-sep">/</span>
              <button class="bc-btn" (click)="goToBreadcrumb(-1)">{{ v.course }}</button>
              @for (seg of v.path; track $index; let i = $index) {
                <span class="bc-sep">/</span>
                <button class="bc-btn" (click)="goToBreadcrumb(i)">{{ seg }}</button>
              }
            </nav>
            @if (!v.path.length && activeCourse()?.description) {
              <p class="course-intro">{{ activeCourse()!.description }}</p>
            }
          }

          <!-- File browser -->
          @if (v.kind === 'browser') {
            <div class="browser">
              <svg class="fb-defs" aria-hidden="true">
                <defs>
                  <mask id="fb-check-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                    <rect width="24" height="24" fill="#fff" />
                    <path d="m7 12.6 3.2 3.2L17 8" fill="none" stroke="#000" stroke-width="2.4"
                      stroke-linecap="round" stroke-linejoin="round" />
                  </mask>
                </defs>
              </svg>
              @for (item of browserItems(); track item.id) {
                <button class="fb-item" (click)="onItemClick(item)">
                  <span class="fb-pos" aria-hidden="true">{{ item.index }}</span>
                  <span class="fb-icon" aria-hidden="true">
                    @if (item.kind === 'folder') {
                      <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                    } @else if (item.kind === 'pdf') {
                      <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></svg>
                    } @else if (item.kind === 'youtube') {
                      <svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="4" /><path d="m10 9 5 3-5 3z" /></svg>
                    } @else {
                      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 9 5 3-5 3z" /></svg>
                    }
                  </span>
                  <span class="fb-name">{{ item.name }}</span>
                  @if (item.mark !== 'none') {
                    <span class="fb-done" [class.is-done]="item.mark === 'done'" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        @if (item.mark === 'done') {
                          <circle class="disc" cx="12" cy="12" r="10" mask="url(#fb-check-cut)" />
                        } @else {
                          <circle class="ring" cx="12" cy="12" r="10" />
                        }
                      </svg>
                    </span>
                  }
                </button>
              } @empty {
                <p class="empty">This folder is empty.</p>
              }
            </div>
          }

          <!-- Player / PDF viewer -->
          @if (v.kind === 'player' && lesson(); as l) {
            <div class="player-bar">
              <app-back-button />
              <span class="player-title">{{ l.title }}</span>

              <!-- PDF: the notes controls are the same shared component the resource modal uses. -->
              @if (l.kind === 'pdf' && pdfViewer(); as pv) {
                <app-notes-controls [viewer]="pv" />
              }

              <button class="done-btn" [class.p]="!l.done" [class.is-done]="l.done" [attr.aria-pressed]="l.done"
                [attr.aria-label]="l.done ? 'Completed' : 'Mark as complete'"
                [title]="l.done ? 'Completed' : 'Mark as complete'" (click)="toggle(l)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg>
                <span class="lbl">{{ l.done ? 'Completed' : 'Mark as complete' }}</span>
              </button>
            </div>
            <div class="player-body" data-scroll-top>
              @if (l.kind === 'pdf') {
                @defer (on immediate) {
                  <!-- One instance per lesson id: notes and the pending autosave belong to one PDF,
                       so switching documents must destroy the old viewer instead of reusing it. -->
                  @for (id of [l.id]; track id) {
                    <app-pdf-viewer [key]="id" />
                  }
                } @placeholder {
                  <div class="defer-fill" aria-live="polite">Loading viewer…</div>
                } @loading {
                  <div class="defer-fill" aria-live="polite">Loading viewer…</div>
                } @error {
                  <div class="defer-fill" role="alert">Could not load the viewer. Check your connection and try again.</div>
                }
              } @else {
                @defer (on immediate) {
                  @if (l.kind === 'youtube') {
                    <app-yt-player [key]="l.id" />
                  } @else {
                    <app-player [key]="l.id" [subtitles]="l.subtitles ?? []" (ended)="finish(l)" />
                  }
                  <app-lesson-panel data-scroll-top [lesson]="l" />
                } @placeholder {
                  <div class="defer-fill" aria-live="polite">Loading lesson…</div>
                } @loading {
                  <div class="defer-fill" aria-live="polite">Loading lesson…</div>
                } @error {
                  <div class="defer-fill" role="alert">Could not load the lesson. Check your connection and try again.</div>
                }
              }
            </div>
          }

        } @else {
          <div class="list cards">
            <h1 class="page-title">Courses</h1>
            @for (c of courseCards(); track c.title) {
              <button class="course-card" [disabled]="c.locked" (click)="openCourse(c)">
                @if (c.banner) {
                  <img class="card-banner" [src]="c.banner" alt="" loading="lazy" decoding="async" />
                }
                <span class="card-body">
                  <span class="card-head">
                    <span class="row-glyph" aria-hidden="true">
                      <svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" /></svg>
                    </span>
                    <span class="card-title">{{ c.title }}</span>
                  </span>
                  @if (c.description) { <span class="card-desc">{{ c.description }}</span> }
                  <span class="card-foot">
                    @if (courseTotal(c)) {
                      <span class="course-bar" aria-hidden="true"><i [style.width.%]="coursePercent(c)"></i></span>
                    }
                    <span class="card-meta-row">
                      <span class="row-meta">{{ courseDone(c) }}/{{ courseTotal(c) }} lessons</span>
                      <span class="card-cta">{{ c.locked ? 'No access' : (courseDone(c) ? 'Continue' : 'Start') }}</span>
                    </span>
                  </span>
                </span>
              </button>
            } @empty {
              <p class="empty">No courses yet.</p>
            }
          </div>
        }
      </main>
    </div>
  `,
})
export class Course {
  protected readonly api = inject(Api);
  protected readonly search = inject(LessonSearch);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** The route is the source of truth: `/course/<course>[/folder|/lesson/...]`. */
  private readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });

  constructor() {
    // Clear a stale query from the header, but keep a pending search request: this
    // component is deferred, so the header is interactive while its chunk loads and
    // a result clicked in that window must still be honoured.
    this.search.query.set('');
    this.search.expanded.set(false);
    // Warm the PDF viewer chunk and its worker scripts in the background once the
    // page is idle, so the first PDF opens without waiting on the (now lazy) viewer.
    const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
    idle(() => { void import('./pdf-viewer').then((m) => m.prefetchPdfAssets()); });
    // The header search can jump to a course or a lesson from anywhere in the app.
    effect(() => {
      const req = this.search.request();
      if (!req) return;
      this.search.request.set(null);
      const course = this.api.courses().find((c) => c.title === req.course);
      if (!course || course.locked) return;
      this.search.query.set('');
      this.search.expanded.set(false);
      const lesson = req.lesson && course.sections.flatMap((s) => s.lessons).find((l) => l.id === req.lesson);
      void this.router.navigate(lesson ? lessonUrl(course.title, lesson.id) : folderUrl(course.title, req.path));
    });
  }

  /** What the route says is on screen; null means the course list. */
  protected readonly view = computed<View | null>(() => {
    const course = this.params().get('course');
    return course ? parseCourseTail(course, this.params().get('tail') ?? '') : null;
  });

  /** The lesson's PDF viewer, so the lesson bar can drive its notes controls. */
  protected readonly pdfViewer = viewChild(PdfViewer);

  /**
   * The open course, always read live from Api state. Holding the `CourseData`
   * object itself goes stale, because `Api.setDone` replaces course objects
   * immutably — the file list would then miss the "completed" checkmark.
   */
  protected readonly activeCourse = computed<CourseData | null>(() => {
    const course = this.params().get('course');
    return course ? this.api.courses().find((c) => c.title === course) ?? null : null;
  });

  // Courses in the admin's order first, then the rest alphabetically. The server already
  // sorts this list, but the positions can change while the course list is cached.
  protected readonly courseCards = computed<CourseData[]>(() => {
    const order = this.api.order();
    const name = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...this.api.courses()].sort((a, b) => {
      const pa = order[a.title];
      const pb = order[b.title];
      if (pa != null && pb != null) return pa - pb || name.compare(a.title, b.title);
      if (pa != null) return -1;
      if (pb != null) return 1;
      return name.compare(a.title, b.title);
    });
  });

  // Items to show in the browser at the current path
  protected readonly browserItems = computed(() => {
    const v = this.view();
    const course = this.activeCourse();
    if (!v || v.kind !== 'browser' || !course) return [];

    const currentPath = v.path; // e.g. [] = course root, ['Section'] = inside section
    const here = [course.title, ...currentPath].join('/');

    type Row = { id: string; path: string; name: string; kind: 'video' | 'pdf' | 'txt' | 'md' | 'youtube' | 'folder'; done: boolean; mark: StatusMark };
    // A folder shows up in every section below it, so key the rows by path to keep one.
    const rows = new Map<string, Row>();

    for (const section of course.sections) {
      // section.title is the sub-path joined by ' / ', e.g. null, 'Section', 'Section / Sub'
      const sectionParts = section.title ? section.title.split(' / ') : [];

      // Check if this section is at or under currentPath
      const matchesPrefix = currentPath.every((seg, i) => sectionParts[i] === seg);
      if (!matchesPrefix) continue;

      const depth = sectionParts.length - currentPath.length;

      if (depth === 0) {
        // Files directly at this level
        for (const l of section.lessons) {
          rows.set(l.id, { id: l.id, path: l.id, name: l.title, kind: l.kind, done: l.done, mark: statusMark(l.kind, l.done) });
        }
      } else if (depth > 0) {
        // Next folder level
        const name = sectionParts[currentPath.length];
        const path = `${here}/${name}`;
        rows.set(path, { id: 'folder:' + name, path, name, kind: 'folder', done: false, mark: 'none' });
      }
    }

    // Everything in one folder shares one sequence: numbered items first, in the admin's
    // order, then unnumbered ones (folders before files, each by name).
    const order = this.api.order();
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const sorted = [...rows.values()].sort((a, b) => {
      const pa = order[a.path];
      const pb = order[b.path];
      if (pa != null && pb != null) return pa - pb || collator.compare(a.name, b.name);
      if (pa != null) return -1;
      if (pb != null) return 1;
      if (a.kind === 'folder' && b.kind !== 'folder') return -1;
      if (a.kind !== 'folder' && b.kind === 'folder') return 1;
      return collator.compare(a.name, b.name);
    });

    // The number a student sees is the item's place in this folder, so it stays 1..N even
    // for entries the admin never numbered.
    return sorted.map((row, i) => ({ ...row, index: i + 1 }));
  });

  protected home(): void { this.search.reset(); void this.router.navigateByUrl('/'); }

  protected openCourse(c: CourseData): void {
    if (c.locked) return;
    this.search.query.set('');
    this.search.expanded.set(false);
    void this.router.navigate(courseUrl(c.title));
  }

  protected onItemClick(item: { id: string; name: string; kind: string }): void {
    const v = this.view();
    if (!v || v.kind !== 'browser') return;

    if (item.kind === 'folder') {
      void this.router.navigate(folderUrl(v.course, [...v.path, item.name]));
    } else {
      this.search.expanded.set(false);
      void this.router.navigate(lessonUrl(v.course, item.id));
    }
  }

  protected goToBreadcrumb(index: number): void {
    const v = this.view();
    if (!v || v.kind !== 'browser') return;
    // index -1 = course root, 0 = first segment, etc.
    void this.router.navigate(folderUrl(v.course, v.path.slice(0, index + 1)));
  }

  /** Always the live lesson from app state, so "done" updates immediately. */
  protected readonly lesson = computed(() => {
    const v = this.view();
    if (!v || v.kind !== 'player') return null;
    return this.api.courses().flatMap((c) => c.sections).flatMap((x) => x.lessons).find((x) => x.id === v.lessonId) ?? null;
  });

  protected courseTotal(c: CourseData): number {
    // A locked course withholds its sections, so the server publishes the total; without
    // this the card read "0/0" instead of "0/23".
    return c.lessonCount ?? c.sections.reduce((n, s) => n + s.lessons.length, 0);
  }
  protected courseDone(c: CourseData): number {
    return c.sections.reduce((n, s) => n + s.lessons.filter((l) => l.done).length, 0);
  }
  protected coursePercent(c: CourseData): number {
    const t = this.courseTotal(c);
    return t ? (this.courseDone(c) / t) * 100 : 0;
  }
  protected toggle(l: Lesson): void { void this.api.setDone(l.id, !l.done); }
  protected finish(l: Lesson): void { if (!l.done) this.toggle(l); }
}
