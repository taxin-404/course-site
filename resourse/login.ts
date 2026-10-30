import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from './api';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <form class="login" (ngSubmit)="submit()">
      <h1>Sign in</h1>
      <input name="email" type="email" placeholder="Email" autocomplete="username" [(ngModel)]="email" required />
      <input name="password" type="password" placeholder="Password" autocomplete="current-password" [(ngModel)]="password" required />
      <p class="err" role="alert">{{ error() }}</p>
      <button class="p" [disabled]="busy()">Sign in</button>
    </form>
  `,
})
export class Login {
  private readonly api = inject(Api);
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  protected async submit(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.login(this.email(), this.password());
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
