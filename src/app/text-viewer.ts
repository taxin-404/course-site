import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Api } from './api';
import { renderMarkdown } from './markdown';

type State = 'loading' | 'ready' | 'error';

/** Read-only viewer for a `.txt` or `.md` lesson/resource file. */
@Component({
  selector: 'app-text-viewer',
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (state() === 'loading') {
      <p class="lr-muted">Loading...</p>
    } @else if (state() === 'error') {
      <p class="lr-muted">Could not load this file. <button type="button" class="lr-link" (click)="load(key())">Retry</button></p>
    } @else if (md()) {
      <div class="tv-body tv-md" [innerHTML]="html()"></div>
    } @else {
      <pre class="tv-body tv-txt">{{ body() }}</pre>
    }
  `,
})
export class TextViewer {
  private readonly api = inject(Api);
  readonly key = input.required<string>();
  readonly md = input.required<boolean>();
  protected readonly state = signal<State>('loading');
  protected readonly body = signal('');
  /** Escape-first rendering; `renderMarkdown` escapes before it builds any markup. */
  protected readonly html = computed(() => renderMarkdown(this.body()));
  private seq = 0; // newest request wins; an older answer is dropped

  constructor() {
    // Refetch only when the key really changes (not on md(), and not on unrelated updates).
    effect(() => {
      const key = this.key();
      untracked(() => void this.load(key));
    });
  }

  protected async load(key: string): Promise<void> {
    const seq = ++this.seq;
    this.state.set('loading');
    try {
      const res = await fetch(this.api.mediaUrl(key));
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const text = await res.text();
      if (seq !== this.seq || key !== this.key()) return;
      this.body.set(text);
      this.state.set('ready');
    } catch {
      if (seq !== this.seq || key !== this.key()) return;
      this.state.set('error');
    }
  }
}
