// R2 has two faces: the binding (env.RESOURCES) does listing, streaming and copies in-process,
// and the S3 API exists only because the browser must upload parts straight to the bucket.
// The signing credentials come from Worker secrets; without them uploads are off but everything
// else still works.
export function r2Config(env) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = String(env.R2_BUCKET || 'course-sourse').trim();
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}