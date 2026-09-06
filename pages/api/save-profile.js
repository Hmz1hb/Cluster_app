// pages/api/save-profile.js
//
// Single, all-AWS API route the static profile-card app (app.js) calls to
// persist and reload data. Requires a valid Cognito access token (see
// cognito-auth.js / lib/verifyCognitoToken.js) on every request:
//   - Text fields (name, chips, political identity, journal) -> MongoDB
//   - Photos (cover / avatar, sent as base64 data URLs)      -> S3
//
//   POST  save the signed-in user's card
//   GET   read it back, so the page can rehydrate after a refresh
//
// There is exactly one document per Cognito user, matched on `userId` and
// updated in place, so saving twice edits the same row instead of piling up
// duplicates.
//
// Required environment variables — set these in .env.local (gitignored)
// or in the ECS task definition (see ecs/task-definition.json).
// NEVER commit real values for these; see env_local.example for the
// placeholder file that belongs in the repo:
//   AWS_REGION, S3_BUCKET, MONGODB_URI
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (omit both if deploying on AWS
//     with an IAM role attached — ECS/Lambda/EC2 — the SDK will pick up
//     the role's credentials automatically)
//   ALLOWED_ORIGIN            (the origin your static index.html is served from)
//   COGNITO_USER_POOL_ID      (from the Cognito console)
//   COGNITO_CLIENT_ID         (the App Client id, no secret)

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getCollection } from '../../lib/mongo';
import { randomUUID } from 'crypto';
import { verifyAuthHeader } from '../../lib/verifyCognitoToken';

export const config = {
  api: {
    // Photos arrive as base64, which adds a third to their size, and two of
    // them travel together. app.js shrinks each to at most ~3MB before
    // sending, so this is headroom rather than the operative limit — but at
    // 10mb an ordinary phone photo was rejected outright with a 413.
    bodyParser: { sizeLimit: '15mb' },
  },
};

// Both clients fall back to the ambient IAM role (ECS, Lambda, EC2,
// ECS, etc.) when AWS_ACCESS_KEY_ID isn't set — the natural way to run this
// once it's actually deployed on AWS.
const awsCreds = process.env.AWS_ACCESS_KEY_ID
  ? {
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    }
  : {};

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-1', ...awsCreds });

const PHOTO_URL_TTL = 60 * 60 * 24 * 7; // 7 days, the maximum for a presigned URL

// Uploads a base64 data URL (e.g. "data:image/png;base64,....") to S3 and
// returns the key it was stored under, or null if no image was provided.
// The KEY is what gets persisted, not the URL: a presigned URL expires, so a
// document holding one would show a broken image a week later.
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

// A fresh presigned GET URL for an object already in the bucket.
function signObjectUrl(key) {
  if (!key) return Promise.resolve(null);
  const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: PHOTO_URL_TTL });
}

// Writes the user's single profile document, creating it the first time.
// Photo fields are only touched when a new image came with the request, so
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

// Reads the user's profile back, with photo URLs signed fresh at read time.
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

// CORS for a static page calling this route with an Authorization header.
// A wildcard origin ('*') can't be combined with Allow-Credentials, and
// browsers will refuse to send/receive the Authorization header under a
// wildcard for cross-origin requests in practice — so ALLOWED_ORIGIN must
// be an exact origin (no trailing slash), not '*', once auth is involved.
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST', 'OPTIONS']);
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Require a valid Cognito access token before touching S3/MongoDB. Reads
  // are authenticated too — a profile is only ever returned to its owner.
  let claims;
  try {
    claims = await verifyAuthHeader(req.headers.authorization);
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Unauthorized', detail: err.message });
  }

  // The document is always keyed by the token's subject, never by anything
  // the client sends, so nobody can read or overwrite another user's row.
  const userId = claims.sub;

  try {
    if (req.method === 'GET') {
      const profile = await readProfile(userId);
      // One person's card must never be served to another from a cache. The
      // CloudFront distribution in front of this uses Managed-CachingDisabled,
      // so this is belt-and-braces for browsers and any proxy in between.
      res.setHeader('Cache-Control', 'private, no-store');
      // A user who has never saved is not an error — the page just starts empty.
      return res.status(200).json({ ok: true, profile });
    }

    const { profile = {}, photos = {}, journal = '' } = req.body || {};

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

    return res.status(200).json({ ok: true, savedAt, coverUrl, avatarUrl });
  } catch (err) {
    console.error('save-profile error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
