import { Component, computed, inject, input } from '@angular/core';
import { NgxExtendedPdfViewerModule } from 'ngx-extended-pdf-viewer';
import { Api } from './api';

@Component({
  selector: 'app-pdf-viewer',
  imports: [NgxExtendedPdfViewerModule],
  template: `
    <div class="pv-wrap" (contextmenu)="$event.preventDefault()">
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
        height="calc(100vh - 170px)"
        [zoom]="'page-width'"
      ></ngx-extended-pdf-viewer>
      <div class="pdf-wm">{{ email() }}</div>
    </div>
  `,
  styles: [`
    .pv-wrap { position: relative; user-select: none; }
    .pdf-wm {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) rotate(-30deg);
      pointer-events: none;
      font-size: 2rem;
      color: rgba(0,0,0,0.08);
      white-space: nowrap;
      z-index: 1000;
    }
  `],
})
export class PdfViewer {
  private readonly api = inject(Api);
  readonly key = input.required<string>();

  protected readonly url = computed(() => this.api.mediaUrl(this.key()));
  protected readonly email = computed(() => this.api.me()?.email ?? '');
}
