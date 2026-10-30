import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from './api';
import { Login } from './login';
import { Course } from './course';

@Component({
  selector: 'app-root',
  imports: [FormsModule, Login, Course],
  template: `
    @if (api.me(); as me) {
      <header>
        <h2>Course</h2>
        <div>
          @if (me.is_admin) { <button (click)="dlg.showModal()">Add student</button> }
          <button (click)="api.logout()">Sign out</button>
        </div>
      </header>
      <app-course />
      <dialog #dlg>
        <form (ngSubmit)="addStudent()">
          <h3>Add student</h3>
          <input name="email" type="email" placeholder="Student email" [(ngModel)]="email" required />
          <input name="password" type="text" placeholder="Temporary password (8+ characters)" minlength="8" [(ngModel)]="password" required />
          <p class="msg" role="status">{{ message() }}</p>
          <button class="p">Add student</button>
        </form>
        <button type="button" (click)="dlg.close()">Close</button>
      </dialog>
    } @else if (api.me() === null) {
      <app-login />
    }
  `,
})
export class App {
  protected readonly api = inject(Api);
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly message = signal('');

  constructor() { void this.api.init(); }

  protected async addStudent(): Promise<void> {
    try {
      await this.api.addStudent(this.email(), this.password());
      this.message.set('Student added');
      this.email.set('');
      this.password.set('');
    } catch (e) {
      this.message.set((e as Error).message);
    }
  }
}
