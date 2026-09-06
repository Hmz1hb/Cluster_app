// lambda/save-profile-handler.js
//
// Standalone Lambda version of pages/api/save-profile.js, for deploying
// behind Amazon API Gateway (HTTP API, Lambda proxy integration) instead
// of / in addition to the Next.js API route on ECS/Fargate. Same request
// shape and same storage model as the Next.js route:
//
//   POST  save the signed-in user's card
//   GET   read it back, so the page can rehydrate after a refresh
//
// One document per Cognito user, matched on `userId` and updated in place.
//
// Required environment variables (set on the Lambda function config, or
// via SAM / CDK if you provision it that way):
//   AWS_REGION, S3_BUCKET, MONGODB_URI
//   ALLOWED_ORIGIN, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID
//
// No AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY here — the function should
// run under an execution role (see the IAM policy in README.md) and the
// SDK picks that up automatically.
//
// package this directory (lambda/ + lib/ + node_modules) as a zip, or
// point SAM/CDK at it, and set the handler to
// "save-profile-handler.handler".

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getCollection } = require('../lib/mongo');
const { randomUUID } = require('crypto');
const { verifyAuthHeader } = require('../lib/verifyCognitoToken');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-1' });

const PHOTO_URL_TTL = 60 * 60 * 24 * 7; // 7 days, the maximum for a presigned URL

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Stores the image and returns its S3 key. The key is what gets persisted,
// not a presigned URL, which would expire and leave a broken image behind.
async function uploadToS3(dataUrl, keyName) {
  if (!dataUrl) return null;

  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) throw new Error(`Malformed image data for ${keyName}`);

  const [, contentType, base64] = match;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: keyName,
      Body: Buffer.from(base64, 'base64'),
      ContentType: contentType,
    })
  );

  return keyName;
}

function signObjectUrl(key) {
  if (!key) return Promise.resolve(null);
  const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: PHOTO_URL_TTL });
}

// Photo fields are only written when a new image came with the request, so
// re-saving the form without re-picking a photo keeps the stored one.
async function upsertProfile(userId, fields, photos) {
  const profiles = await getCollection();

  const $set = { ...fields };
  if (photos.coverKey) {
    $set.coverKey = photos.coverKey;
    $set.coverUrl = photos.coverUrl;
  }
  if (photos.avatarKey) {
    $set.avatarKey = photos.avatarKey;
    $set.avatarUrl = photos.avatarUrl;
  }

  await profiles.updateOne(
    { userId },
    { $set, $setOnInsert: { id: randomUUID(), createdAt: fields.savedAt } },
    { upsert: true }
  );
}

// Returns null when the user has never saved anything.
async function readProfile(userId) {
  const profiles = await getCollection();
  const doc = await profiles.findOne({ userId }, { projection: { _id: 0 } });
  if (!doc) return null;

  const [coverUrl, avatarUrl] = await Promise.all([
    signObjectUrl(doc.coverKey),
    signObjectUrl(doc.avatarKey),
  ]);

  return {
    fullName: doc.fullName || '',
    email: doc.email || '',
    title: doc.title || '',
    ethnicity: doc.ethnicity || '',
    religion: doc.religion || '',
    city: doc.city || '',
    political: doc.political || '',
    journal: doc.journal || '',
    savedAt: doc.savedAt || '',
    // Documents written before coverKey existed carry only the (expiring)
    // URL, so fall back to it rather than losing the picture entirely.
    coverUrl: coverUrl || doc.coverUrl || '',
    avatarUrl: avatarUrl || doc.avatarUrl || '',
  };
}

// event: API Gateway HTTP API (payload format 2.0) Lambda proxy event.
exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (method !== 'GET' && method !== 'POST') {
    return respond(405, { ok: false, error: 'Method not allowed' });
  }

  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization;

  let claims;
  try {
    claims = await verifyAuthHeader(authHeader);
  } catch (err) {
    return respond(401, { ok: false, error: 'Unauthorized', detail: err.message });
  }

  // Always keyed by the token's subject, never by anything the client sends,
  // so nobody can read or overwrite another user's row.
  const userId = claims.sub;

  try {
    if (method === 'GET') {
      const profile = await readProfile(userId);
      // One person's card must never be served to another from a cache.
      const res = respond(200, { ok: true, profile });
      res.headers['Cache-Control'] = 'private, no-store';
      return res;
    }

    const { profile = {}, photos = {}, journal = '' } = JSON.parse(event.body || '{}');

    const [coverKey, avatarKey] = await Promise.all([
      uploadToS3(photos.cover, `covers/${Date.now()}-cover.jpg`),
      uploadToS3(photos.avatar, `avatars/${Date.now()}-avatar.jpg`),
    ]);
    const [coverUrl, avatarUrl] = await Promise.all([
      signObjectUrl(coverKey),
      signObjectUrl(avatarKey),
    ]);

    const savedAt = new Date().toISOString();

    await upsertProfile(
      userId,
      {
        savedAt,
        fullName: profile.fullName || '',
        email: profile.email || '',
        title: profile.title || '',
        ethnicity: profile.ethnicity || '',
        religion: profile.religion || '',
        city: profile.city || '',
        political: profile.political || '',
        journal: journal || '',
      },
      { coverKey, coverUrl, avatarKey, avatarUrl }
    );

    return respond(200, { ok: true, savedAt, coverUrl, avatarUrl });
  } catch (err) {
    console.error('save-profile-handler error:', err);
    return respond(500, { ok: false, error: err.message });
  }
};
