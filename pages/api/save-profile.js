// pages/api/save-profile.js
//
// Single, all-AWS API route the static profile-card app (app.js) calls to
// persist data. Now requires a valid Cognito access token (see
// cognito-auth.js / lib/verifyCognitoToken.js) before writing anything:
//   - Text fields (name, chips, political identity, journal) -> MongoDB
//   - Photos (cover / avatar, sent as base64 data URLs)      -> S3
//
// Required environment variables — set these in .env.local (gitignored)
// or in the Amplify Console -> App settings -> Environment variables.
// NEVER commit real values for these; see env_local.example for the
// placeholder file that belongs in the repo:
//   AWS_REGION, S3_BUCKET, MONGODB_URI
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (omit both if deploying on AWS
//     with an IAM role attached — Lambda/Amplify/EC2 — the SDK will pick up
//     the role's credentials automatically)
//   ALLOWED_ORIGIN            (the origin your static index.html is served from)
//   COGNITO_USER_POOL_ID      (from the Cognito console / amplify/auth/resource.ts output)
//   COGNITO_CLIENT_ID         (the App Client id, no secret)

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getCollection } from '../../lib/mongo';
import { randomUUID } from 'crypto';
import { verifyAuthHeader } from '../../lib/verifyCognitoToken';

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' }, // photos arrive as base64, so allow a bit more room
  },
};

// Both clients fall back to the ambient IAM role (Lambda, Amplify, EC2,
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


// Uploads a base64 data URL (e.g. "data:image/png;base64,....") to S3.
// Returns a URL for the object, or null if no image was provided.
async function uploadToS3(dataUrl, keyName) {
  if (!dataUrl) return null;

  const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!match) throw new Error(`Malformed image data for ${keyName}`);

  const [, contentType, base64] = match;
  const buffer = Buffer.from(base64, 'base64');

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: keyName,
      Body: buffer,
      ContentType: contentType,
    })
  );

  const getCommand = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: keyName });
  return getSignedUrl(s3, getCommand, { expiresIn: 60 * 60 * 24 * 7 }); // 7 days
}

async function saveToMongo(doc) {
  const profiles = await getCollection();
  await profiles.insertOne(doc);
}

// CORS for a static page calling this route with an Authorization header.
// A wildcard origin ('*') can't be combined with Allow-Credentials, and
// browsers will refuse to send/receive the Authorization header under a
// wildcard for cross-origin requests in practice — so ALLOWED_ORIGIN must
// be an exact origin (no trailing slash), not '*', once auth is involved.
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST', 'OPTIONS']);
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Require a valid Cognito access token before touching S3/MongoDB.
  let claims;
  try {
    claims = await verifyAuthHeader(req.headers.authorization);
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Unauthorized', detail: err.message });
  }

  try {
    const { profile = {}, photos = {}, journal = '' } = req.body || {};

    const [coverUrl, avatarUrl] = await Promise.all([
      uploadToS3(photos.cover, `covers/${Date.now()}-cover.jpg`),
      uploadToS3(photos.avatar, `avatars/${Date.now()}-avatar.jpg`),
    ]);

    const savedAt = new Date().toISOString();

    await saveToMongo({
      id: randomUUID(),
      userId: claims.sub, // Cognito user id — lets you upsert per-user later
      savedAt,
      fullName: profile.fullName || '',
      email: profile.email || '',
      title: profile.title || '',
      ethnicity: profile.ethnicity || '',
      religion: profile.religion || '',
      city: profile.city || '',
      political: profile.political || '',
      journal: journal || '',
      coverUrl: coverUrl || '',
      avatarUrl: avatarUrl || '',
    });

    return res.status(200).json({ ok: true, savedAt, coverUrl, avatarUrl });
  } catch (err) {
    console.error('save-profile error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
