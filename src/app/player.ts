import { Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import type Hls from 'hls.js';
import { Api } from './api';

@Component({
  selector: 'app-player',
  template: `
    <div class="vw" #wrap>
      <video #v controls controlsList="nodownload noremoteplayback" disablePictureInPicture playsinline
        (ended)="ended.emit()" (contextmenu)="$event.preventDefault()"></video>
      <span class="wm" [style.left.%]="x()" [style.top.%]="y()">{{ email() }}</span>
      <button type="button" class="fsb" aria-label="Full screen" title="Full screen (F)" (click)="toggleFs(wrap)">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      </button>
    </div>
  `,
})
export class Player {
  private readonly api = inject(Api);
  readonly key = input.required<string>();
  readonly ended = output<void>();

  protected readonly email = computed(() => this.api.me()?.email ?? '');
  protected readonly x = signal(10);
  protected readonly y = signal(10);
  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('v');
  private hls?: Hls;

  constructor() {
    effect(() => {
      const key = this.key();
      const el = this.video()?.nativeElement;
      if (el) untracked(() => this.load(key, el));
    });
    const timer = setInterval(() => this.moveMark(), 15000);
    inject(DestroyRef).onDestroy(() => { clearInterval(timer); this.hls?.destroy(); });
  }

  protected toggleFs(wrap: HTMLElement): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.requestFullscreen();
  }

  private moveMark(): void {
    this.x.set(5 + Math.random() * 55);
    this.y.set(8 + Math.random() * 78);
  }

  private async load(key: string, el: HTMLVideoElement): Promise<void> {
    this.hls?.destroy();
    this.hls = undefined;
    this.moveMark();
    const url = this.api.mediaUrl(key);
    if (key.endsWith('.m3u8')) {
      const { default: HlsLib } = await import('hls.js');
      if (this.key() !== key) return;
      if (HlsLib.isSupported()) {
        this.hls = new HlsLib();
        this.hls.loadSource(url);
        this.hls.attachMedia(el);
      } else {
        el.src = url; // Safari plays HLS natively
      }
    } else {
      el.src = url;
      el.load();
    }
  }
}
