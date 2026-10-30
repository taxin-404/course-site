import {
  Component, DestroyRef, ElementRef, OnChanges,
  afterNextRender, inject, input, viewChild,
} from '@angular/core';
import EmbedPDF from '@embedpdf/snippet';
import type { EmbedPdfContainer } from '@embedpdf/snippet';
import { Api } from './api';

@Component({
  selector: 'app-pdf-viewer',
  template: `<div class="epdf-wrap" #wrap></div>`,
  styles: [`
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .epdf-wrap { flex: 1; min-height: 0; }
  `],
})
export class PdfViewer implements OnChanges {
  private readonly api = inject(Api);
  readonly key = input.required<string>();
  private readonly wrap = viewChild<ElementRef<HTMLElement>>('wrap');
  private container: EmbedPdfContainer | undefined;

  constructor() {
    afterNextRender(() => this.init());
    inject(DestroyRef).onDestroy(() => this.container?.remove());
  }

  ngOnChanges(): void {
    // When key changes after init, update src without reinitialising
    if (this.container) {
      this.container.config = this.buildConfig();
    }
  }

  private init(): void {
    const target = this.wrap()?.nativeElement;
    if (!target) return;
    this.container = EmbedPDF.init({
      type: 'container',
      target,
      ...this.buildConfig(),
    });
  }

  private buildConfig() {
    return {
      src: this.api.mediaUrl(this.key()),
      worker: true,           // offload rendering to web worker — fast first paint
      tabBar: 'never' as const,
      disabledCategories: [
        'annotation',
        'redaction',
        'document-print',
      ] as string[],
      theme: { preference: 'system' as const },
    };
  }
}
