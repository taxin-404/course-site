import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { Api, Lesson, ResourceItem } from './api';
import { PdfViewer } from './pdf-viewer';
import { TextViewer } from './text-viewer';
import { NotesControls } from './notes-controls';

/** Links and files (PDF/TXT/MD) an admin attached to a lesson; students only ever see the list. */
@Component({
  selector: 'app-lesson-resources',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [PdfViewer, TextViewer, NotesControls],
  template: `
    <div class="lr">
      @if (isAdmin()) {
        <form class="lr-form" (submit)="$event.preventDefault(); mode() === 'link' ? add() : upload()">
          <div class="seg lr-mode" role="group" aria-label="Resource type">
            <button type="button" [class.on]="mode() === 'link'" [attr.aria-pressed]="mode() === 'link'" (click)="setMode('link')">Link</button>
            <button type="button" [class.on]="mode() === 'pdf'" [attr.aria-pressed]="mode() === 'pdf'" (click)="setMode('pdf')">PDF</button>
            <button type="button" [class.on]="mode() === 'txt'" [attr.aria-pressed]="mode() === 'txt'" (click)="setMode('txt')">TXT</button>
            <button type="button" [class.on]="mode() === 'md'" [attr.aria-pressed]="mode() === 'md'" (click)="setMode('md')">MD</button>
          </div>
          <input
            type="text"
            placeholder="Title (e.g. Slides)"
            aria-label="Resource title"
            maxlength="120"
            [value]="title()"
            (input)="title.set($any($event.target).value)"
          />
          @if (mode() === 'link') {
            <input
              type="url"
              placeholder="https://..."
              aria-label="Resource link"
              maxlength="800"
              [value]="url()"
              (input)="url.set($any($event.target).value)"
            />
          } @else {
            <input
              #fileInput
              type="file"
              [attr.accept]="mode() === 'pdf' ? 'application/pdf,.pdf' : mode() === 'txt' ? 'text/plain,.txt' : 'text/markdown,.md,.markdown'"
              [attr.aria-label]="mode() === 'pdf' ? 'PDF file' : mode() === 'txt' ? 'Text file' : 'Markdown file'"
              (change)="pick($event)"
            />
          }
          <input
            type="text"
            placeholder="Optional note"
            aria-label="Resource note"
            maxlength="300"
            [value]="note()"
            (input)="note.set($any($event.target).value)"
          />
          <button class="p" type="submit" [disabled]="saving()">
            {{ saving() ? (mode() === 'link' ? 'Adding...' : 'Uploading...') : (mode() === 'link' ? 'Add resource' : 'Upload ' + mode().toUpperCase()) }}
          </button>
        </form>
      }

      @if (error()) { <p class="lr-error" role="alert">{{ error() }}</p> }

      @if (state() === 'loading') {
        <p class="lr-muted">Loading resources...</p>
      } @else if (state() === 'error') {
        <p class="lr-muted">Could not load resources. <button type="button" class="lr-link" (click)="reload()">Retry</button></p>
      } @else if (!rows().length) {
        <p class="lr-muted">No resources for this lesson yet.</p>
      } @else {
        <ul class="lr-list">
          @for (r of rows(); track r.id) {
            <li class="lr-item">
              <span class="lr-icon" aria-hidden="true">
                @if (r.kind === 'link') {
                  <svg viewBox="0 0 24 24"><path d="M9.5 14.5 14.5 9.5" /><path d="M11 7l1.8-1.8a4 4 0 0 1 5.6 5.6L16.6 12.6" /><path d="M13 17l-1.8 1.8a4 4 0 0 1-5.6-5.6L7.4 11.4" /></svg>
                } @else {
                  <svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4v13H7z" /><path d="M14 3.5v4h4" /><path d="M9.5 12.5h5M9.5 16h5" /></svg>
                }
              </span>
              <div class="lr-body">
                @if (r.kind === 'link') {
                  <a class="lr-title" [href]="r.url" target="_blank" rel="noopener noreferrer">{{ r.title }}</a>
                  <span class="lr-host">{{ host(r.url) }}</span>
                } @else {
                  <button type="button" class="lr-title lr-open" (click)="open(r)">{{ r.title }}</button>
                  <span class="lr-host">{{ r.kind.toUpperCase() }}</span>
                }
                @if (r.note) { <p class="lr-note">{{ r.note }}</p> }
              </div>
              @if (isAdmin() && !r.shared) {
                <span class="lr-tools">
                  <button type="button" class="lr-edit" aria-label="Edit resource" title="Edit resource" (click)="edit(r)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13 7 4 4" /></svg>
                  </button>
                  <button type="button" class="lr-del" aria-label="Delete resource" title="Delete resource" (click)="remove(r)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                  </button>
                </span>
              } @else if (r.shared) {
                <span class="lr-shared">Shared · {{ r.scope }}</span>
              }
            </li>
          }
        </ul>
      }

      @if (opened(); as r) {
        @defer (on immediate) {
          <div class="lr-viewer" role="dialog" aria-modal="true" [attr.aria-label]="r.title">
            <!-- The lesson bar a PDF lesson shows (see course.ts), minus the complete button:
                 Back closes the modal and the shared notes controls stay in reach. -->
            <div class="player-bar">
              <button #backBtn type="button" class="back-btn" aria-label="Back" title="Back" (click)="close()">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
                <span class="lbl">Back</span>
              </button>
              <span class="player-title">{{ r.title }}</span>
              @if (r.kind === 'pdf' && pdfViewer(); as pv) { <app-notes-controls [viewer]="pv" /> }
            </div>
            @if (r.kind === 'pdf') {
              <app-pdf-viewer [key]="r.url" />
            } @else {
              <app-text-viewer [key]="r.url" [md]="r.kind === 'md'" />
            }
          </div>
        } @placeholder {
          <div class="lr-viewer lr-viewer-loading" aria-live="polite">Loading...</div>
        } @error {
          <div class="lr-viewer lr-viewer-loading" role="alert">
            Could not load this file. <button type="button" class="lr-link" (click)="close()">Close</button>
          </div>
        }
      }

      @if (editing(); as r) {
        <div class="adm-scrim" (click)="closeEdit()"></div>
        <div class="adm-dialog" role="dialog" aria-modal="true" aria-labelledby="lr-edit-title">
          <header class="adm-dialog-top">
            <h3 id="lr-edit-title">Edit resource</h3>
            <button type="button" class="adm-close" aria-label="Close" (click)="closeEdit()">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
            </button>
          </header>
          <div class="adm-form">
            <label class="field">
              <span>Title</span>
              <input #editTitleInput [value]="editTitle()" (input)="editTitle.set($any($event.target).value)" maxlength="120" autocomplete="off" spellcheck="false" />
            </label>
            @if (r.kind === 'link') {
              <label class="field">
                <span>Link</span>
                <input type="url" [value]="editUrl()" (input)="editUrl.set($any($event.target).value)" maxlength="800" autocomplete="off" spellcheck="false" placeholder="https://..." />
              </label>
            } @else {
              <p class="adm-muted sm">To replace this file, delete it and upload a new one.</p>
            }
            <label class="field">
              <span>Note</span>
              <input [value]="editNote()" (input)="editNote.set($any($event.target).value)" maxlength="300" autocomplete="off" spellcheck="false" placeholder="Optional note" />
            </label>
            @if (editError()) { <p class="files-error">{{ editError() }}</p> }
          </div>
          <footer class="adm-dialog-foot">
            <button type="button" (click)="closeEdit()">Cancel</button>
            <button type="button" class="p" [disabled]="editBusy()" (click)="saveEdit()">{{ editBusy() ? 'Saving...' : 'Save' }}</button>
          </footer>
        </div>
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
  protected readonly mode = signal<'link' | 'pdf' | 'txt' | 'md'>('link');
  protected readonly file = signal<File | null>(null);
  protected readonly opened = signal<ResourceItem | null>(null);
  protected readonly editing = signal<ResourceItem | null>(null);
  protected readonly editTitle = signal('');
  protected readonly editUrl = signal('');
  protected readonly editNote = signal('');
  protected readonly editError = signal('');
  protected readonly editBusy = signal(false);
  protected readonly editTitleInput = viewChild<ElementRef<HTMLInputElement>>('editTitleInput');
  /** The viewer inside the modal, so its header can render the shared notes controls. */
  protected readonly pdfViewer = viewChild(PdfViewer);
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly backBtn = viewChild<ElementRef<HTMLButtonElement>>('backBtn');
  private readonly destroyRef = inject(DestroyRef);
  private lastFocus: HTMLElement | null = null;
  private currentId = '';
  private seq = 0;
  /** Media that was playing when the modal opened, so it resumes when the modal closes. */
  private paused: HTMLMediaElement[] = [];

  constructor() {
    effect(() => {
      const lesson = this.lesson();
      if (lesson.id === this.currentId) return; // progress toggles hand over a new object
      this.currentId = lesson.id;
      untracked(() => {
        this.title.set('');
        this.url.set('');
        this.note.set('');
        this.file.set(null);
        this.mode.set('link');
        this.error.set('');
        this.opened.set(null);
        this.editing.set(null);
        this.editError.set('');
        document.body.style.overflow = '';
        const input = this.fileInput()?.nativeElement;
        if (input) input.value = '';
        void this.load(lesson.id);
      });
    });

    // Focus the Back button when the deferred modal has rendered.
    effect(() => {
      if (this.opened() && this.backBtn()) this.backBtn()!.nativeElement.focus();
    });

    effect(() => {
      if (this.editing() && this.editTitleInput()) this.editTitleInput()!.nativeElement.focus();
    });

    // Escape closes the modal; the viewer's own Escape handler only acts when expanded.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (this.editing()) { e.preventDefault(); e.stopPropagation(); this.closeEdit(); return; }
      if (this.opened()) { e.preventDefault(); e.stopPropagation(); this.close(); }
    };
    document.addEventListener('keydown', esc);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('keydown', esc);
      document.body.style.overflow = '';
      this.paused = []; // the lesson (and its media) is being torn down too; nothing to resume
    });
  }

  protected host(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  protected reload(): void { void this.load(this.lesson().id); }

  protected setMode(mode: 'link' | 'pdf' | 'txt' | 'md'): void {
    this.mode.set(mode);
    this.error.set('');
  }

  protected pick(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.file.set(file);
    if (file && !this.title().trim()) this.title.set(file.name.replace(/\.(pdf|txt|md|markdown)$/i, '').slice(0, 120));
  }

  protected open(r: ResourceItem): void {
    this.lastFocus = document.activeElement as HTMLElement | null;
    this.opened.set(r);
    document.body.style.overflow = 'hidden';
    this.pauseBackground();
  }

  protected close(): void {
    this.opened.set(null);
    document.body.style.overflow = '';
    this.resumeBackground();
    this.lastFocus?.focus();
    this.lastFocus = null;
  }

  /**
   * The modal is a visual overlay, so the lesson's own player keeps playing underneath it.
   * Pause whatever is playing when a resource opens, and remember it so `resumeBackground`
   * can bring it back when the modal closes. Covers the native `<video>`, `<hlsjs-video>`
   * and `<youtube-video>` elements, which all expose the standard `pause()`/`paused` pair.
   */
  private pauseBackground(): void {
    this.paused = [];
    for (const el of document.querySelectorAll<HTMLMediaElement>('video, hlsjs-video, youtube-video')) {
      if (el.paused === false && typeof el.pause === 'function') {
        el.pause();
        this.paused.push(el);
      }
    }
  }

  private resumeBackground(): void {
    for (const el of this.paused) {
      try {
        const p = el.play?.();
        if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay blocked: leave it paused */ });
      } catch { /* element was detached */ }
    }
    this.paused = [];
  }

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

  protected async upload(): Promise<void> {
    if (this.saving()) return;
    const file = this.file();
    this.error.set('');
    if (!file) { this.error.set('Choose a PDF, text or Markdown file.'); return; }
    const name = file.name;
    let cap = 0;
    let tooBig = '';
    if (/\.pdf$/i.test(name)) { cap = 25 * 1024 * 1024; tooBig = 'PDFs must be 25 MB or smaller.'; }
    else if (/\.txt$/i.test(name)) { cap = 2 * 1024 * 1024; tooBig = 'Text files must be 2 MB or smaller.'; }
    else if (/\.(md|markdown)$/i.test(name)) { cap = 2 * 1024 * 1024; tooBig = 'Markdown files must be 2 MB or smaller.'; }
    else { this.error.set('Choose a PDF, text or Markdown file.'); return; }
    if (file.size > cap) { this.error.set(tooBig); return; }
    this.saving.set(true);
    try {
      await this.api.uploadResourceFile(this.lesson().id, file, this.title().trim() || undefined, this.note().trim() || undefined);
      this.title.set('');
      this.note.set('');
      this.file.set(null);
      const input = this.fileInput()?.nativeElement;
      if (input) input.value = '';
      await this.load();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not upload that file.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(r: ResourceItem): Promise<void> {
    if (!confirm(`Remove “${r.title}” from this lesson?`)) return;
    try {
      await this.api.deleteResource(Number(r.id));
      await this.load();
    } catch {
      this.error.set('Could not remove that resource.');
    }
  }

  protected edit(r: ResourceItem): void {
    this.editError.set('');
    this.editing.set(r);
    this.editTitle.set(r.title);
    this.editUrl.set(r.kind === 'link' ? r.url : '');
    this.editNote.set(r.note ?? '');
    this.editBusy.set(false);
  }

  protected closeEdit(): void {
    if (this.editBusy()) return;
    this.editing.set(null);
    this.editError.set('');
  }

  protected async saveEdit(): Promise<void> {
    const r = this.editing();
    if (!r || this.editBusy()) return;
    this.editError.set('');
    this.editBusy.set(true);
    try {
      await this.api.updateResource(Number(r.id), {
        title: this.editTitle().trim(),
        ...(r.kind === 'link' ? { url: this.editUrl().trim() } : {}),
        note: this.editNote().trim(),
      });
      this.editing.set(null);
      await this.load();
    } catch (e) {
      this.editError.set(e instanceof Error ? e.message : 'Could not save that resource.');
    } finally {
      this.editBusy.set(false);
    }
  }
}
