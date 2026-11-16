import type { CorsOptions } from 'cors';

/**
 * Express CORS options. Mobile clients often omit the Origin header; those
 * requests are always allowed (no Origin = same-origin / native shell).
 *
 * Browser origins:
 *   - production: must be enumerated in CORS_ALLOWED_ORIGINS, else rejected.
 *     We deliberately fail closed here — a permissive default in prod is a
 *     real CSRF risk against authenticated /chat endpoints.
 *   - development: if no env list is set, all origins pass. Saves dev pain.
 */
export function createCorsOptions(): CorsOptions {
  const raw = process.env.CORS_ALLOWED_ORIGINS?.trim();
  const isProd = process.env.NODE_ENV === 'production';

  if (!raw) {
    if (isProd) {
      console.warn(
        '[corsConfig] CORS_ALLOWED_ORIGINS is empty in production — only requests without an Origin header (mobile/native) will be accepted.'
      );
      return {
        credentials: true,
        origin: (origin, callback) => {
          if (!origin) {
            callback(null, true);
            return;
          }
          callback(new Error(`Origin ${origin} not allowed by CORS (no allowlist configured in production)`));
        },
      };
    }
    return { origin: true, credentials: true };
  }

  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    credentials: true,
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
  };
}
