import { Component, computed, inject, signal } from '@angular/core';
import { Api, CourseData, Lesson } from './api';
import { Player } from './player';
import { PdfViewer, prefetchPdfAssets } from './pdf-viewer';

type View =
  | { kind: 'browser'; courseTitle: string; path: string[] }
  | { kind: 'player'; lesson: Lesson; courseTitle: string; path: string[] };

@Component({
  selector: 'app-course',
  imports: [Player, PdfViewer],
  template: `
    <div class="layout">

      <!-- Sidebar: course list -->
      <nav>
        @for (c of api.courses(); track c.title) {
          <button class="course-btn" [class.active]="activeCourse()?.title === c.title" (click)="openCourse(c)">
            <span class="course-name">{{ c.title }}</span>
            <span class="course-count">{{ courseDone(c) }}/{{ courseTotal(c) }}</span>
            <span class="course-bar"><i [style.width.%]="coursePercent(c)"></i></span>
          </button>
        } @empty {
          <p class="empty">No courses yet.</p>
        }
      </nav>

      <!-- Main area -->
      <main>
        @if (view(); as v) {

          <!-- Breadcrumb (browser mode only) -->
          @if (v.kind === 'browser') {
            <div class="breadcrumb" role="navigation" aria-label="Location">
              <span class="bc-sep">./</span>
              <button class="bc-btn" (click)="view.set(null)">Courses</button>
              <span class="bc-sep">/</span>
              <button class="bc-btn" (click)="goToBreadcrumb(-1)">{{ v.courseTitle }}</button>
              <span class="bc-sep">/</span>
              @for (seg of v.path; track $index; let i = $index) {
                <button class="bc-btn" (click)="goToBreadcrumb(i)">{{ seg }}</button>
                <span class="bc-sep">/</span>
              }
            </div>
          }

          <!-- File browser -->
          @if (v.kind === 'browser') {
            <div class="browser">
              @for (item of browserItems(); track item.id) {
                <button class="fb-item" (click)="onItemClick(item)">
                  <span class="fb-icon">{{ item.kind === 'folder' ? '📁' : item.kind === 'pdf' ? '📄' : '🎬' }}</span>
                  <span class="fb-name">{{ item.name }}</span>
                  @if (item.kind !== 'folder' && item.done) {
                    <span class="fb-done">✓</span>
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
              <button class="bc-btn back-btn" (click)="backToBrowser()">← Back</button>
              <span class="player-title">{{ l.title }}</span>
              <button class="done-btn" [class.p]="!l.done" [class.is-done]="l.done" [attr.aria-pressed]="l.done" (click)="toggle(l)">
                {{ l.done ? '✓ Completed' : 'Mark as complete' }}
              </button>
            </div>
            <div class="player-body">
              @if (l.kind === 'pdf') {
                <app-pdf-viewer [key]="l.id" />
              } @else {
                <app-player [key]="l.id" (ended)="finish(l)" />
              }
            </div>
          }

        } @else {
          <p class="empty">Select a course from the sidebar.</p>
        }
      </main>
    </div>
  `,
})
export class Course {
  protected readonly api = inject(Api);

  constructor() {
    // Fetch the PDF viewer scripts in the background once the page is idle.
    const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1500));
    idle(() => prefetchPdfAssets());
  }
  protected readonly view = signal<View | null>(null);
  protected readonly activeCourse = signal<CourseData | null>(null);

  // Items to show in the browser at the current path
  protected readonly browserItems = computed(() => {
    const v = this.view();
    const course = this.activeCourse();
    if (!v || v.kind !== 'browser' || !course) return [];

    const currentPath = v.path; // e.g. [] = course root, ['Section'] = inside section

    // Collect all lessons and derive folders/files at current depth
    const folders = new Set<string>();
    const files: { id: string; name: string; kind: 'video' | 'pdf'; done: boolean }[] = [];

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
          files.push({ id: l.id, name: l.title, kind: l.kind, done: l.done });
        }
      } else if (depth > 0) {
        // Next folder level
        folders.add(sectionParts[currentPath.length]);
      }
    }

    return [
      ...[...folders].sort().map((f) => ({ id: 'folder:' + f, name: f, kind: 'folder' as const, done: false })),
      ...files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    ];
  });

  protected openCourse(c: CourseData): void {
    this.activeCourse.set(c);
    this.view.set({ kind: 'browser', courseTitle: c.title, path: [] });
  }

  protected onItemClick(item: { id: string; name: string; kind: string; done: boolean }): void {
    const v = this.view();
    if (!v || v.kind !== 'browser') return;

    if (item.kind === 'folder') {
      this.view.set({ kind: 'browser', courseTitle: v.courseTitle, path: [...v.path, item.name] });
    } else {
      // Find the full lesson object
      const lesson = this.api.courses()
        .flatMap((c) => c.sections)
        .flatMap((s) => s.lessons)
        .find((l) => l.id === item.id);
      if (lesson) this.view.set({ kind: 'player', lesson, courseTitle: v.courseTitle, path: v.path });
    }
  }

  protected goToBreadcrumb(index: number): void {
    const v = this.view();
    if (!v || v.kind !== 'browser') return;
    // index -1 = course root, 0 = first segment, etc.
    this.view.set({ kind: 'browser', courseTitle: v.courseTitle, path: v.path.slice(0, index + 1) });
  }

  protected backToBrowser(): void {
    const v = this.view();
    if (v?.kind === 'player') this.view.set({ kind: 'browser', courseTitle: v.courseTitle, path: v.path });
  }

  /** Always the live lesson from app state, so "done" updates immediately. */
  protected readonly lesson = computed(() => {
    const v = this.view();
    if (!v || v.kind !== 'player') return null;
    return this.api.courses().flatMap((c) => c.sections).flatMap((x) => x.lessons).find((x) => x.id === v.lesson.id) ?? v.lesson;
  });

  protected courseTotal(c: CourseData): number {
    return c.sections.reduce((n, s) => n + s.lessons.length, 0);
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
