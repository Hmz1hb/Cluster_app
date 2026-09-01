// lambda/save-profile-handler.js
//
// Standalone Lambda version of pages/api/save-profile.js, for deploying
// behind Amazon API Gateway (HTTP API, Lambda proxy integration) instead
// of / in addition to the Next.js API route on ECS/Fargate. Same request
// shape as the Next.js route.
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  return getSignedUrl(s3, getCommand, { expiresIn: 60 * 60 * 24 * 7 });
}

async function saveToMongo(doc) {
  const profiles = await getCollection();
  await profiles.insertOne(doc);
}

// event: API Gateway HTTP API (payload format 2.0) Lambda proxy event.
exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (method !== 'POST') {
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

  try {
    const { profile = {}, photos = {}, journal = '' } = JSON.parse(event.body || '{}');

    const [coverUrl, avatarUrl] = await Promise.all([
      uploadToS3(photos.cover, `covers/${Date.now()}-cover.jpg`),
      uploadToS3(photos.avatar, `avatars/${Date.now()}-avatar.jpg`),
    ]);

    const savedAt = new Date().toISOString();

    await saveToMongo({
      id: randomUUID(),
      userId: claims.sub,
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

    return respond(200, { ok: true, savedAt, coverUrl, avatarUrl });
  } catch (err) {
    console.error('save-profile-handler error:', err);
    return respond(500, { ok: false, error: err.message });
  }
};
