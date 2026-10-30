import { Component, DestroyRef, ElementRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Api } from './api';

@Component({
  selector: 'app-pdf-viewer',
  template: `
    <div class="pv-toolbar">
      <span class="pv-info">{{ status() }}</span>
      <div class="pv-controls">
        <button (click)="zoom(-0.2)" title="Zoom out">−</button>
        <span class="pv-zoom">{{ (scale() * 100).toFixed(0) }}%</span>
        <button (click)="zoom(0.2)" title="Zoom in">+</button>
        <button (click)="resetZoom()" title="Reset zoom">↺</button>
      </div>
    </div>
    <div class="pv" #box (contextmenu)="$event.preventDefault()"></div>
  `,
})
export class PdfViewer {
  private readonly api = inject(Api);
  readonly key = input.required<string>();

  protected readonly status = signal('');
  protected readonly scale = signal(1.4);
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');
  private run = 0;

  constructor() {
    effect(() => {
      const key = this.key();
      const el = this.box()?.nativeElement;
      if (el) untracked(() => this.render(key, el));
    });
    effect(() => {
      this.scale();
      const key = this.key();
      const el = this.box()?.nativeElement;
      if (el) untracked(() => this.render(key, el));
    });
    inject(DestroyRef).onDestroy(() => this.run++);
  }

  protected zoom(delta: number): void {
    this.scale.update((s) => Math.min(3, Math.max(0.5, +(s + delta).toFixed(1))));
  }
  protected resetZoom(): void { this.scale.set(1.4); }

  private async render(key: string, box: HTMLElement): Promise<void> {
    const run = ++this.run;
    box.replaceChildren();
    this.status.set('Loading…');
    try {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';
      const doc = await pdfjs.getDocument({ url: this.api.mediaUrl(key) }).promise;
      if (run !== this.run) return;
      this.status.set(`${doc.numPages} page${doc.numPages !== 1 ? 's' : ''}`);
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (run !== this.run) return;
        const vp = page.getViewport({ scale: this.scale() });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        box.append(canvas);
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
      }
    } catch {
      if (run === this.run) this.status.set('Could not load PDF.');
    }
  }
}
