import { signal } from '@angular/core';
import { Api, ApiError, UploadPart } from './api';

// Uploads go straight from the browser to R2 with presigned URLs, so a multi-gigabyte
// video never touches the Worker. The Worker only starts the upload, signs each part,
// and records the result.
//
// The part rules mirror worker/files.js: parts of 8 MiB (or larger for huge files) so
// R2's 5 MiB minimum is always met, and at most 10,000 parts.

const MIB = 1024 * 1024;
const SINGLE_MAX = 16 * MIB; // matches the Worker's single-PUT limit
const CONCURRENCY = 3;
const STORE = 'course-uploads';

export type UploadState = 'waiting' | 'uploading' | 'conflict' | 'paused' | 'done' | 'error';

export interface UploadJob {
  id: number;
  name: string;
  key: string;
  size: number;
  /** The file's last-modified time; with name and size it identifies the exact file. */
  modified: number;
  /** Bytes confirmed uploaded (completed parts plus the current part's progress). */
  loaded: number;
  state: UploadState;
  error: string;
  /** Absent after a reload: the browser no longer has the file until it is re-selected. */
  file: File | null;
}

interface Stored {
  key: string;
  size: number;
  modified: number;
  uploadId: string;
}

/** Parts must be at least 5 MiB (except the last), never more than 10,000 in total. */
function partSizeFor(size: number): number {
  return Math.ceil(Math.max(8 * MIB, Math.ceil(size / 9000)) / MIB) * MIB;
}

const nameOf = (key: string) => key.slice(key.lastIndexOf('/') + 1);

export class Uploader {
  readonly jobs = signal<UploadJob[]>([]);
  private nextId = 1;
  // One job can have several part PUTs in flight, so each one is tracked separately.
  private readonly inflight = new Map<number, Set<XMLHttpRequest>>();

  constructor(private readonly api: Api, private readonly changed: () => void) {
    // A reload leaves an unfinished multipart upload behind. Show it as paused so the
    // owner can re-select the file and continue from the parts that already landed.
    for (const rec of this.storeAll()) {
      this.jobs.update((list) => [...list, {
        id: this.nextId++, name: nameOf(rec.key), key: rec.key, size: rec.size, modified: rec.modified, loaded: 0,
        state: 'paused', error: 'Paused — re-select the file to continue.', file: null,
      }]);
    }
  }

  /** Queue files for the folder currently open; `folder` is '' at the course list. */
  add(files: File[], folder: string): void {
    for (const file of files) {
      const key = folder ? `${folder}/${file.name}` : file.name;
      // Re-adding the same file to the same place should continue the paused row, not
      // leave two rows for one key.
      const waiting = this.jobs().find((j) => j.state === 'paused' && j.key === key && j.size === file.size);
      if (waiting) { this.resume(waiting.id, file); continue; }
      const id = this.nextId++;
      this.jobs.update((list) => [...list, {
        id, name: file.name, key, size: file.size, modified: file.lastModified, loaded: 0, state: 'waiting', error: '', file,
      }]);
      if (!folder) this.fail(id, 'Open a course folder before uploading.');
      else void this.run(id);
    }
  }

  /** After a reload the page asks for the file again, then continues where it stopped. */
  resume(id: number, file: File): void {
    this.patch(id, { file, size: file.size, modified: file.lastModified, loaded: 0, error: '', state: 'waiting' });
    void this.run(id);
  }

  /** Replace is the same upload with the overwrite flag set. */
  replace(id: number): void {
    this.patch(id, { error: '', state: 'waiting', loaded: 0 });
    void this.run(id, true);
  }

  retry(id: number): void {
    if (!this.get(id)?.file) { this.patch(id, { state: 'paused', error: 'Paused — re-select the file to continue.' }); return; }
    this.patch(id, { error: '', state: 'waiting', loaded: 0 });
    void this.run(id);
  }

  dismiss(id: number): void {
    this.jobs.update((list) => list.filter((j) => j.id !== id));
  }

  cancel(id: number): void {
    for (const xhr of this.inflight.get(id) ?? []) xhr.abort();
    this.inflight.delete(id);
    const job = this.get(id);
    if (!job) return;
    // Tell R2 to drop the parts it has kept for us; a failure here only leaves storage
    // behind until the bucket's lifecycle rule removes it.
    const rec = this.storeFind(job);
    if (rec) void this.api.uploadAbort(job.key, rec.uploadId).catch(() => {});
    this.storeDrop(job);
    this.dismiss(id);
  }

  dispose(): void {
    for (const set of this.inflight.values()) for (const xhr of set) xhr.abort();
    this.inflight.clear();
  }

  private async run(id: number, overwrite = false): Promise<void> {
    const job = this.get(id);
    if (!job || !job.file) return;
    const file = job.file;
    this.patch(id, { state: 'uploading', error: '' });
    try {
      if (file.size <= SINGLE_MAX) await this.single(id, job, file, overwrite);
      else await this.multi(id, job, file, overwrite);
      this.patch(id, { state: 'done', loaded: file.size, error: '' });
      this.storeDrop(job);
      this.changed();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 409) {
        this.patch(id, { state: 'conflict', error: 'A file with that name already exists.' });
        return;
      }
      if (e instanceof DOMException && e.name === 'AbortError') return;
      this.fail(id, e instanceof Error ? e.message : String(e));
    }
  }

  private async single(id: number, job: UploadJob, file: File, overwrite: boolean): Promise<void> {
    const { url } = await this.api.uploadUrl(job.key, file.size, overwrite);
    await this.put(id, url, file, (loaded) => this.patch(id, { loaded }));
    // A single PUT finishes without a Worker round trip; this drops the course cache.
    await this.api.uploadDone(job.key);
  }

  private async multi(id: number, job: UploadJob, file: File, overwrite: boolean): Promise<void> {
    const size = partSizeFor(file.size);
    const total = Math.ceil(file.size / size);
    const parts: UploadPart[] = [];
    let uploadId = '';
    let base = 0;

    const rec = this.storeFind(job);
    if (rec) {
      try {
        const listed = await this.api.uploadParts(job.key, rec.uploadId);
        uploadId = rec.uploadId;
        for (const p of listed.parts) {
          parts.push({ partNumber: p.partNumber, etag: p.etag });
          base += p.size ?? (p.partNumber < total ? size : file.size - (total - 1) * size);
        }
        if (listed.parts.length) this.patch(id, { loaded: base, error: 'Resuming the earlier upload.' });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
          // R2 no longer has the upload (expired or aborted): start a fresh one.
          this.storeDrop(job);
          this.patch(id, { error: 'The earlier upload expired, so this one starts over.' });
        } else {
          throw e;
        }
      }
    }

    if (!uploadId) {
      const started = await this.api.uploadStart(job.key, file.size, overwrite);
      uploadId = started.uploadId;
      this.storeSave(job, uploadId);
      parts.length = 0;
      base = 0;
    }

    const have = new Set(parts.map((p) => p.partNumber));
    const missing: number[] = [];
    for (let n = 1; n <= total; n++) if (!have.has(n)) missing.push(n);

    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, missing.length) }, async () => {
      while (next < missing.length) {
        const n = missing[next++];
        const start = (n - 1) * size;
        const blob = file.slice(start, Math.min(start + size, file.size));
        const { url } = await this.api.uploadPartUrl(job.key, uploadId, n);
        const etag = await this.putPart(id, url, blob, (loaded) => this.patch(id, { loaded: base + loaded }));
        parts.push({ partNumber: n, etag });
        base += blob.size;
        this.patch(id, { loaded: base });
      }
    });
    await Promise.all(workers);

    parts.sort((a, b) => a.partNumber - b.partNumber);
    await this.api.uploadComplete(job.key, uploadId, parts);
  }

  private put(id: number, url: string, body: Blob, onProgress: (loaded: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      const settle = () => this.untrack(id, xhr);
      xhr.onload = () => { settle(); xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`R2 refused the upload (${xhr.status}).`)); };
      xhr.onerror = () => { settle(); reject(new Error('The upload could not reach R2. Check your connection.')); };
      xhr.onabort = () => { settle(); reject(new DOMException('Aborted', 'AbortError')); };
      this.track(id, xhr);
      xhr.send(body);
    });
  }

  /** A part PUT also returns the ETag that CompleteMultipartUpload needs. */
  private putPart(id: number, url: string, body: Blob, onProgress: (loaded: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      const settle = () => this.untrack(id, xhr);
      xhr.onload = () => {
        settle();
        if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(`R2 refused part (${xhr.status}).`)); return; }
        const etag = xhr.getResponseHeader('etag') || xhr.getResponseHeader('ETag');
        // Without the CORS expose-header rule the browser hides the ETag and the upload
        // cannot be completed at all, so say exactly that instead of failing obscurely.
        if (!etag) { reject(new Error('R2 did not expose the part ETag — the bucket CORS rule needs ExposeHeaders: ETag.')); return; }
        resolve(etag);
      };
      xhr.onerror = () => { settle(); reject(new Error('The upload could not reach R2. Check your connection.')); };
      xhr.onabort = () => { settle(); reject(new DOMException('Aborted', 'AbortError')); };
      this.track(id, xhr);
      xhr.send(body);
    });
  }

  private track(id: number, xhr: XMLHttpRequest): void {
    const set = this.inflight.get(id) ?? new Set<XMLHttpRequest>();
    set.add(xhr);
    this.inflight.set(id, set);
  }

  private untrack(id: number, xhr: XMLHttpRequest): void {
    const set = this.inflight.get(id);
    if (!set) return;
    set.delete(xhr);
    if (!set.size) this.inflight.delete(id);
  }

  private get(id: number): UploadJob | undefined {
    return this.jobs().find((j) => j.id === id);
  }

  private patch(id: number, patch: Partial<UploadJob>): void {
    this.jobs.update((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }

  private fail(id: number, error: string): void {
    this.patch(id, { state: 'error', error });
  }

  // ---- Remembered uploads: enough to list R2's parts after a reload ----

  private storeAll(): Stored[] {
    try {
      const raw = localStorage.getItem(STORE);
      return raw ? JSON.parse(raw) as Stored[] : [];
    } catch {
      return [];
    }
  }

  private storeFind(job: UploadJob): Stored | undefined {
    // Name, size and last-modified together identify the file. Matching on name and size
    // alone would splice parts from a different file into the finished object.
    return this.storeAll().find((r) => r.key === job.key && r.size === job.size && r.modified === job.modified);
  }

  private storeSave(job: UploadJob, uploadId: string): void {
    const rest = this.storeAll().filter((r) => r.key !== job.key);
    rest.push({ key: job.key, size: job.size, modified: job.modified, uploadId });
    try { localStorage.setItem(STORE, JSON.stringify(rest)); } catch { /* storage may be full or blocked */ }
  }

  private storeDrop(job: UploadJob): void {
    const rest = this.storeAll().filter((r) => r.key !== job.key);
    try { localStorage.setItem(STORE, JSON.stringify(rest)); } catch { /* nothing to do */ }
  }
}