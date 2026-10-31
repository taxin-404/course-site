import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Api, Lesson, ResourceItem } from './api';

/** Links an admin attached to a lesson; students only ever see the list. */
@Component({
  selector: 'app-lesson-resources',
  template: `
    <div class="lr">
      @if (isAdmin()) {
        <form class="lr-form" (submit)="$event.preventDefault(); add()">
          <input
            type="text"
            placeholder="Title (e.g. Slides)"
            aria-label="Resource title"
            maxlength="120"
            [value]="title()"
            (input)="title.set($any($event.target).value)"
          />
          <input
            type="url"
            placeholder="https://…"
            aria-label="Resource link"
            maxlength="800"
            [value]="url()"
            (input)="url.set($any($event.target).value)"
          />
          <input
            type="text"
            placeholder="Optional note"
            aria-label="Resource note"
            maxlength="300"
            [value]="note()"
            (input)="note.set($any($event.target).value)"
          />
          <button class="p" type="submit" [disabled]="saving()">{{ saving() ? 'Adding…' : 'Add resource' }}</button>
        </form>
      }

      @if (error()) { <p class="lr-error" role="alert">{{ error() }}</p> }

      @if (state() === 'loading') {
        <p class="lr-muted">Loading resources…</p>
      } @else if (state() === 'error') {
        <p class="lr-muted">Could not load resources. <button type="button" class="lr-link" (click)="reload()">Retry</button></p>
      } @else if (!rows().length) {
        <p class="lr-muted">No resources for this lesson yet.</p>
      } @else {
        <ul class="lr-list">
          @for (r of rows(); track r.id) {
            <li class="lr-item">
              <span class="lr-icon" aria-hidden="true">🔗</span>
              <div class="lr-body">
                <a class="lr-title" [href]="r.url" target="_blank" rel="noopener noreferrer">{{ r.title }}</a>
                <span class="lr-host">{{ host(r.url) }}</span>
                @if (r.note) { <p class="lr-note">{{ r.note }}</p> }
              </div>
              @if (isAdmin()) {
                <button type="button" class="lr-del" aria-label="Delete resource" title="Delete resource" (click)="remove(r)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                </button>
              }
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class LessonResources {
  private readonly api = inject(Api);
  readonly lesson = input.required<Lesson>();
  readonly count = output<number>();

  protected readonly rows = signal<ResourceItem[]>([]);
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly title = signal('');
  protected readonly url = signal('');
  protected readonly note = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly isAdmin = computed(() => this.api.me()?.is_admin === 1);
  private currentId = '';
  private seq = 0;

  constructor() {
    effect(() => {
      const lesson = this.lesson();
      if (lesson.id === this.currentId) return; // progress toggles hand over a new object
      this.currentId = lesson.id;
      untracked(() => {
        this.title.set('');
        this.url.set('');
        this.note.set('');
        this.error.set('');
        void this.load(lesson.id);
      });
    });
  }

  protected host(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  protected reload(): void { void this.load(this.lesson().id); }

  protected async load(key = this.lesson().id): Promise<void> {
    const seq = ++this.seq;
    this.state.set('loading');
    try {
      const r = await this.api.resources(key);
      if (seq !== this.seq || key !== this.lesson().id) return;
      this.rows.set(r.resources);
      this.state.set('ready');
      this.count.emit(r.resources.length);
    } catch {
      if (seq !== this.seq || key !== this.lesson().id) return;
      this.state.set('error');
    }
  }

  protected async add(): Promise<void> {
    if (this.saving()) return;
    this.error.set('');
    this.saving.set(true);
    try {
      await this.api.addResource(this.lesson().id, {
        title: this.title().trim(),
        url: this.url().trim(),
        note: this.note().trim() || undefined,
      });
      this.title.set('');
      this.url.set('');
      this.note.set('');
      await this.load();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not add that resource.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(r: ResourceItem): Promise<void> {
    if (!confirm(`Remove “${r.title}” from this lesson?`)) return;
    try {
      await this.api.deleteResource(r.id);
      await this.load();
    } catch {
      this.error.set('Could not remove that resource.');
    }
  }
}