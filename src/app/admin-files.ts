import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, output, signal } from '@angular/core';
import { Api, FileEntry, FileListing, YoutubeLesson } from './api';
import { CsvReject, CsvRow, parseYoutubeCsv } from './youtube-csv';
import { UploadJob, Uploader } from './upload';
import { OptionsMenu } from './options-menu';

type Kind = 'file' | 'folder';

/** One row of the admin list: a folder, an R2 file or a YouTube lesson, all in one sequence. */
interface Row {
  path: string;
  name: string;
  kind: Kind | 'youtube';
  meta: string;
  position: number | null;
  file: FileEntry | null;
  yt: { id: string; name: string; yt: string } | null;
}

interface Ask {
  title: string;
  hint: string;
  label: string;
  confirm: string;
  danger: boolean;
  /** When set, the dialog renders a textarea with this many rows instead of one input. */
  lines?: number;
  run: (value: string) => Promise<unknown>;
}

interface Toast { id: number; text: string; bad: boolean }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Mirrors worker/banners.js; this copy only labels the row. */
const BANNER_FILE = /^[^/]+\/banner\.(jpe?g|png|webp|svg)$/i;
const IMAGE_FILE = /\.(jpe?g|png|webp|gif|svg)$/i;

@Component({
  selector: 'app-admin-files',
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <section
      class="files"
      aria-label="Course files"
      (document:keydown.escape)="onEsc()"
      (dragenter)="dragEnter($event)"
      (dragover)="dragOver($event)"
      (dragleave)="dragLeave()"
      (drop)="drop($event)"
    >
      <div class="files-head">
        <button type="button" class="back-btn" (click)="back.emit()">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
          Users
        </button>
        <nav class="files-crumbs" aria-label="Folder path">
          <button type="button" [class.here]="!path()" (click)="open('')">Course files</button>
          @for (c of crumbs(); track c.path) {
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            <button type="button" [class.here]="c.path === path()" (click)="open(c.path)">{{ c.name }}</button>
          }
        </nav>
        <div class="files-head-acts">
          <input #picker type="file" multiple hidden (change)="pick(picker)" />
          <button type="button" class="icon-btn" title="Refresh" aria-label="Refresh folder" [disabled]="loading()" (click)="load()">
            <svg [class.spinning]="loading()" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
          <button type="button" (click)="newFolder()">New folder</button>
          <button type="button" class="files-yt-btn" title="Add a YouTube lesson to this folder" (click)="openYt()">
            <svg class="files-yt" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="4" /><path d="m10 9 5 3-5 3z" /></svg>
            YouTube
          </button>
          <button type="button" class="p" (click)="picker.click()">
            <svg class="files-up" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5" /><path d="m7 10 5-5 5 5" /><path d="M5 19h14" /></svg>
            Upload
          </button>
          <!-- The header is hidden in admin, so the options menu (Back to course / theme / Sign out) lives here. -->
          <app-options-menu />
        </div>
      </div>

      @if (error()) { <p class="files-error">{{ error() }}</p> }

      @if (path() && !path().includes('/')) {
        <p class="files-note">Card banner: upload banner.jpg, banner.jpeg, banner.png, banner.webp or banner.svg to this folder (landscape, about 16:9).</p>
      }

      @if (uploader.jobs().length) {
        <div class="files-jobs">
          @for (j of uploader.jobs(); track j.id) {
            <div class="files-job" [class.ok]="j.state === 'done'" [class.bad]="j.state === 'error' || j.state === 'conflict'">
              <span class="files-ico" aria-hidden="true">
                @if (j.state === 'done') {
                  <svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10" /></svg>
                } @else {
                  <svg viewBox="0 0 24 24"><path d="M12 16V5" /><path d="m7 10 5-5 5 5" /><path d="M5 19h14" /></svg>
                }
              </span>
              <div class="files-job-main">
                <div class="files-job-top">
                  <span class="files-name">{{ j.name }}</span>
                  <span class="files-meta">{{ size(j.size) }} · {{ stateText(j) }}</span>
                </div>
                <div class="bar"><i [style.width.%]="pct(j)"></i></div>
                @if (j.error) { <p class="files-job-note">{{ j.error }}</p> }
              </div>
              <div class="files-tools">
                @if (j.state === 'conflict') {
                  <button type="button" (click)="uploader.replace(j.id)">Replace</button>
                }
                @if (j.state === 'paused') {
                  <input #refile type="file" hidden (change)="reselect(j.id, refile)" />
                  <button type="button" (click)="refile.click()">Re-select file</button>
                }
                @if (j.state === 'error') {
                  <button type="button" (click)="uploader.retry(j.id)">Retry</button>
                }
                @if (j.state === 'done') {
                  <button type="button" class="files-tool" title="Dismiss" aria-label="Dismiss finished upload" (click)="uploader.dismiss(j.id)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
                  </button>
                } @else {
                  <button type="button" class="files-tool" title="Cancel" aria-label="Cancel upload" (click)="uploader.cancel(j.id)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
                  </button>
                }
              </div>
            </div>
          }
        </div>
      }

      <div class="files-list" role="list">
        @for (row of rows(); track row.path) {
          <div class="files-row" role="listitem">
            <input
              #pos
              class="files-pos"
              type="number"
              min="1"
              max="9999"
              inputmode="numeric"
              placeholder="–"
              [value]="row.position ?? ''"
              [disabled]="savingPos() === row.path"
              [attr.aria-label]="'Position of ' + row.name"
              (keydown.enter)="pos.blur()"
              (change)="savePosition(row.path, pos)"
            />
            @if (row.kind === 'folder') {
              <button type="button" class="files-open" (click)="open(row.path)">
                <span class="files-ico" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h4l2 2.5h5A2.5 2.5 0 0 1 20 10v7.5A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z" /></svg>
                </span>
                <span class="files-name">{{ row.name }}</span>
                <span class="files-meta">{{ row.meta }}</span>
              </button>
            } @else {
              <span class="files-open as-span">
                <span class="files-ico" aria-hidden="true">
                  @if (row.kind === 'youtube') {
                    <svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="4" /><path d="m10 9 5 3-5 3z" /></svg>
                  } @else if (row.file?.lesson && !row.file?.hls) {
                    @if (row.name.toLowerCase().endsWith('.pdf')) {
                      <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></svg>
                    } @else {
                      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 9 5 3-5 3z" /></svg>
                    }
                  } @else if (isImage(row.name)) {
                    <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></svg>
                  } @else {
                    <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>
                  }
                </span>
                <span class="files-name">{{ row.name }}</span>
                <span class="files-meta">{{ row.meta }}</span>
              </span>
            }
            <div class="files-tools">
              @if (row.kind === 'file') {
                <button type="button" class="files-tool" title="Rename" aria-label="Rename file" (click)="askRename(row.name, row.path, 'file')">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13 7 4 4" /></svg>
                </button>
                <button type="button" class="files-tool" title="Move" aria-label="Move file" (click)="askMove(row.path, 'file')">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6h6l2 2h8v12H4z" /><path d="m10 14 4-4 4 4" /><path d="M14 10v6" /></svg>
                </button>
              } @else if (row.kind === 'folder') {
                @if (!row.path.includes('/')) {
                  <button type="button" class="files-tool" title="Description" [attr.aria-label]="'Edit description for ' + row.name" (click)="askDescription(row.path)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16" /><path d="M4 11h16" /><path d="M4 16h10" /></svg>
                  </button>
                }
                <button type="button" class="files-tool" title="Rename" aria-label="Rename folder" (click)="askRename(row.name, row.path, 'folder')">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13 7 4 4" /></svg>
                </button>
                @if (row.path.includes('/')) {
                  <!-- A top-level folder is a course, and a course can only be renamed. -->
                  <button type="button" class="files-tool" title="Move" aria-label="Move folder" (click)="askMove(row.path, 'folder')">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6h6l2 2h8v12H4z" /><path d="m10 14 4-4 4 4" /><path d="M14 10v6" /></svg>
                  </button>
                }
              } @else {
                <button type="button" class="files-tool" title="Edit lesson" aria-label="Edit YouTube lesson" (click)="editYt(row.yt!)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13 7 4 4" /></svg>
                </button>
              }
              <button type="button" class="files-tool danger" title="Delete" [attr.aria-label]="'Delete ' + row.name" (click)="removeRow(row)">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h16" />
                  <path d="M9 7V4.5h6V7" />
                  <path d="M6.5 7l.9 12.5h9.2L17.5 7" />
                  <path d="M10 10.5v6M14 10.5v6" />
                </svg>
              </button>
            </div>
          </div>
        }
      </div>

      @if (!loading() && !rows().length) {
        <p class="files-empty">This folder is empty.</p>
      }

      @if (dragging()) {
        <div class="files-drop" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 16V5" /><path d="m7 10 5-5 5 5" /><path d="M5 19h14" /></svg>
          <span>Drop to upload into {{ path() || 'the course list' }}</span>
        </div>
      }
    </section>

    @if (ask(); as a) {
      <div class="adm-scrim" (click)="closeAsk()"></div>
      <div class="adm-dialog" role="dialog" aria-modal="true" [attr.aria-label]="a.title">
        <header class="adm-dialog-top">
          <h3>{{ a.title }}</h3>
          <button type="button" class="adm-close" aria-label="Close" (click)="closeAsk()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
          </button>
        </header>
        <div class="adm-form">
          <p class="adm-muted sm">{{ a.hint }}</p>
          @if (a.label) {
            <label class="field">
              <span>{{ a.label }}</span>
              @if (a.lines) {
                <textarea
                  [rows]="a.lines"
                  [value]="askValue()"
                  (input)="askValue.set($any($event.target).value)"
                  spellcheck="false"
                ></textarea>
              } @else {
                <input
                  [value]="askValue()"
                  (input)="askValue.set($any($event.target).value)"
                  (keydown.enter)="runAsk()"
                  autocomplete="off"
                  spellcheck="false"
                />
              }
            </label>
          }
          @if (askError()) { <p class="files-error">{{ askError() }}</p> }
        </div>
        <footer class="adm-dialog-foot">
          <button type="button" (click)="closeAsk()">Cancel</button>
          <button type="button" class="p" [class.d]="a.danger" [disabled]="busy()" (click)="runAsk()">
            {{ busy() ? 'Working...' : a.confirm }}
          </button>
        </footer>
      </div>
    }

    @if (ytOpen()) {
      <div class="adm-scrim" (click)="closeYt()"></div>
      <div class="adm-dialog" role="dialog" aria-modal="true" aria-label="YouTube lesson">
        <header class="adm-dialog-top">
          <h3>{{ ytEditing() ? 'Edit lesson' : 'YouTube lesson' }}</h3>
          <button type="button" class="adm-close" aria-label="Close" (click)="closeYt()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
          </button>
        </header>
        <div class="adm-form">
          <p class="adm-muted sm">Added to {{ path() }}.</p>
          <label class="field">
            <span>Lesson name@if (ytEditing()) { <em class="adm-muted sm">· renaming moves its notes, comments and progress</em> }</span>
            <input [value]="ytName()" (input)="ytName.set($any($event.target).value)" autocomplete="off" spellcheck="false" />
          </label>
          <label class="field">
            <span>YouTube link</span>
            <input [value]="ytLink()" (input)="ytLink.set($any($event.target).value)" placeholder="https://youtu.be/... or the video id" autocomplete="off" spellcheck="false" (keydown.enter)="saveYt()" />
          </label>
          @if (!ytEditing()) {
            <label class="field">
              <span>…or import a CSV · name, link</span>
              <input #csvPicker type="file" accept=".csv,text/csv" (change)="onCsv(csvPicker)" />
            </label>
            @if (csvName()) {
              <p class="adm-muted sm">{{ csvRows().length }} lessons found in {{ csvName() }}@if (csvBad().length) { · {{ csvBad().length }} skipped}.</p>
              <ul class="yt-import">
                @for (r of csvPreview(); track $index) { <li>{{ r.name }}</li> }
                @if (csvRows().length > 8) { <li class="more">…and {{ csvRows().length - 8 }} more</li> }
              </ul>
              @if (csvBadSummary()) { <p class="files-error">{{ csvBadSummary() }}</p> }
            }
          }
          @if (ytError()) { <p class="files-error">{{ ytError() }}</p> }
        </div>
        <footer class="adm-dialog-foot">
          <button type="button" (click)="closeYt()">Cancel</button>
          <button type="button" class="p" [disabled]="busy()" (click)="csvLoaded() ? importCsv() : saveYt()">{{ ytCta() }}</button>
        </footer>
      </div>
    }

    <div class="toasts" aria-live="polite">
      @for (t of toasts(); track t.id) {
        <div class="toast" [class.bad]="t.bad" role="status" (click)="dismiss(t.id)">{{ t.text }}</div>
      }
    </div>
  `,
  imports: [OptionsMenu],
})
export class AdminFiles implements OnDestroy {
  protected readonly api = inject(Api);
  /** The toolbar's `← Users`; the Admin shell switches back to the Users view. */
  readonly back = output<void>();
  protected readonly uploader = new Uploader(this.api, () => {
    void this.load();
    void this.api.init();
  });

  protected readonly path = signal('');
  protected readonly dragging = signal(false);
  protected readonly listing = signal<FileListing>({ path: '', dirs: [], files: [], order: {} });
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly savingPos = signal<string | null>(null);
  protected readonly ask = signal<Ask | null>(null);
  protected readonly askValue = signal('');
  protected readonly askError = signal('');
  protected readonly busy = signal(false);
  protected readonly toasts = signal<Toast[]>([]);

  protected readonly youtube = signal<YoutubeLesson[]>([]);
  protected readonly ytOpen = signal(false);
  protected readonly ytEditing = signal<string | null>(null);
  protected readonly ytName = signal('');
  protected readonly ytLink = signal('');
  protected readonly ytError = signal('');
  protected readonly csvName = signal('');
  protected readonly csvRows = signal<CsvRow[]>([]);
  protected readonly csvBad = signal<CsvReject[]>([]);
  protected readonly csvLoaded = computed(() => this.csvName() !== '');
  protected readonly csvPreview = computed(() => this.csvRows().slice(0, 8));
  protected readonly ytCta = computed(() =>
    this.busy() ? 'Working...'
      : this.csvRows().length ? `Add ${this.csvRows().length} lesson${this.csvRows().length === 1 ? '' : 's'}`
        : this.csvLoaded() ? 'Add lessons'
          : this.ytEditing() ? 'Save' : 'Add lesson');
  protected readonly csvBadSummary = computed(() => this.csvBad().length
    ? `${this.csvBad().length} row${this.csvBad().length === 1 ? '' : 's'} skipped — ${this.csvBad().slice(0, 3).map((b) => `line ${b.line}: ${b.reason}`).join('; ')}`
    : '');

  protected readonly crumbs = computed(() => {
    const parts = this.path().split('/').filter(Boolean);
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  });

  /** YouTube lessons whose parent folder is the folder currently open. */
  protected readonly ytRows = computed(() => {
    const here = this.path();
    return this.youtube()
      .filter((l) => l.id.slice(0, Math.max(0, l.id.lastIndexOf('/'))) === here)
      .map((l) => ({ id: l.id, name: l.lesson, yt: l.yt }));
  });

  /**
   * Folders, files and YouTube lessons of the open folder in one list. Numbered entries
   * come first in their saved order; the rest follow in the default order the student
   * site uses (folders, then files, then YouTube; each by name).
   */
  protected readonly rows = computed<Row[]>(() => {
    const listing = this.listing();
    const order = listing.order || {};
    const rank = { folder: 0, file: 1, youtube: 2 } as const;
    const rows: Row[] = [
      ...listing.dirs.map((d) => ({
        path: d.path, name: d.name, kind: 'folder' as const, meta: 'Folder',
        position: order[d.path] ?? null, file: null, yt: null,
      })),
      ...listing.files.map((f) => ({
        path: f.key, name: f.name, kind: 'file' as const,
        meta: this.size(f.size) + (f.lesson ? ' · lesson' : '') + (f.hls ? ' · HLS' : '') + (this.isBanner(f.key) ? ' · course banner' : ''),
        position: order[f.key] ?? null, file: f, yt: null,
      })),
      ...this.ytRows().map((y) => ({
        path: y.id, name: y.name, kind: 'youtube' as const, meta: `video · ${y.yt}`,
        position: order[y.id] ?? null, file: null, yt: y,
      })),
    ];
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return rows.sort((a, b) => {
      if (a.position != null && b.position != null) return a.position - b.position || collator.compare(a.name, b.name);
      if (a.position != null) return -1;
      if (b.position != null) return 1;
      return rank[a.kind] - rank[b.kind] || collator.compare(a.name, b.name);
    });
  });

  /**
   * Saves a position typed into the row's number box. Blank clears the number and puts
   * the entry back in the default order. The server renumbers the folder 1..N, so the
   * list is reloaded afterwards to show the stored numbers.
   */
  protected async savePosition(path: string, input: HTMLInputElement): Promise<void> {
    if (this.savingPos()) return;
    const raw = input.value.trim();
    const current = this.listing().order[path] ?? null;
    const next = raw === '' ? null : Number(raw);
    if (next !== null && (!Number.isInteger(next) || next < 1 || next > 9999)) {
      this.toast('Position must be a whole number from 1 to 9999', true);
      input.value = current === null ? '' : String(current);
      return;
    }
    if (next === current) return;
    this.savingPos.set(path);
    try {
      await this.api.setFilePosition(path, next);
      await this.load();
      void this.api.init(); // the student browser uses the same numbers
    } catch (e) {
      this.toast(message(e), true);
      input.value = current === null ? '' : String(current);
    } finally {
      this.savingPos.set(null);
    }
  }

  private drags = 0;

  constructor() {
    void this.load();
  }

  ngOnDestroy(): void {
    this.uploader.dispose();
  }

  protected isBanner(path: string): boolean { return BANNER_FILE.test(path); }

  protected isImage(name: string): boolean { return IMAGE_FILE.test(name); }

  protected pick(input: HTMLInputElement): void {
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) this.uploader.add(files, this.path());
  }

  protected reselect(id: number, input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (file) this.uploader.resume(id, file);
  }

  protected dragEnter(event: DragEvent): void {
    event.preventDefault();
    this.drags++;
    this.dragging.set(true);
  }

  protected dragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  protected dragLeave(): void {
    this.drags = Math.max(0, this.drags - 1);
    if (!this.drags) this.dragging.set(false);
  }

  protected drop(event: DragEvent): void {
    event.preventDefault();
    this.drags = 0;
    this.dragging.set(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) this.uploader.add(files, this.path());
  }

  protected pct(job: UploadJob): number {
    if (!job.size) return 0;
    return Math.max(0, Math.min(100, Math.round((job.loaded / job.size) * 100)));
  }

  protected stateText(job: UploadJob): string {
    switch (job.state) {
      case 'waiting': return 'waiting';
      case 'uploading': return this.pct(job) + '%';
      case 'conflict': return 'needs a decision';
      case 'paused': return 'paused';
      case 'done': return 'uploaded';
      default: return 'failed';
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const [listing, youtube] = await Promise.all([this.api.listFiles(this.path()), this.api.listYoutubeLessons()]);
      this.listing.set(listing);
      this.youtube.set(youtube);
    } catch (e) {
      this.error.set(message(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected open(path: string): void {
    this.closeAsk();
    this.path.set(path);
    void this.load();
  }

  /** Delete a row: YouTube lessons use their own removal, files and folders the dialog. */
  protected removeRow(row: Row): void {
    if (row.kind === 'youtube') this.removeYt(row.yt!);
    else this.askDelete(row.name, row.path, row.kind);
  }

  /** Escape closes the open dialog. */
  protected onEsc(): void {
    this.closeAsk();
  }

  protected size(n: number): string {
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = n;
    let i = -1;
    do { value /= 1024; i++; } while (value >= 1024 && i < units.length - 1);
    return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[i];
  }

  protected newFolder(): void {
    const where = this.path() || 'the course list';
    this.openAsk({
      title: 'New folder',
      hint: `Created inside ${where}. A folder at the top level becomes a course.`,
      label: 'Folder name',
      confirm: 'Create',
      danger: false,
      run: async (name) => { await this.api.createFolder(this.join(this.path(), name)); },
    }, '');
  }

  protected askRename(name: string, full: string, kind: Kind): void {
    this.openAsk({
      title: `Rename ${kind}`,
      hint: kind === 'file'
        ? 'The lesson keeps its notes, comments, progress and resources.'
        : 'Everything inside moves with it, including the student records attached to it.',
      label: 'New name',
      confirm: 'Rename',
      danger: false,
      run: async (value) => {
        if (value.includes('/')) throw new Error('A name cannot contain a slash.');
        await this.api.moveEntry(full, this.join(this.parent(full), value), kind);
      },
    }, name);
  }

  protected askMove(full: string, kind: Kind): void {
    this.openAsk({
      title: `Move ${kind}`,
      hint: 'Type the destination folder, for example Course or Course/Section.',
      label: 'Destination folder',
      confirm: 'Move',
      danger: false,
      run: async (value) => {
        // Trim each segment as well as the ends, so "Course / Section" does not create
        // folders named "Course " and " Section".
        const dest = value.split('/').map((part) => part.trim()).filter(Boolean).join('/');
        await this.api.moveEntry(full, this.join(dest, this.base(full)), kind);
      },
    }, this.path());
  }

  /** Course descriptions live in D1; the card, the intro and this dialog all read the same value. */
  protected async askDescription(course: string): Promise<void> {
    // The course list only carries a course once it has a lesson, so a folder that does not
    // appear there (an empty course) must read its stored value from the admin route.
    let current = this.api.courses().find((c) => c.title === course)?.description;
    if (current === undefined) {
      try { current = (await this.api.courseDescription(course)).description; } catch { current = ''; }
    }
    this.openAsk({
      title: `About “${course}”`,
      hint: 'Shown on the course card and at the top of the course. Leave it empty to remove it.',
      label: 'Description',
      lines: 5,
      confirm: 'Save',
      danger: false,
      run: async (value) => { await this.api.saveCourseDescription(course, value); },
    }, current);
  }

  protected askDelete(name: string, full: string, kind: Kind): void {
    this.openAsk({
      title: `Delete ${kind}`,
      hint: kind === 'folder'
        ? 'Everything inside is deleted, together with the comments, notes, progress and course access attached to it. This cannot be undone.'
        : 'The file is removed from the bucket. If it is a lesson, its comments, notes, progress and resources go with it. This cannot be undone.',
      label: kind === 'folder' ? `Type “${name}” to confirm` : '',
      confirm: 'Delete',
      danger: true,
      run: async (value) => {
        if (kind === 'folder' && value !== name) throw new Error('The name does not match.');
        await this.api.deleteEntry(full, kind);
      },
    }, '');
  }

  protected closeAsk(): void {
    this.ask.set(null);
    this.askError.set('');
    this.busy.set(false);
  }

  protected async runAsk(): Promise<void> {
    const ask = this.ask();
    if (!ask) return;
    this.busy.set(true);
    this.askError.set('');
    try {
      const result = await ask.run(this.askValue().trim());
      this.ask.set(null);
      const warning = result && typeof result === 'object' ? (result as { warning?: string }).warning : '';
      if (warning) this.toast(warning, true);
      else this.toast('Done');
      void this.api.init(); // the course tree shown elsewhere is now out of date
      await this.load();
    } catch (e) {
      this.askError.set(message(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected toast(text: string, bad = false): void {
    const id = Date.now() + Math.random();
    this.toasts.update((list) => [...list, { id, text, bad }]);
    setTimeout(() => this.dismiss(id), 4000);
  }

  protected dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  protected openYt(): void {
    if (!this.path()) { this.toast('Open a course first — create one with New folder, then add a lesson inside it.'); return; }
    this.ytEditing.set(null);
    this.ytName.set('');
    this.ytLink.set('');
    this.ytError.set('');
    this.csvName.set('');
    this.csvRows.set([]);
    this.csvBad.set([]);
    this.ytOpen.set(true);
  }

  protected editYt(y: { id: string; name: string; yt: string }): void {
    this.ytEditing.set(y.id);
    this.ytName.set(y.name);
    this.ytLink.set(y.yt);
    this.ytError.set('');
    this.ytOpen.set(true);
  }

  protected closeYt(): void {
    this.ytOpen.set(false);
    this.ytError.set('');
    this.csvName.set('');
    this.csvRows.set([]);
    this.csvBad.set([]);
    this.busy.set(false);
  }

  protected async saveYt(): Promise<void> {
    this.ytError.set('');
    const editing = this.ytEditing();
    const name = this.ytName().trim();
    const link = this.ytLink().trim();
    if (!name) { this.ytError.set('Give the lesson a name.'); return; }
    if (name.includes('/')) { this.ytError.set('A name cannot contain a slash.'); return; }
    if (!link) { this.ytError.set('Paste a YouTube link.'); return; }
    this.busy.set(true);
    try {
      if (editing) {
        // The name is the lesson's key, so a changed name is a data move: the server moves the
        // row and everything attached to it. The link is then upserted on the resulting id.
        const oldName = editing.split('/').pop() || '';
        const next = name === oldName ? editing : (await this.api.renameYoutubeLesson(editing, name)).id;
        const parts = next.split('/');
        await this.api.addYoutubeLesson(parts[0], parts.slice(1, -1).join('/'), parts[parts.length - 1], link);
        this.ytOpen.set(false);
        this.toast(name === oldName ? 'Link updated' : 'Lesson renamed');
      } else {
        const full = this.join(this.path(), name);
        const parts = full.split('/');
        const r = await this.api.addYoutubeLesson(parts[0], parts.slice(1, -1).join('/'), parts[parts.length - 1], link);
        this.ytOpen.set(false);
        this.toast(r.shadowed ? 'Saved, but a file already uses that path, so it will not show.' : 'Lesson added', r.shadowed);
      }
      void this.api.init();
      await this.load();
    } catch (e) {
      this.ytError.set(message(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async onCsv(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.ytError.set('');
    try {
      const { rows, rejected } = parseYoutubeCsv(await file.text());
      this.csvName.set(file.name);
      this.csvRows.set(rows);
      this.csvBad.set(rejected);
    } catch {
      this.ytError.set('That file could not be read.');
    }
  }

  protected async importCsv(): Promise<void> {
    const rows = this.csvRows();
    if (!rows.length) {
      this.ytError.set(this.csvBad().length
        ? `Every row was skipped — ${this.csvBadSummary()}`
        : 'That file had no lessons. Each row needs a name and a YouTube link.');
      return;
    }
    const parts = this.path().split('/');
    const course = parts[0];
    const folder = parts.slice(1).join('/');
    this.busy.set(true);
    this.ytError.set('');
    let added = 0;
    let shadowed = 0;
    const failed: string[] = [];
    try {
      for (const r of rows) {
        try {
          const res = await this.api.addYoutubeLesson(course, folder, r.name, r.link);
          added++;
          if (res.shadowed) shadowed++;
        } catch {
          failed.push(r.name);
        }
      }
      if (failed.length) {
        this.ytError.set(`${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`);
      } else {
        this.closeYt();
        this.toast(shadowed ? `Added ${added} lessons · ${shadowed} hidden by a file with the same path` : `Added ${added} lesson${added === 1 ? '' : 's'}`, shadowed > 0);
      }
      void this.api.init();
      await this.load();
    } finally {
      this.busy.set(false);
    }
  }

  protected removeYt(y: { id: string }): void {
    this.openAsk({
      title: 'Delete YouTube lesson',
      hint: `“${this.base(y.id)}” is removed from this folder. This cannot be undone.`,
      label: '',
      confirm: 'Delete',
      danger: true,
      run: async () => { await this.api.deleteYoutubeLesson(y.id); },
    }, '');
  }

  private openAsk(ask: Ask, value: string): void {
    this.ask.set(ask);
    this.askValue.set(value);
    this.askError.set('');
  }

  private join(dir: string, name: string): string {
    const d = dir.replace(/^\/+|\/+$/g, '');
    const n = name.replace(/^\/+|\/+$/g, '');
    return d ? `${d}/${n}` : n;
  }

  private parent(full: string): string {
    return full.includes('/') ? full.slice(0, full.lastIndexOf('/')) : '';
  }

  private base(full: string): string {
    return full.slice(full.lastIndexOf('/') + 1);
  }
}