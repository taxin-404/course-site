import { Component, computed, inject, signal } from '@angular/core';
import { Api, Lesson, Section } from './api';
import { Player } from './player';
import { PdfViewer } from './pdf-viewer';

@Component({
  selector: 'app-course',
  imports: [Player, PdfViewer],
  template: `
    <div class="layout">
      <nav>
        @for (s of api.course(); track s.title) {
          <details [open]="$first">
            <summary>{{ s.title }} ({{ done(s) }}/{{ s.lessons.length }})</summary>
            <div class="bar"><i [style.width.%]="percent(s)"></i></div>
            @for (l of s.lessons; track l.id) {
              <button class="les" [class.on]="l.id === currentId()" (click)="currentId.set(l.id)">
                <span class="ck">{{ l.done ? '✓' : '' }}</span>
                <span class="t">{{ l.title }}{{ l.kind === 'pdf' ? ' (PDF)' : '' }}</span>
              </button>
            }
          </details>
        } @empty {
          <p class="empty">No lessons yet. Upload HLS folders or PDFs to the bucket.</p>
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
    this.api.course().flatMap((s) => s.lessons).find((l) => l.id === this.currentId()));

  protected done(s: Section): number { return s.lessons.filter((l) => l.done).length; }
  protected percent(s: Section): number { return (this.done(s) / s.lessons.length) * 100; }
  protected toggle(l: Lesson): void { void this.api.setDone(l.id, !l.done); }
  protected finish(l: Lesson): void { if (!l.done) this.toggle(l); }
}
