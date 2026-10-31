import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Api, CourseData, Lesson } from './api';
import { Player } from './player';
import { PdfViewer, prefetchPdfAssets } from './pdf-viewer';

type Row = { kind: 'folder' | 'lesson'; key: string; name: string; depth: number; open?: boolean; done?: number; total?: number; lesson?: Lesson };
type View =
  | { kind: 'browser'; courseTitle: string; path: string[] }
  | { kind: 'player'; lesson: Lesson; courseTitle: string; path: string[] };

@Component({
  selector: 'app-course',
  imports: [Player, PdfViewer],
  template: `
    <div class="layout" [class.home]="!activeCourse()">

      <!-- Sidebar: outline of the open course (folders can be opened and closed) -->
      @if (activeCourse(); as c) {
        <nav class="tree">
          <button class="bc-btn" (click)="home()">← All courses</button>
          <strong class="tree-title">{{ c.title }}</strong>
          <input type="search" placeholder="Search lessons…" [value]="q()" (input)="q.set($any($event.target).value)" />
          @for (r of rows(); track r.key) {
            @if (r.kind === 'folder') {
              <button class="t-row" [style.padding-left.rem]="0.5 + (r.depth > 4 ? 4 : r.depth) * 0.9" (click)="toggleFolder(r.key)">
                <span class="t-caret">{{ r.open ? '▾' : '▸' }}</span><span class="t-name">{{ r.name }}</span><span class="t-count">{{ r.done === r.total ? '✓' : r.done + '/' + r.total }}</span>
              </button>
            } @else {
              <button class="t-row" [class.t-active]="r.key === currentId()" [style.padding-left.rem]="0.5 + (r.depth > 4 ? 4 : r.depth) * 0.9" (click)="openLesson(r.lesson!)">
                <span class="t-caret">{{ r.lesson!.kind === 'pdf' ? '📄' : '🎬' }}</span><span class="t-name">{{ r.name }}</span>@if (r.lesson!.done) { <span class="t-done">✓</span> }
              </button>
            }
          } @empty {
            <p class="empty">Nothing found.</p>
          }
        </nav>
      }

      <!-- Main area -->
      <main>
        @if (view(); as v) {

          <!-- Breadcrumb (browser mode only) -->
          @if (v.kind === 'browser') {
            <div class="breadcrumb" role="navigation" aria-label="Location">
              <span class="bc-sep">./</span>
              <button class="bc-btn" (click)="home()">Courses</button>
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
          <div class="cards">
            @for (c of api.courses(); track c.title) {
              <button class="card" (click)="openCourse(c)">
                <span class="course-name">{{ c.title }}</span>
                <span class="course-count">{{ courseDone(c) }}/{{ courseTotal(c) }} lessons</span>
                <span class="course-bar"><i [style.width.%]="coursePercent(c)"></i></span>
                <span class="card-go">{{ courseDone(c) ? 'Continue →' : 'Start →' }}</span>
              </button>
            } @empty {
              <p class="empty">No courses yet. Ask the admin to give you access.</p>
            }
          </div>
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
    // A student with a single course goes straight into it
    effect(() => { const cs = this.api.courses(); if (cs.length === 1 && !untracked(() => this.view())) this.openCourse(cs[0]); });
  }

  protected readonly q = signal('');
  private readonly open = signal<Set<string>>(new Set());
  protected readonly currentId = computed(() => { const v = this.view(); return v?.kind === 'player' ? v.lesson.id : ''; });

  /** Rows of the sidebar: a folder tree (only open folders show their content), or a flat list while searching. */
  protected readonly rows = computed<Row[]>(() => {
    const c = this.activeCourse();
    if (!c) return [];
    const live = this.api.courses().find((x) => x.title === c.title) ?? c; // fresh "done" marks
    const q = this.q().trim().toLowerCase();
    const out: Row[] = [];
    if (q) {
      for (const s of live.sections) for (const l of s.lessons) {
        if (l.title.toLowerCase().includes(q) || (s.title ?? '').toLowerCase().includes(q)) out.push({ kind: 'lesson', key: l.id, name: l.title, depth: 0, lesson: l });
      }
      return out;
    }
    type N = { path: string; name: string; kids: Map<string, N>; lessons: Lesson[] };
    const root: N = { path: '', name: '', kids: new Map(), lessons: [] };
    for (const s of live.sections) {
      let n = root;
      for (const part of s.title ? s.title.split(' / ') : []) {
        if (!n.kids.has(part)) n.kids.set(part, { path: n.path ? n.path + ' / ' + part : part, name: part, kids: new Map(), lessons: [] });
        n = n.kids.get(part)!;
      }
      n.lessons.push(...s.lessons);
    }
    const count = (n: N): [number, number] => {
      let d = n.lessons.filter((l) => l.done).length, t = n.lessons.length;
      for (const k of n.kids.values()) { const [a, b] = count(k); d += a; t += b; }
      return [d, t];
    };
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });
    const open = this.open();
    const walk = (n: N, depth: number) => {
      for (const k of [...n.kids.values()].sort(byName)) {
        const [done, total] = count(k);
        const isOpen = open.has(k.path);
        out.push({ kind: 'folder', key: k.path, name: k.name, depth, open: isOpen, done, total });
        if (isOpen) walk(k, depth + 1);
      }
      for (const l of n.lessons) out.push({ kind: 'lesson', key: l.id, name: l.title, depth, lesson: l });
    };
    walk(root, 0);
    return out;
  });

  protected toggleFolder(p: string): void {
    this.open.update((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
    this.saveOpen();
  }
  /** Open every folder on the way to a lesson so it shows in the sidebar. */
  private expandTo(path: string[]): void {
    this.open.update((s) => { const n = new Set(s); path.forEach((_, i) => n.add(path.slice(0, i + 1).join(' / '))); return n; });
    this.saveOpen();
  }
  private storeKey = () => 'open:' + (this.activeCourse()?.title ?? '');
  private saveOpen(): void { try { localStorage.setItem(this.storeKey(), JSON.stringify([...this.open()])); } catch { /* storage blocked */ } }
  private loadOpen(): void {
    try { this.open.set(new Set(JSON.parse(localStorage.getItem(this.storeKey()) || '[]'))); } catch { this.open.set(new Set()); }
  }

  protected openLesson(l: Lesson): void {
    const c = this.activeCourse();
    if (!c) return;
    const s = c.sections.find((x) => x.lessons.some((y) => y.id === l.id));
    const path = s?.title ? s.title.split(' / ') : [];
    this.expandTo(path);
    this.view.set({ kind: 'player', lesson: l, courseTitle: c.title, path });
  }

  protected home(): void { this.view.set(null); this.activeCourse.set(null); this.q.set(''); }
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
    this.q.set('');
    this.loadOpen();
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
      if (lesson) { this.expandTo(v.path); this.view.set({ kind: 'player', lesson, courseTitle: v.courseTitle, path: v.path }); }
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
