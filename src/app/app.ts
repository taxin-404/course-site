import { Component, inject, signal } from '@angular/core';
import { Api } from './api';
import { Login } from './login';
import { Course } from './course';
import { Admin } from './admin';

@Component({
  selector: 'app-root',
  imports: [Login, Course, Admin],
  template: `
    @if (api.me(); as me) {
      <header>
        <h2>Course</h2>
        <div>
          @if (me.is_admin) {
            <button (click)="admin.set(!admin())">{{ admin() ? 'Back to course' : 'Admin panel' }}</button>
          }
          <button (click)="signOut()">Sign out</button>
        </div>
      </header>
      @if (admin() && me.is_admin) { <app-admin /> } @else { <app-course /> }
    } @else if (api.me() === null) {
      <app-login />
    }
  `,
})
export class App {
  protected readonly api = inject(Api);
  protected readonly admin = signal(false);

  constructor() { void this.api.init(); }

  protected async signOut(): Promise<void> {
    this.admin.set(false);
    await this.api.logout();
  }
}
