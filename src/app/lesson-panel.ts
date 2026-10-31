import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { Api, Lesson } from './api';
import { Discussion } from './discussion';
import { LessonResources } from './lesson-resources';

type Tab = 'discussion' | 'notes' | 'resources';

/**
 * The panel under a video lesson. Notes live here because they must be loaded as
 * soon as the lesson opens (not when the tab is first clicked), so an autosave can
 * never run before the existing note has arrived.
 */
@Component({
  selector: 'app-lesson-panel',
  imports: [Discussion, LessonResources],
  template: `
    <section class="lp">
      <div class="lp-tabs" role="tablist" aria-label="Lesson">
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'discussion'" [class.on]="tab() === 'discussion'" (click)="setTab('discussion')">
          Discussion @if (commentCount()) { <span class="lp-badge">{{ commentCount() }}</span> }
        </button>
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'notes'" [class.on]="tab() === 'notes'" (click)="setTab('notes')">Notes</button>
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'resources'" [class.on]="tab() === 'resources'" (click)="setTab('resources')">
          Resources @if (resourceCount()) { <span class="lp-badge">{{ resourceCount() }}</span> }
        </button>
      </div>

      <div class="lp-body">
        <div [hidden]="tab() !== 'discussion'">
          <app-discussion [lesson]="lesson()" (count)="commentCount.set($event)" />
        </div>

        <div class="lp-notes" [hidden]="tab() !== 'notes'">
          <p class="lp-lock">
            <span aria-hidden="true">🔒</span>
            <span class="lp-lock-long">Your notes are private. Only you can see them.</span>
            <span class="lp-lock-short">Private to you</span>
          </p>
          <textarea
            rows="10"
            maxlength="20000"
            placeholder="Your notes for this lesson. Only you can see them."
            aria-label="Your private notes for this lesson"
            [value]="note()"
            (input)="onInput($any($event.target).value)"
            (blur)="flush()"
          ></textarea>
          <p class="lp-status" [class.bad]="noteStatus() === 'error'">{{ statusText() }}</p>
        </div>

        <div [hidden]="tab() !== 'resources'">
          <app-lesson-resources [lesson]="lesson()" (count)="resourceCount.set($event)" />
        </div>
      </div>
    </section>
  `,
})
export class LessonPanel {
  private readonly api = inject(Api);
  readonly lesson = input.required<Lesson>();

  protected readonly tab = signal<Tab>('discussion');
  protected readonly commentCount = signal(0);
  protected readonly resourceCount = signal(0);

  protected readonly note = signal('');
  protected readonly noteStatus = signal<'idle' | 'saving' | 'saved' | 'error'>('idle');

  /** The lesson the loaded note belongs to; '' until its GET has resolved. */
  private loadedKey = '';
  /** True when the user typed before this lesson's note arrived; their text wins. */
  private typedWhileLoading = false;
  /** The lesson id the panel is currently showing, so a new Lesson object with the
   *  same id (progress toggles do that) does not reload and clear the textarea. */
  private currentId = '';
  /** False until the note has loaded (or the user typed after a failed load), so a
   *  failed GET can never cause a flush that deletes the saved note. */
  private canSave = false;
  private savedText = '';
  private seq = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      const lesson = this.lesson();
      if (lesson.id === this.currentId) return; // same lesson, new object: keep the panel as is
      this.currentId = lesson.id;
      untracked(() => {
        this.flush(); // finish the previous lesson's pending edit against its own key
        void this.load(lesson.id);
      });
    });
    inject(DestroyRef).onDestroy(() => this.flush());
  }

  protected setTab(next: Tab): void {
    if (next === this.tab()) return;
    if (this.tab() === 'notes') this.flush();
    this.tab.set(next);
  }

  protected statusText(): string {
    switch (this.noteStatus()) {
      case 'saving': return 'Saving…';
      case 'saved': return 'Saved';
      case 'error': return 'Could not save. Your text is still here — try again.';
      default: return '';
    }
  }

  protected onInput(value: string): void {
    this.note.set(value);
    clearTimeout(this.timer);
    if (!this.loadedKey) {
      // Still loading this lesson's note. Remember that the box now holds newer text
      // than the fetch will return, so the fetch cannot overwrite it.
      this.typedWhileLoading = true;
      return;
    }
    this.canSave = true;
    this.noteStatus.set('saving');
    this.timer = setTimeout(() => void this.save(), 800);
  }

  /** Save whatever is pending, if anything, against the lesson it was typed for. */
  protected flush(): void {
    clearTimeout(this.timer);
    const key = this.loadedKey;
    const text = this.note();
    if (!key || !this.canSave || text === this.savedText) return;
    this.noteStatus.set('saving');
    void this.api.saveVideoNotes(key, text)
      .then(() => {
        // Only record success: a failed flush must be retried by the next one.
        if (key === this.loadedKey) {
          this.savedText = text;
          this.noteStatus.set(this.note() === text ? 'saved' : 'saving');
          if (this.note() !== text) this.schedule();
        }
      })
      .catch(() => { if (key === this.loadedKey) this.noteStatus.set('error'); });
  }

  private async save(): Promise<void> {
    const key = this.loadedKey;
    if (!key || !this.canSave) return;
    const text = this.note();
    if (text === this.savedText) {
      this.noteStatus.set(text ? 'saved' : 'idle');
      return;
    }
    this.noteStatus.set('saving');
    try {
      await this.api.saveVideoNotes(key, text);
      this.savedText = text;
      if (key === this.loadedKey) this.noteStatus.set(this.note() === text ? 'saved' : 'saving');
      if (key === this.loadedKey && this.note() !== text) this.schedule();
    } catch {
      if (key === this.loadedKey) this.noteStatus.set('error');
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), 800);
  }

  private async load(key: string): Promise<void> {
    const seq = ++this.seq;
    this.loadedKey = '';
    this.savedText = '';
    this.typedWhileLoading = false;
    this.canSave = false;
    this.note.set('');
    this.noteStatus.set('idle');
    try {
      const r = await this.api.videoNotes(key);
      if (seq !== this.seq) return;
      this.loadedKey = key;
      this.savedText = r.body;
      this.canSave = true;
      if (this.typedWhileLoading) {
        // Keep what the user typed while the GET was in flight and save that instead.
        this.noteStatus.set('saving');
        this.schedule();
      } else {
        this.note.set(r.body);
        if (r.body) this.noteStatus.set('saved');
      }
    } catch {
      if (seq !== this.seq) return;
      // Keep the box usable after a failed load. Saving stays off unless the user
      // typed something, so leaving the lesson cannot delete an unread note.
      this.loadedKey = key;
      this.noteStatus.set('error');
      if (this.typedWhileLoading) {
        this.canSave = true;
        this.noteStatus.set('saving');
        this.schedule();
      }
    }
  }
}