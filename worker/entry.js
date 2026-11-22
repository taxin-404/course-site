// Wrangler treats every named export on the entry module as an extra entrypoint, and a
// Worker entrypoint must be a function or an ExportedHandler. The test suite imports the
// schema constants and helpers straight from index.js, so keep that module internal to the
// bundle and expose only the two valid runtime entrypoints here.
export { default, RateLimiter } from './index.js';
