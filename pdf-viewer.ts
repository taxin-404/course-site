import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Api } from './api';

@Component({
  selector: 'app-pdf-viewer',
  template: `
    @if (status()) { <p class="empty">{{ status() }}</p> }
    <div class="pv" #box (contextmenu)="$event.preventDefault()"></div>
  `,
})
export class PdfViewer {
  private readonly api = inject(Api);
  readonly key = input.required<string>();

  protected readonly status = signal('');
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');
  private readonly email = computed(() => this.api.me()?.email ?? '');
  private run = 0;

  constructor() {
    effect(() => {
      const key = this.key();
      const el = this.box()?.nativeElement;
      if (el) untracked(() => this.render(key, el));
    });
    inject(DestroyRef).onDestroy(() => this.run++);
  }

  private async render(key: string, box: HTMLElement): Promise<void> {
    const run = ++this.run;
    box.replaceChildren();
    this.status.set('Loading…');
    try {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';
      const doc = await pdfjs.getDocument({ url: this.api.mediaUrl(key) }).promise;
      if (run !== this.run) return;
      this.status.set('');
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (run !== this.run) return;
        const vp = page.getViewport({ scale: 1.6 });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        box.append(canvas);
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
        this.stamp(ctx, vp.width, vp.height);
      }
    } catch {
      if (run === this.run) this.status.set('Could not load this PDF.');
    }
  }

  /** Tiled watermark with the student's email, baked into the page pixels. */
  private stamp(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#000';
    ctx.font = '28px sans-serif';
    ctx.rotate(-Math.PI / 6);
    for (let y = 0; y < w / 2 + h; y += 200) {
      for (let x = -h / 2; x < w; x += 460) ctx.fillText(this.email(), x, y);
    }
    ctx.restore();
  }
}
