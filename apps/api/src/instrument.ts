import * as Sentry from '@sentry/node';

// Loaded before index.js with `node --import` (Handbook §13), never imported by it. ESM runs every
// import before the importing module's own code, so a Sentry.init inside index.ts would run after
// express and http had already loaded, too late to wrap them. Without that wrapping, errors still
// arrive but lose the request they came from, and two concurrent requests can share one scope.
//
// Errors only, with no tracing or profiling. sendDefaultPii excludes IP addresses. HTTP body
// capture is disabled separately, so pre-flight's GPS readings never enter an error event (D-89).
//
// With SENTRY_DSN unset, as in tests, CI and most local runs, the SDK starts disabled and sends
// nothing. SENTRY_ENVIRONMENT tags each event: `local`, `development`, or `production` for the
// demo stack.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
  sendDefaultPii: false,
  integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })],
});
