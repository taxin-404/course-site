import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AdminUser, BulkResult } from './api';

@Component({
  selector: 'app-admin',
  imports: [FormsModule],
  template: `
    <main class="admin">
      <div class="ah">
        <div>
          <h1>Admin panel</h1>
          <p class="sub">{{ users().length }} users · {{ admins() }} admin{{ admins() === 1 ? '' : 's' }}</p>
        </div>
      </div>

      <section class="ac">
        <h3>Add user</h3>
        <form class="af" (ngSubmit)="add()">
          <input name="email" type="email" placeholder="Email" autocomplete="off" [(ngModel)]="email" required />
          @if (!googleOnly) {
            <input name="password" type="text" placeholder="Temporary password (8+ chars)" autocomplete="off" minlength="8" [(ngModel)]="password" required />
          } @else {
            <span class="hint">Signs in with Google only</span>
          }
          <label class="chk"><input name="googleOnly" type="checkbox" [(ngModel)]="googleOnly" /><span>Google only</span></label>
          <label class="chk"><input name="isAdmin" type="checkbox" [(ngModel)]="isAdmin" /><span>Admin</span></label>
          <button class="p">Add user</button>
        </form>
        @if (message()) { <p class="msg" role="status" [class.bad]="isError()">{{ message() }}</p> }
      </section>

      <section class="ac">
        <h3>Add many users</h3>
        <p class="sub">Paste emails (one per line, or separated by commas/spaces) or load a .csv/.txt file. Existing users are skipped.</p>
        <textarea name="bulk" rows="6" placeholder="alice@gmail.com&#10;bob@gmail.com" [(ngModel)]="bulkText" (ngModelChange)="bulkCount.set(parse($event).length)"></textarea>
        <div class="bf">
          <label class="chk"><input type="checkbox" [(ngModel)]="bulkGoogle" /><span>Google sign-in only (no passwords)</span></label>
          <label class="chk"><input type="checkbox" [(ngModel)]="bulkAdmin" /><span>Admin</span></label>
          <label class="file"><input type="file" accept=".csv,.txt,text/plain,text/csv" (change)="loadFile($event)" />Load file</label>
          <button type="button" class="p" [disabled]="bulkBusy() || !bulkCount()" (click)="addMany()">
            {{ bulkBusy() ? 'Adding…' : 'Add ' + bulkCount() + ' user' + (bulkCount() === 1 ? '' : 's') }}
          </button>
        </div>
        @if (result(); as r) {
          <p class="msg" role="status">Added {{ r.added.length }}@if (r.skipped.length) {, skipped {{ r.skipped.length }} ({{ skippedText(r) }})}.</p>
          @if (hasPasswords(r)) {
            <p class="sub">Temporary passwords are shown only now. Copy or download them and share each one privately.</p>
            <textarea readonly rows="5">{{ csv(r) }}</textarea>
            <div class="bf">
              <button type="button" (click)="copy(r)">Copy</button>
              <button type="button" (click)="download(r)">Download CSV</button>
            </div>
          }
        }
      </section>

      <section class="ac list">
        <h3>Users</h3>
        @for (u of users(); track u.id) {
          <div class="row">
            <span class="av">{{ u.email.charAt(0).toUpperCase() }}</span>
            <div class="who">
              <strong>{{ u.email }}</strong>
              <small>{{ u.watched }} lesson{{ u.watched === 1 ? '' : 's' }} done</small>
            </div>
            @if (u.google) { <span class="badge g" title="Linked to a Google account">Google</span> }
            <span class="badge" [class.adm]="u.is_admin">{{ u.owner ? 'Owner' : u.is_admin ? 'Admin' : 'Student' }}</span>
            <div class="acts">
              <button type="button" (click)="reset(u)">Reset password</button>
              @if (!u.owner && u.id !== api.me()?.id) {
                <button type="button" (click)="toggle(u)">{{ u.is_admin ? 'Remove admin' : 'Make admin' }}</button>
                <button type="button" class="d" (click)="remove(u)">Delete</button>
              }
            </div>
          </div>
        }
      </section>
    </main>
  `,
})
export class Admin implements OnInit {
  protected readonly api = inject(Api);
  protected readonly users = signal<AdminUser[]>([]);
  protected readonly message = signal('');
  protected readonly isError = signal(false);
  protected admins = () => this.users().filter((u) => u.is_admin).length;
  protected email = '';
  protected password = '';
  protected isAdmin = false;
  protected googleOnly = false;
  protected bulkText = '';
  protected bulkGoogle = true;
  protected bulkAdmin = false;
  protected readonly bulkCount = signal(0);
  protected readonly bulkBusy = signal(false);
  protected readonly result = signal<BulkResult | null>(null);

  ngOnInit(): void { void this.load(); }

  private async load(): Promise<void> {
    try { this.users.set(await this.api.listUsers()); } catch (e) { this.message.set((e as Error).message); }
  }

  private async run(fn: () => Promise<unknown>, ok: string): Promise<void> {
    try { await fn(); this.isError.set(false); this.message.set(ok); await this.load(); } catch (e) { this.isError.set(true); this.message.set((e as Error).message); }
  }

  protected async add(): Promise<void> {
    await this.run(() => this.api.addUser(this.email, this.password, this.isAdmin, this.googleOnly), 'User added');
    if (!this.isError()) { this.email = ''; this.password = ''; this.isAdmin = false; this.googleOnly = false; }
  }

  protected async reset(u: AdminUser): Promise<void> {
    const pw = prompt(`New password for ${u.email} (8+ characters)`);
    if (pw) await this.run(() => this.api.resetPassword(u.id, pw), 'Password updated');
  }

  protected toggle(u: AdminUser): Promise<void> {
    return this.run(() => this.api.setRole(u.id, !u.is_admin), 'Role updated');
  }

  protected async remove(u: AdminUser): Promise<void> {
    if (confirm(`Delete ${u.email}? Their progress is removed too.`)) await this.run(() => this.api.deleteUser(u.id), 'User deleted');
  }

  protected parse(text: string): string[] {
    const out = new Set<string>();
    for (const t of text.split(/[\s,;]+/)) { const e = t.trim().replace(/^["'<]+|["'>]+$/g, '').toLowerCase(); if (e.includes('@')) out.add(e); }
    return [...out];
  }

  protected async loadFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    this.bulkText = (this.bulkText ? this.bulkText + '\n' : '') + (await f.text());
    this.bulkCount.set(this.parse(this.bulkText).length);
    input.value = '';
  }

  protected async addMany(): Promise<void> {
    const emails = this.parse(this.bulkText);
    if (!emails.length) return;
    const size = this.bulkGoogle ? 200 : 20; // password hashing is slow, so send small batches
    const total: BulkResult = { added: [], skipped: [] };
    this.bulkBusy.set(true);
    this.result.set(null);
    try {
      for (let i = 0; i < emails.length; i += size) {
        const r = await this.api.bulkAdd(emails.slice(i, i + size), this.bulkGoogle, this.bulkAdmin);
        total.added.push(...r.added);
        total.skipped.push(...r.skipped);
        this.result.set({ added: [...total.added], skipped: [...total.skipped] });
      }
      this.isError.set(false);
      this.message.set('');
      this.bulkText = '';
      this.bulkCount.set(0);
    } catch (e) {
      this.isError.set(true);
      this.message.set((e as Error).message + (total.added.length ? ` (${total.added.length} were added before the error)` : ''));
    } finally {
      this.bulkBusy.set(false);
      await this.load();
    }
  }

  protected hasPasswords(r: BulkResult): boolean { return r.added.some((a) => a.password); }
  protected skippedText(r: BulkResult): string {
    const n = (why: string) => r.skipped.filter((s) => s.reason === why).length;
    return [n('already exists') && n('already exists') + ' already exist', n('invalid email') && n('invalid email') + ' invalid'].filter(Boolean).join(', ');
  }
  protected csv(r: BulkResult): string { return 'email,password\n' + r.added.filter((a) => a.password).map((a) => a.email + ',' + a.password).join('\n'); }
  protected copy(r: BulkResult): void { void navigator.clipboard?.writeText(this.csv(r)); this.isError.set(false); this.message.set('Copied'); }
  protected download(r: BulkResult): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.csv(r)], { type: 'text/csv' }));
    a.download = 'new-users.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
