import { Component, computed, inject, signal } from '@angular/core';
import { Api, FileListing } from './api';

type Kind = 'file' | 'folder';

interface Ask {
  title: string;
  hint: string;
  label: string;
  confirm: string;
  danger: boolean;
  run: (value: string) => Promise<void>;
}

interface Toast { id: number; text: string; bad: boolean }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

@Component({
  selector: 'app-admin-files',
  template: `
    <section class="files" aria-label="Course files">
      <div class="files-head">
        <nav class="files-crumbs" aria-label="Folder path">
          <button type="button" [class.here]="!path()" (click)="open('')">Course files</button>
          @for (c of crumbs(); track c.path) {
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            <button type="button" [class.here]="c.path === path()" (click)="open(c.path)">{{ c.name }}</button>
          }
        </nav>
        <div class="files-head-acts">
          <button type="button" class="adm-ico" title="Refresh" aria-label="Refresh folder" [disabled]="loading()" (click)="load()">
            <svg [class.spinning]="loading()" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
          <button type="button" class="p" (click)="newFolder()">New folder</button>
        </div>
      </div>

      @if (error()) { <p class="files-error">{{ error() }}</p> }

      <div class="files-list" role="list">
        @for (d of listing().dirs; track d.path) {
          <div class="files-row" role="listitem">
            <button type="button" class="files-open" (click)="open(d.path)">
              <span class="files-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h4l2 2.5h5A2.5 2.5 0 0 1 20 10v7.5A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z" /></svg>
              </span>
              <span class="files-name">{{ d.name }}</span>
              <span class="files-meta">Folder</span>
            </button>
            <div class="files-tools">
              <button type="button" class="files-tool" title="Rename" aria-label="Rename folder" (click)="askRename(d.name, d.path, 'folder')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13 7 4 4" /></svg>
              </button>
              <button type="button" class="files-tool" title="Move" aria-label="Move folder" (click)="askMove(d.path, 'folder')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6h6l2 2h8v12H4z" /><path d="m10 14 4-4 4 4" /><path d="M14 10v6" /></svg>
              </button>
              <button type="button" class="files-tool danger" title="Delete" aria-label="Delete folder" (click)="askDelete(d.name, d.path, 'folder')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /></svg>
              </button>
            </div>
          </div>
        }

        @for (f of listing().files; track f.key) {
          <div class="files-row" role="listitem">
            <span class="files-open as-span">
              <span class="files-ico" aria-hidden="true">
                @if (f.lesson && !f.hls) {
                  @if (f.name.toLowerCase().endsWith('.pdf')) {
                    <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></svg>
                  } @else {
                    <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 9 5 3-5 3z" /></svg>
                  }
                } @else {
                  <svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>
                }
              </span>
              <span class="files-name">{{ f.name }}</span>
              <span class="files-meta">{{ size(f.size) }}{{ f.lesson ? ' · lesson' : '' }}{{ f.hls ? ' · HLS' : '' }}</span>
            </span>
            <div class="files-tools">
              <button type="button" class="files-tool" title="Rename" aria-label="Rename file" (click)="askRename(f.name, f.key, 'file')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13 7 4 4" /></svg>
              </button>
              <button type="button" class="files-tool" title="Move" aria-label="Move file" (click)="askMove(f.key, 'file')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6h6l2 2h8v12H4z" /><path d="m10 14 4-4 4 4" /><path d="M14 10v6" /></svg>
              </button>
              <button type="button" class="files-tool danger" title="Delete" aria-label="Delete file" (click)="askDelete(f.name, f.key, 'file')">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /></svg>
              </button>
            </div>
          </div>
        }
      </div>

      @if (!loading() && !listing().dirs.length && !listing().files.length) {
        <p class="files-empty">This folder is empty.</p>
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
              <input
                [value]="askValue()"
                (input)="askValue.set($any($event.target).value)"
                (keydown.enter)="runAsk()"
                autocomplete="off"
                spellcheck="false"
              />
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

    <div class="toasts" aria-live="polite">
      @for (t of toasts(); track t.id) {
        <div class="toast" [class.bad]="t.bad" role="status" (click)="dismiss(t.id)">{{ t.text }}</div>
      }
    </div>
  `,
})
export class AdminFiles {
  protected readonly api = inject(Api);

  protected readonly path = signal('');
  protected readonly listing = signal<FileListing>({ path: '', dirs: [], files: [] });
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly ask = signal<Ask | null>(null);
  protected readonly askValue = signal('');
  protected readonly askError = signal('');
  protected readonly busy = signal(false);
  protected readonly toasts = signal<Toast[]>([]);

  protected readonly crumbs = computed(() => {
    const parts = this.path().split('/').filter(Boolean);
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.listing.set(await this.api.listFiles(this.path()));
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
      hint: 'Type the destination folder, for example Course or Course / Section.',
      label: 'Destination folder',
      confirm: 'Move',
      danger: false,
      run: async (value) => {
        const dest = value.replace(/^\/+|\/+$/g, '');
        await this.api.moveEntry(full, this.join(dest, this.base(full)), kind);
      },
    }, this.path());
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
      await ask.run(this.askValue().trim());
      this.ask.set(null);
      this.toast('Done');
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