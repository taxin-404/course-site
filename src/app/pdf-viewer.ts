import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { NgxExtendedPdfViewerModule, NgxExtendedPdfViewerService, pdfDefaultOptions } from 'ngx-extended-pdf-viewer';
import { Api } from './api';

// Open fast: stream the file, fetch only the pages being viewed, in larger chunks
// (default is 64 KB range requests with streaming off, which means many slow round trips).
pdfDefaultOptions.disableStream = false;
pdfDefaultOptions.disableAutoFetch = true;
pdfDefaultOptions.rangeChunkSize = 1024 * 1024;

/** Warm the browser cache with the viewer + worker scripts so the first PDF opens without waiting on them. */
let prefetched = false;
export function prefetchPdfAssets(): void {
  if (prefetched) return;
  prefetched = true;
  const worker = pdfDefaultOptions.workerSrc();
  for (const href of [worker, worker.replace('pdf.worker', 'viewer')]) {
    const l = document.createElement('link');
    l.rel = 'prefetch';
    l.as = 'script';
    l.href = href;
    document.head.appendChild(l);
  }
}

type Note = Parameters<NgxExtendedPdfViewerService['addEditorAnnotation']>[0];

@Component({
  selector: 'app-pdf-viewer',
  imports: [NgxExtendedPdfViewerModule],
  host: { '[class.expanded]': 'expanded()' },
  template: `
    <div class="notes-bar">
      <span class="notes-hint">🔒 Your notes are private. Only you can see them.</span>
      <span class="notes-status">{{ status() }}</span>
      <button type="button" (click)="toggleExpanded()">{{ expanded() ? '⤡ Exit full window' : '⤢ Full window' }}</button>
      <button type="button" (click)="toggleHidden()" [disabled]="!ready()">{{ hidden() ? 'Show my notes' : 'Hide my notes' }}</button>
      <button type="button" class="reset" (click)="reset()" [disabled]="!ready()">Reset to original</button>
    </div>
    <div class="viewer-wrap">
      <ngx-extended-pdf-viewer
        [src]="url()"
        [theme]="theme"
        [zoom]="'page-fit'"
        [showToolbar]="true"
        [showSidebarButton]="true"
        [showFindButton]="true"
        [showPagingButtons]="true"
        [showZoomButtons]="true"
        [showPresentationModeButton]="true"
        [showSecondaryToolbarButton]="true"
        [showRotateButton]="true"
        [showHandToolButton]="true"
        [showScrollingButtons]="true"
        [showSpreadButton]="true"
        [showPropertiesButton]="true"
        [showEditorButtons]="true"
        [showTextEditor]="true"
        [showDrawEditor]="true"
        [showHighlightEditor]="true"
        [showStampEditor]="true"
        [showEraserEditor]="true"
        [showUndoRedoButtons]="true"
        [showCommentEditor]="false"
        [showSignatureEditor]="false"
        [supportsDownloading]="false"
        [showDownloadButton]="false"
        [disableDownloadButton]="true"
        [showPrintButton]="false"
        [enablePrint]="false"
        [showOpenFileButton]="false"
        [enableDragAndDrop]="false"
        [contextMenuAllowed]="false"
        (pagesLoaded)="onLoaded()"
        (annotationEditorEvent)="onEdit()"
      ></ngx-extended-pdf-viewer>
    </div>
  `,
})
export class PdfViewer {
  private readonly api = inject(Api);
  private readonly pdf = inject(NgxExtendedPdfViewerService);
  protected readonly theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  readonly key = input.required<string>();
  protected readonly url = computed(() => this.api.mediaUrl(this.key()));
  protected readonly expanded = signal(false); // fills the browser window (not the whole screen)
  protected readonly hidden = signal(false);
  protected readonly ready = signal(false);
  protected readonly status = signal('');
  private saved: object[] = []; // what is stored on the server
  private applying = false; // true while we add/remove notes ourselves, so those events are not saved
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Downloading must never work: block the save and print shortcuts (the buttons are already off).
    const block = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ['s', 'p'].includes(e.key?.toLowerCase())) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && this.expanded()) this.toggleExpanded(); };
    window.addEventListener('keydown', block, true);
    window.addEventListener('keydown', esc);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('keydown', block, true);
      window.removeEventListener('keydown', esc);
      if (this.timer) { clearTimeout(this.timer); void this.save(); }
    });
  }

  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50); // let the PDF re-fit to the new size
  }

  private current(): object[] {
    return (this.pdf.getSerializedAnnotations() ?? []).map((a) => {
      const c = { ...(a as object) } as Record<string, unknown>;
      delete c['id']; // temporary id, not needed
      return c;
    });
  }

  private async apply(notes: object[]): Promise<void> {
    this.applying = true;
    try { for (const n of notes) await this.pdf.addEditorAnnotation(n as Note); }
    finally { setTimeout(() => (this.applying = false), 400); }
  }

  private clear(): void {
    this.applying = true;
    this.pdf.removeEditorAnnotations(() => true);
    setTimeout(() => (this.applying = false), 400);
  }

  protected async onLoaded(): Promise<void> {
    try {
      this.saved = (await this.api.getNotes(this.key())).data;
      await this.apply(this.saved);
    } catch { this.status.set('Could not load your notes'); }
    this.ready.set(true);
  }

  protected onEdit(): void {
    if (this.applying || this.hidden() || !this.ready()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), 1200);
  }

  private async save(): Promise<void> {
    this.timer = undefined;
    let notes: object[];
    try { notes = this.current(); } catch { return; }
    if (JSON.stringify(notes) === JSON.stringify(this.saved)) return;
    this.status.set('Saving…');
    try { await this.api.saveNotes(this.key(), notes); this.saved = notes; this.status.set('Saved'); }
    catch (e) { this.status.set((e as Error).message || 'Could not save'); }
  }

  protected async toggleHidden(): Promise<void> {
    if (!this.hidden()) {
      await this.save(); // keep whatever was just written
      this.hidden.set(true);
      this.clear();
    } else {
      const extra = this.current(); // anything written while the notes were hidden
      this.clear();
      await this.apply([...this.saved, ...extra]);
      this.hidden.set(false);
      await this.save();
    }
  }

  protected async reset(): Promise<void> {
    if (!confirm('Delete all your notes on this PDF and go back to the original?')) return;
    clearTimeout(this.timer);
    try {
      await this.api.clearNotes(this.key());
      this.clear();
      this.saved = [];
      this.hidden.set(false);
      this.status.set('Back to the original');
    } catch (e) { this.status.set((e as Error).message || 'Could not reset'); }
  }
}
