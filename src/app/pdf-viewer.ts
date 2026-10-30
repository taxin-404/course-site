import { Component, computed, inject, input } from '@angular/core';
import { NgxExtendedPdfViewerModule } from 'ngx-extended-pdf-viewer';
import { Api } from './api';

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
      [zoom]="'page-width'"
      height="100%"
    ></ngx-extended-pdf-viewer>
  `,
  styles: [`:host { display: flex; flex-direction: column; flex: 1; min-height: 0; }`],
})
export class PdfViewer {
  private readonly api = inject(Api);
  readonly key = input.required<string>();
  protected readonly url = computed(() => this.api.mediaUrl(this.key()));
}
