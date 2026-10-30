import { Component, computed, inject, signal } from '@angular/core';
import { Api, CourseData, Lesson } from './api';
import { Player } from './player';
import { PdfViewer } from './pdf-viewer';

@Component({
  selector: 'app-course',
  imports: [Player, PdfViewer],
  template: `
    <div class="layout">
      <nav>
        @for (c of api.courses(); track c.title) {
          <details [open]="$first">
            <summary>{{ c.title }} ({{ courseDone(c) }}/{{ courseTotal(c) }})</summary>
            <div class="bar"><i [style.width.%]="coursePercent(c)"></i></div>
            @for (s of c.sections; track s.title) {
              @if (s.title) {
                <div class="sec-label">{{ s.title }}</div>
              }
              @for (l of s.lessons; track l.id) {
                <button class="les" [class.on]="l.id === currentId()" (click)="currentId.set(l.id)">
                  <span class="ck">{{ l.done ? '✓' : '' }}</span>
                  <span class="t">{{ l.title }}{{ l.kind === 'pdf' ? ' (PDF)' : '' }}</span>
                </button>
              }
            }
          </details>
        } @empty {
          <p class="empty">No lessons yet. Upload videos or PDFs to the bucket.</p>
        }
      </nav>
      <main>
        @if (lesson(); as l) {
          @if (l.kind === 'pdf') {
            <app-pdf-viewer [key]="l.id" />
          } @else {
            <app-player [key]="l.id" (ended)="finish(l)" />
          }
          <div class="row">
            <h2>{{ l.title }}</h2>
            <button [class.p]="!l.done" (click)="toggle(l)">{{ l.done ? 'Completed ✓' : 'Mark as complete' }}</button>
          </div>
        } @else {
          <p class="empty">Pick a lesson from the list to start.</p>
        }
      </main>
    </div>
  `,
})
export class Course {
  protected readonly api = inject(Api);
  protected readonly currentId = signal<string | null>(null);
  protected readonly lesson = computed<Lesson | undefined>(() =>
    this.api.courses().flatMap((c) => c.sections).flatMap((s) => s.lessons).find((l) => l.id === this.currentId()));

  protected courseTotal(c: CourseData): number { return c.sections.reduce((n, s) => n + s.lessons.length, 0); }
  protected courseDone(c: CourseData): number { return c.sections.reduce((n, s) => n + s.lessons.filter((l) => l.done).length, 0); }
  protected coursePercent(c: CourseData): number { const t = this.courseTotal(c); return t ? (this.courseDone(c) / t) * 100 : 0; }
  protected toggle(l: Lesson): void { void this.api.setDone(l.id, !l.done); }
  protected finish(l: Lesson): void { if (!l.done) this.toggle(l); }
}
