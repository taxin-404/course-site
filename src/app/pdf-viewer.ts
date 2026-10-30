import { Component, computed, inject, input } from '@angular/core';
import { NgxExtendedPdfViewerModule, pdfDefaultOptions } from 'ngx-extended-pdf-viewer';
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

@Component({
  selector: 'app-pdf-viewer',
  imports: [NgxExtendedPdfViewerModule],
  template: `
    <ngx-extended-pdf-viewer
      [src]="url()"
      [showToolbar]="true"
      [showSidebarButton]="false"
      [showFindButton]="true"
      [showPagingButtons]="true"
      [showZoomButtons]="true"
      [showPresentationModeButton]="false"
      [showOpenFileButton]="false"
      [showPrintButton]="false"
      [showDownloadButton]="false"
      [showSecondaryToolbarButton]="false"
      [showRotateButton]="false"
      [showHandToolButton]="false"
      [showScrollingButtons]="false"
      [showSpreadButton]="false"
      [showPropertiesButton]="false"
      [contextMenuAllowed]="false"
      [enablePrint]="false"
      [zoom]="'page-fit'"
      [theme]="theme"
    ></ngx-extended-pdf-viewer>
  `,
  styles: [],
})
export class PdfViewer {
  private readonly api = inject(Api);
  protected readonly theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  readonly key = input.required<string>();
  protected readonly url = computed(() => this.api.mediaUrl(this.key()));
}
