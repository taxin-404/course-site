import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AdminUser } from './api';

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
          <input name="password" type="text" placeholder="Temporary password (8+ chars)" autocomplete="off" minlength="8" [(ngModel)]="password" required />
          <label class="chk"><input name="isAdmin" type="checkbox" [(ngModel)]="isAdmin" /><span>Admin</span></label>
          <button class="p">Add user</button>
        </form>
        @if (message()) { <p class="msg" role="status" [class.bad]="isError()">{{ message() }}</p> }
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

  ngOnInit(): void { void this.load(); }

  private async load(): Promise<void> {
    try { this.users.set(await this.api.listUsers()); } catch (e) { this.message.set((e as Error).message); }
  }

  private async run(fn: () => Promise<unknown>, ok: string): Promise<void> {
    try { await fn(); this.isError.set(false); this.message.set(ok); await this.load(); } catch (e) { this.isError.set(true); this.message.set((e as Error).message); }
  }

  protected async add(): Promise<void> {
    await this.run(() => this.api.addUser(this.email, this.password, this.isAdmin), 'User added');
    if (!this.isError()) { this.email = ''; this.password = ''; this.isAdmin = false; }
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
}
