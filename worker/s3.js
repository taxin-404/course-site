// R2 has two faces: the binding (env.RESOURCES) does listing, streaming and copies in-process,
// and the S3 API exists only because the browser must upload parts straight to the bucket.
// The signing credentials come from Worker secrets; without them uploads are off but everything
// else still works.
import { AwsClient } from 'aws4fetch';

export function r2Config(env) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = String(env.R2_BUCKET || 'course-sourse').trim();
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

const clientFor = (cfg) => new AwsClient({
  accessKeyId: cfg.accessKeyId,
  secretAccessKey: cfg.secretAccessKey,
  service: 's3',
  region: 'auto',
});

// Path-style URLs. Each segment is encoded on its own so real names — spaces, `&`, `#`,
// parentheses — survive both the signature and R2's key lookup.
const objectUrl = (cfg, key) =>
  `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

const withQuery = (url, query) => (query ? `${url}?${query}` : url);

/** A signed request to R2's S3 API (server side: create/complete/abort/list parts). */
export function s3Fetch(env, method, key, { query = '', body, headers } = {}) {
  const cfg = r2Config(env);
  if (!cfg) return null;
  return clientFor(cfg).fetch(withQuery(objectUrl(cfg, key), query), { method, body, headers });
}

/** A presigned URL the browser can use by itself, for one PUT or one part. */
export async function presign(env, method, key, { query = '', expires = 3600 } = {}) {
  const cfg = r2Config(env);
  if (!cfg) return null;
  // aws4fetch treats the expiry as a query parameter in signQuery mode; passing it as a
  // header puts it in SignedHeaders and R2 then computes a different signature.
  const qs = [query, `X-Amz-Expires=${expires}`].filter(Boolean).join('&');
  const signed = await clientFor(cfg).sign(`${objectUrl(cfg, key)}?${qs}`, {
    method,
    aws: { signQuery: true },
  });
  return signed.url;
}