import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, AdminUser } from './api';

@Component({
  selector: 'app-admin',
  imports: [FormsModule],
  template: `
    <main class="admin">
      <h1>Admin panel</h1>

      <form class="card" (ngSubmit)="add()">
        <h3>Add user</h3>
        <input name="email" type="email" placeholder="Email" [(ngModel)]="email" required />
        <input name="password" type="text" placeholder="Temporary password (8+ characters)" minlength="8" [(ngModel)]="password" required />
        <label class="chk"><input name="isAdmin" type="checkbox" [(ngModel)]="isAdmin" /> Make admin</label>
        <button class="p">Add user</button>
      </form>

      <p class="msg" role="status">{{ message() }}</p>

      <table class="card">
        <thead><tr><th>Email</th><th>Role</th><th>Lessons done</th><th></th></tr></thead>
        <tbody>
          @for (u of users(); track u.id) {
            <tr>
              <td>{{ u.email }}</td>
              <td>{{ u.owner ? 'Owner' : u.is_admin ? 'Admin' : 'Student' }}</td>
              <td>{{ u.watched }}</td>
              <td class="acts">
                <button type="button" (click)="reset(u)">Reset password</button>
                @if (!u.owner && u.id !== api.me()?.id) {
                  <button type="button" (click)="toggle(u)">{{ u.is_admin ? 'Remove admin' : 'Make admin' }}</button>
                  <button type="button" (click)="remove(u)">Delete</button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </main>
  `,
})
export class Admin implements OnInit {
  protected readonly api = inject(Api);
  protected readonly users = signal<AdminUser[]>([]);
  protected readonly message = signal('');
  protected email = '';
  protected password = '';
  protected isAdmin = false;

  ngOnInit(): void { void this.load(); }

  private async load(): Promise<void> {
    try { this.users.set(await this.api.listUsers()); } catch (e) { this.message.set((e as Error).message); }
  }

  private async run(fn: () => Promise<unknown>, ok: string): Promise<void> {
    try { await fn(); this.message.set(ok); await this.load(); } catch (e) { this.message.set((e as Error).message); }
  }

  protected async add(): Promise<void> {
    await this.run(() => this.api.addUser(this.email, this.password, this.isAdmin), 'User added');
    if (this.message() === 'User added') { this.email = ''; this.password = ''; this.isAdmin = false; }
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
