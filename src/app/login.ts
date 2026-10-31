import { AfterViewInit, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from './api';

declare const google: any;

let gsi: Promise<void> | undefined;
function loadGsi(): Promise<void> {
  return (gsi ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gsi = undefined; reject(new Error('Could not load Google sign-in')); };
    document.head.appendChild(s);
  }));
}

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
      <div class="or" [hidden]="!hasGoogle()"><span>or</span></div>
      <div class="gsi" #gbtn [hidden]="!hasGoogle()"></div>
    </form>
  `,
})
export class Login implements AfterViewInit {
  private readonly api = inject(Api);
  private readonly gbtn = viewChild.required<ElementRef<HTMLElement>>('gbtn');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly hasGoogle = signal(false);

  async ngAfterViewInit(): Promise<void> {
    const clientId = await this.api.googleClientId();
    if (!clientId) return;
    try {
      await loadGsi();
      google.accounts.id.initialize({
        client_id: clientId,
        ux_mode: 'popup',
        callback: (r: { credential: string }) => void this.google(r.credential),
      });
      const el = this.gbtn().nativeElement;
      this.hasGoogle.set(true);
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      google.accounts.id.renderButton(el, {
        type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large',
        text: 'continue_with', shape: 'pill', logo_alignment: 'left',
        width: Math.min(400, Math.max(200, el.parentElement?.clientWidth ? el.parentElement.clientWidth - 56 : 300)),
      });
    } catch {
      this.hasGoogle.set(false);
    }
  }

  private async google(credential: string): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.api.loginGoogle(credential);
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

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
