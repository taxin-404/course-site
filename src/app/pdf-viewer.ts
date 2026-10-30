import { Component, DestroyRef, ElementRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { Api } from './api';

@Component({
  selector: 'app-pdf-viewer',
  template: `
    <div class="pv-toolbar">
      <span class="pv-info">{{ status() }}</span>
      <div class="pv-controls">
        <button (click)="zoom(-0.2)">−</button>
        <span class="pv-zoom">{{ (scale() * 100).toFixed(0) }}%</span>
        <button (click)="zoom(0.2)">+</button>
        <button (click)="resetZoom()">↺</button>
      </div>
    </div>
    <div class="pv" #box (contextmenu)="$event.preventDefault()"></div>
  `,
})
export class PdfViewer {
  private readonly api = inject(Api);
  readonly key = input.required<string>();

  protected readonly status = signal('Loading…');
  protected readonly scale = signal(1.4);
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');

  private loadRun = 0;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private pages: PDFPageProxy[] = [];

  constructor() {
    // Reload document only when key changes
    effect(() => {
      const key = this.key();
      const el = this.box()?.nativeElement;
      if (el) untracked(() => this.loadDoc(key, el));
    });
    inject(DestroyRef).onDestroy(() => {
      this.loadRun++;
      void this.loadingTask?.destroy();
    });
  }

  protected zoom(delta: number): void {
    this.scale.update((s) => Math.min(3, Math.max(0.5, +(s + delta).toFixed(1))));
    const el = this.box()?.nativeElement;
    if (el) this.rerender(el);
  }

  protected resetZoom(): void {
    this.scale.set(1.4);
    const el = this.box()?.nativeElement;
    if (el) this.rerender(el);
  }

  private async loadDoc(key: string, box: HTMLElement): Promise<void> {
    const run = ++this.loadRun;
    box.replaceChildren();
    this.pages = [];
    void this.loadingTask?.destroy();
    this.loadingTask = null;
    this.status.set('Loading…');
    try {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';
      const task = pdfjs.getDocument({ url: this.api.mediaUrl(key) });
      this.loadingTask = task;
      const doc: PDFDocumentProxy = await task.promise;
      if (run !== this.loadRun) return;
      this.status.set(`${doc.numPages} page${doc.numPages !== 1 ? 's' : ''}`);
      for (let n = 1; n <= doc.numPages; n++) {
        if (run !== this.loadRun) return;
        const page = await doc.getPage(n);
        this.pages.push(page);
        box.append(this.makeCanvas(page));
      }
    } catch {
      if (run === this.loadRun) this.status.set('Could not load PDF.');
    }
  }

  private rerender(box: HTMLElement): void {
    const canvases = box.querySelectorAll('canvas');
    this.pages.forEach((page, i) => {
      const canvas = canvases[i] as HTMLCanvasElement | undefined;
      if (canvas) this.renderPage(page, canvas);
    });
  }

  private makeCanvas(page: PDFPageProxy): HTMLCanvasElement {
    const c = document.createElement('canvas');
    this.renderPage(page, c);
    return c;
  }

  private renderPage(page: PDFPageProxy, canvas: HTMLCanvasElement): void {
    const vp = page.getViewport({ scale: this.scale() });
    canvas.width = vp.width;
    canvas.height = vp.height;
    void page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
  }
}
