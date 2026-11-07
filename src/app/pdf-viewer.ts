import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { AnnotationEditorLayerRenderedEvent, NgxExtendedPdfViewerModule, NgxExtendedPdfViewerService, pdfDefaultOptions } from 'ngx-extended-pdf-viewer';
import { Api } from './api';
import { Theme } from './theme';
import { PDF_HINT_MS, markHintSeen, shouldShowHint, type HintStore } from './pdf-hint';

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
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [NgxExtendedPdfViewerModule],
  template: `
    <div class="viewer-wrap">
      <ngx-extended-pdf-viewer
        [src]="url()"
        [theme]="theme()"
        [zoom]="narrow() ? 'page-width' : 'page-fit'"
        [showBorders]="!narrow()"
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
        (annotationEditorLayerRendered)="onEditorLayer($event)"
        (annotationEditorEvent)="onEdit()"
      ></ngx-extended-pdf-viewer>
      @if (hint()) {
        <div class="pdf-hint" role="status" aria-live="polite">
          <span class="pdf-hint-text">You can add notes right on this PDF — they're saved automatically and only you can see them.</span>
          <button type="button" class="pdf-hint-x" aria-label="Dismiss" title="Dismiss" (click)="dismissHint()">&times;</button>
          <span class="pdf-hint-bar" aria-hidden="true" [style.animationDuration.ms]="hintMs"></span>
        </div>
      }
      <span class="wm pdf" [style.left.%]="x()" [style.top.%]="y()">{{ email() }}</span>
    </div>
  `,
})
export class PdfViewer implements OnInit {
  private readonly api = inject(Api);
  private readonly pdf = inject(NgxExtendedPdfViewerService);
  private readonly themeSvc = inject(Theme);
  protected readonly theme = computed(() => (this.themeSvc.dark() ? 'dark' : 'light'));
  /** The signed-in student's email, floating over the pages so a PDF leak is traceable. */
  protected readonly email = computed(() => this.api.me()?.email ?? '');
  protected readonly x = signal(8);
  protected readonly y = signal(8);
  // Phones and small tablets: a portrait page must fill the width, so page-fit (which fits the
  // whole page into the short viewport) is replaced by page-width and the page borders are dropped.
  private readonly narrowQuery = matchMedia('(max-width: 820px)');
  protected readonly narrow = signal(this.narrowQuery.matches);
  readonly key = input.required<string>();
  protected readonly url = computed(() => this.api.mediaUrl(this.key()));
  readonly hidden = signal(false);
  readonly ready = signal(false);
  readonly status = signal('');
  protected readonly hint = signal(false);
  protected readonly hintMs = PDF_HINT_MS;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private saved: object[] = []; // every note stored on the server for this PDF
  private applying = false; // true while we add/remove notes ourselves, so those events are not saved
  private loadedKey = ''; // the key whose notes are loaded; a new key resets all note state
  private notesReady = false;
  private readonly renderedPages = new Set<number>(); // pages whose annotation editor layer exists
  private readonly appliedPages = new Set<number>(); // pages whose stored notes have been added
  private readonly applyingPages = new Set<number>(); // pages being restored right now
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Downloading must never work: block the save and print shortcuts (the buttons are already off).
    const block = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ['s', 'p'].includes(e.key?.toLowerCase())) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    const onNarrow = (e: MediaQueryListEvent) => this.narrow.set(e.matches);
    const markTimer = setInterval(() => this.moveMark(), 15000);
    window.addEventListener('keydown', block, true);
    this.narrowQuery.addEventListener('change', onNarrow);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('keydown', block, true);
      this.narrowQuery.removeEventListener('change', onNarrow);
      clearInterval(markTimer);
      clearTimeout(this.hintTimer);
      if (this.timer) { clearTimeout(this.timer); void this.save(); }
    });
  }

  /** Same drifting watermark as the video players. */
  private moveMark(): void {
    this.x.set(5 + Math.random() * 55);
    this.y.set(8 + Math.random() * 78);
  }

  private current(): object[] {
    return (this.pdf.getSerializedAnnotations() ?? []).map((a) => {
      const c = { ...(a as object) } as Record<string, unknown>;
      delete c['id']; // temporary id, not needed
      return c;
    });
  }

  // A pasted image is serialized by PDF.js as a full-resolution base64 data URL. That is both
  // too large for the notes row (D1 caps a row at 2 MB) and blocked by the page CSP when the
  // viewer fetches it back on reload. So each image is uploaded once to R2, content-addressed
  // by its SHA-256, and the note keeps the short same-origin URL instead. This map means the
  // same bytes are uploaded once no matter how many times the notes are saved in a session.
  private readonly assetByDataUrl = new Map<string, Promise<string>>();

  /** Split a `data:` URL into its bytes and media type without using fetch (CSP blocks data:). */
  private static dataUrlBytes(dataUrl: string): { bytes: Uint8Array; type: string } | null {
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:') || comma < 0) return null;
    const header = dataUrl.slice(5, comma);
    const type = header.split(';')[0] || 'application/octet-stream';
    const payload = dataUrl.slice(comma + 1);
    if (/;base64/i.test(header)) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, type };
    }
    // A non-base64 data URL (raw SVG markup) is percent-encoded text.
    try { return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), type }; }
    catch { return null; }
  }

  /** The stored URL for one image, uploading it on first use. */
  private assetUrl(dataUrl: string, key: string): Promise<string> {
    let pending = this.assetByDataUrl.get(dataUrl);
    if (!pending) {
      pending = (async () => {
        const parsed = PdfViewer.dataUrlBytes(dataUrl);
        if (!parsed) return dataUrl; // not an image we can decode: leave it untouched
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', parsed.bytes as unknown as BufferSource));
        const id = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
        return (await this.api.uploadNoteAsset(key, id, parsed.bytes, parsed.type)).url;
      })();
      this.assetByDataUrl.set(dataUrl, pending);
      // A failed upload must not poison the cache: retry on the next save.
      pending.catch(() => this.assetByDataUrl.delete(dataUrl));
    }
    return pending;
  }

  /** Replace every pasted-image data URL in a notes payload with its stored R2 URL. */
  private async withAssets(notes: object[], key: string): Promise<object[]> {
    const out: object[] = [];
    for (const note of notes) {
      const rec = note as Record<string, unknown>;
      const bitmapUrl = rec['bitmapUrl'];
      if (typeof bitmapUrl !== 'string' || !bitmapUrl.startsWith('data:')) { out.push(note); continue; }
      try { out.push({ ...rec, bitmapUrl: await this.assetUrl(bitmapUrl, key) }); }
      catch { out.push(note); } // keep the original: an unsaved image beats a lost one
    }
    return out;
  }

  // The notes are fetched once, as early as possible, and shared by init and pages-loaded.
  // Waiting for `pagesLoaded` before starting the request put it on the critical path, so the
  // notes only appeared after the PDF had fully loaded plus a server round trip; starting here
  // overlaps that round trip with the PDF download and the notes are ready when pages render.
  private notesPromise: { key: string; p: Promise<object[]> } | null = null;
  private loadNotes(key: string): Promise<object[]> {
    if (!this.notesPromise || this.notesPromise.key !== key) {
      this.notesPromise = { key, p: this.api.getNotes(key).then((r) => this.withAssets(r.data ?? [], key)) };
    }
    return this.notesPromise.p;
  }

  ngOnInit(): void {
    void this.loadNotes(this.key()).catch(() => { /* surfaces in onLoaded */ });
    this.maybeShowHint();
  }

  /** Show the notes tip once per student, then remember it even if it times out. */
  private maybeShowHint(): void {
    const id = this.api.me()?.id;
    if (id === undefined) return;
    let store: HintStore;
    try { store = localStorage; } catch { return; }
    if (!shouldShowHint(store, id)) return;
    markHintSeen(store, id);
    this.hint.set(true);
    this.hintTimer = setTimeout(() => this.dismissHint(), PDF_HINT_MS);
  }

  protected dismissHint(): void {
    clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    this.hint.set(false);
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
    const key = this.key();
    if (this.loadedKey === key) return;
    // A different PDF: drop everything that belonged to the previous document, including any
    // debounced save (the view is recreated per lesson id, so the old instance already flushed).
    clearTimeout(this.timer);
    this.timer = undefined;
    this.loadedKey = key;
    this.saved = [];
    this.notesReady = false;
    this.renderedPages.clear();
    this.appliedPages.clear();
    this.applyingPages.clear();
    this.hidden.set(false);
    this.status.set('');
    try {
      this.saved = await this.loadNotes(key);
    } catch {
      if (key === this.key()) this.status.set('Could not load your notes');
    }
    if (key !== this.key()) return;
    this.notesReady = true;
    this.ready.set(true);
    await this.applyRendered();
  }

  // The editor layer is created per page, after that page has rendered. Waiting for
  // `pagesLoaded` is not enough: `addEditorAnnotation` silently skips notes whose page has no
  // editor layer yet, so each page's notes are applied when its own layer appears (and pages
  // farther down the document are restored when the reader scrolls to them).
  protected onEditorLayer(event: AnnotationEditorLayerRenderedEvent): void {
    const page = event.pageNumber - 1;
    this.renderedPages.add(page);
    if (this.notesReady) void this.applyPage(page);
  }

  private async applyRendered(): Promise<void> {
    for (const page of [...this.renderedPages]) await this.applyPage(page);
  }

  private async applyPage(page: number): Promise<void> {
    if (!this.notesReady || this.hidden()) return;
    if (this.appliedPages.has(page) || this.applyingPages.has(page)) return;
    const notes = this.saved.filter((n) => ((n as { pageIndex?: number }).pageIndex ?? 0) === page);
    if (!notes.length) { this.appliedPages.add(page); return; }
    this.applyingPages.add(page);
    try {
      await this.apply(notes);
      this.appliedPages.add(page);
    } catch {
      // Leave it unapplied: save() keeps the note in the payload rather than dropping it.
    } finally {
      this.applyingPages.delete(page);
    }
  }

  /**
   * What to send to the server. Saved notes for pages that have not rendered yet are not in
   * `current()` (PDF.js held no editor layer for them), so they are added back here. Without
   * this, any edit would delete notes on pages the reader had not scrolled to.
   */
  private payload(): object[] {
    const notes = this.current();
    const pending = this.saved.filter((n) => {
      const page = (n as { pageIndex?: number }).pageIndex ?? 0;
      return !this.appliedPages.has(page) && !this.applyingPages.has(page);
    });
    return pending.length ? [...notes, ...pending] : notes;
  }

  protected onEdit(): void {
    if (this.applying || this.hidden() || !this.ready()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), 1200);
  }

  private async save(): Promise<void> {
    this.timer = undefined;
    if (this.loadedKey !== this.key()) return;
    let notes: object[];
    try { notes = await this.withAssets(this.payload(), this.key()); } catch { return; }
    if (JSON.stringify(notes) === JSON.stringify(this.saved)) return;
    this.status.set('Saving…');
    try { await this.api.saveNotes(this.key(), notes); this.saved = notes; this.status.set('Saved'); }
    catch (e) { this.status.set((e as Error).message || 'Could not save'); }
  }

  async toggleHidden(): Promise<void> {
    if (!this.hidden()) {
      await this.save(); // keep whatever was just written
      this.hidden.set(true);
      this.clear();
    } else {
      const extra = this.current(); // anything written while the notes were hidden
      this.clear();
      this.saved = [...this.saved, ...extra];
      this.appliedPages.clear();
      this.applyingPages.clear();
      this.hidden.set(false);
      await this.applyRendered();
      await this.save();
    }
  }

  async reset(): Promise<void> {
    if (!confirm('Delete all your notes on this PDF and go back to the original?')) return;
    clearTimeout(this.timer);
    try {
      await this.api.clearNotes(this.key());
      this.clear();
      this.saved = [];
      this.appliedPages.clear();
      this.applyingPages.clear();
      this.hidden.set(false);
      this.status.set('Back to the original');
    } catch (e) { this.status.set((e as Error).message || 'Could not reset'); }
  }
}
