import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withDisabledInitialNavigation } from '@angular/router';
import { routes } from './app.routes';
import { NavHistory } from './nav-history';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Create the history tracker before the router runs its first navigation, so it
    // observes that NavigationEnd and tags the starting screen as position 0. The
    // header (the other thing that injects it) only renders after the session check,
    // which is too late — the first entry would stay untagged and shift every later
    // position by one, leaving Back wrongly disabled on the first screen.
    provideAppInitializer(() => {
      inject(NavHistory);
    }),
    // Start routing only once the session is known (App does it). Navigating eagerly made
    // the sign-in page download the lazily-loaded Course route and its PDF viewer — about
    // 190 KiB of a 643 KiB page — for a screen that can never show it.
    provideRouter(routes, withDisabledInitialNavigation()),
  ]
};
