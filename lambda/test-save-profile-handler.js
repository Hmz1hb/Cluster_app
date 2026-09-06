// lambda/test-save-profile-handler.js
//
// Local smoke test for save-profile-handler.js — no AWS deployment or SAM
// CLI needed. Mocks an API Gateway HTTP API (payload format 2.0) event and
// invokes the handler directly.
//
// This test mocks Cognito verification and the AWS SDK clients, so it
// checks the handler's own logic (CORS, method routing, request parsing,
// the one-document-per-user storage model, response shape) without touching
// real AWS resources or a real token.
//
// Run with:  node lambda/test-save-profile-handler.js

const assert = require('assert');
const Module = require('module');

// Stands in for the profiles collection: an in-memory map of userId -> doc,
// with just enough of updateOne/findOne to exercise the upsert path.
const store = new Map();

function applyUpdate(userId, update, { upsert } = {}) {
  const existing = store.get(userId);

  if (!existing) {
    if (!upsert) return { matchedCount: 0, upsertedCount: 0 };
    store.set(userId, { userId, ...(update.$setOnInsert || {}), ...(update.$set || {}) });
    return { matchedCount: 0, upsertedCount: 1 };
  }

  // $setOnInsert is deliberately ignored on an update — that is the whole
  // point of it, and the test would not catch a regression otherwise.
  Object.assign(existing, update.$set || {});
  return { matchedCount: 1, upsertedCount: 0 };
}

// ── Mock lib/verifyCognitoToken so no real Cognito call happens ──────────
const TOKENS = {
  'Bearer valid-test-token': 'test-user-123',
  'Bearer other-user-token': 'test-user-456',
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('verifyCognitoToken')) {
    return {
      verifyAuthHeader: async (authHeader) => {
        const sub = TOKENS[authHeader];
        if (sub) return { sub };
        throw new Error('invalid token');
      },
    };
  }
  if (request === '@aws-sdk/client-s3') {
    return {
      S3Client: class { send() { return Promise.resolve({}); } },
      PutObjectCommand: class {},
      GetObjectCommand: class {},
    };
  }
  if (request === '@aws-sdk/s3-request-presigner') {
    return { getSignedUrl: async () => 'https://example-bucket.s3.amazonaws.com/mock-presigned-url' };
  }
  if (request.endsWith('lib/mongo')) {
    return {
      getCollection: async () => ({
        updateOne: async (filter, update, options) => applyUpdate(filter.userId, update, options),
        findOne: async (filter) => store.get(filter.userId) || null,
      }),
      closeClient: async () => {},
    };
  }
  return originalLoad.apply(this, arguments);
};

process.env.ALLOWED_ORIGIN = 'http://localhost:8080';
process.env.S3_BUCKET = 'test-bucket';
process.env.MONGODB_URI = 'mongodb://test/clusterapp';
process.env.MONGODB_DB = 'clusterapp';

const { handler } = require('./save-profile-handler');
Module._load = originalLoad; // restore for anything loaded after this point

function mockEvent({ method = 'POST', authorization, body }) {
  return {
    requestContext: { http: { method } },
    headers: authorization ? { authorization } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
}

const AUTH = 'Bearer valid-test-token';
const PNG = 'data:image/png;base64,aGVsbG8=';

async function run() {
  // 1. OPTIONS preflight -> 204 with CORS headers
  {
    const res = await handler(mockEvent({ method: 'OPTIONS' }));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers['Access-Control-Allow-Origin'], 'http://localhost:8080');
    assert.ok(res.headers['Access-Control-Allow-Methods'].includes('GET'));
    console.log('✓ OPTIONS preflight returns 204 with CORS headers');
  }

  // 2. Missing Authorization header -> 401
  {
    const res = await handler(mockEvent({ body: { profile: {}, photos: {}, journal: '' } }));
    assert.strictEqual(res.statusCode, 401);
    console.log('✓ Missing auth header returns 401');
  }

  // 3. Invalid token -> 401
  {
    const res = await handler(mockEvent({
      authorization: 'Bearer wrong-token',
      body: { profile: {}, photos: {}, journal: '' },
    }));
    assert.strictEqual(res.statusCode, 401);
    console.log('✓ Invalid token returns 401');
  }

  // 4. A read before anything is saved is not an error, just an empty profile
  {
    const res = await handler(mockEvent({ method: 'GET', authorization: AUTH }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).profile, null);
    console.log('✓ GET before the first save returns { profile: null }');
  }

  // 5. Valid token + valid body -> 200 with expected shape
  {
    const res = await handler(mockEvent({
      authorization: AUTH,
      body: {
        profile: { fullName: 'Test User', email: 'test@example.com', title: 'QA Engineer', city: 'Las Vegas, NV' },
        photos: { cover: PNG, avatar: PNG },
        journal: 'First entry',
      },
    }));
    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.ok, true);
    assert.ok(parsed.savedAt);
    assert.ok(parsed.coverUrl);

    // The document actually handed to MongoDB must carry the Cognito subject,
    // not anything client-supplied — that binding is what stops one user
    // writing rows attributed to another.
    const doc = store.get('test-user-123');
    assert.ok(doc, 'handler should have persisted a document');
    assert.strictEqual(doc.userId, 'test-user-123');
    assert.ok(doc.id, 'document should carry a generated id');
    assert.strictEqual(doc.journal, 'First entry');
    // The durable S3 key is stored, not just the presigned URL that expires.
    assert.strictEqual(doc.coverKey.startsWith('covers/'), true);
    console.log('✓ Authenticated POST returns 200 with { ok, savedAt, coverUrl, avatarUrl }');
    console.log('✓ Persisted document carries the Cognito sub as userId and the S3 key');
  }

  // 6. Saving again edits the same row instead of adding another one.
  {
    const before = store.get('test-user-123');
    const firstId = before.id;
    const createdAt = before.createdAt;

    const res = await handler(mockEvent({
      authorization: AUTH,
      body: {
        profile: { fullName: 'Test User Renamed', email: 'test@example.com' },
        photos: {},
        journal: 'Second entry',
      },
    }));
    assert.strictEqual(res.statusCode, 200);

    assert.strictEqual(store.size, 1, 'a second save must not create a second document');
    const doc = store.get('test-user-123');
    assert.strictEqual(doc.fullName, 'Test User Renamed');
    assert.strictEqual(doc.journal, 'Second entry');
    assert.strictEqual(doc.id, firstId, 'id must be stable across saves');
    assert.strictEqual(doc.createdAt, createdAt, 'createdAt must not move on update');
    console.log('✓ Saving twice updates one document instead of inserting a duplicate');
  }

  // 7. A save with no new photo must not wipe the photo already stored.
  {
    const doc = store.get('test-user-123');
    assert.ok(doc.coverKey, 'cover key should survive a save that sent no photo');
    assert.ok(doc.avatarKey, 'avatar key should survive a save that sent no photo');
    console.log('✓ Re-saving without re-picking a photo keeps the stored one');
  }

  // 8. GET returns what was saved, with a freshly signed photo URL.
  {
    const res = await handler(mockEvent({ method: 'GET', authorization: AUTH }));
    assert.strictEqual(res.statusCode, 200);
    const { profile } = JSON.parse(res.body);
    assert.strictEqual(profile.fullName, 'Test User Renamed');
    assert.strictEqual(profile.journal, 'Second entry');
    assert.ok(profile.coverUrl, 'GET should sign a fresh URL for the stored key');
    console.log('✓ GET reads the profile back with freshly signed photo URLs');
  }

  // 9. One user's token must never return another user's profile.
  {
    const res = await handler(mockEvent({ method: 'GET', authorization: 'Bearer other-user-token' }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).profile, null);
    console.log('✓ A different user reads their own (empty) profile, not this one');
  }

  // 10. Wrong method -> 405
  {
    const res = await handler(mockEvent({ method: 'DELETE' }));
    assert.strictEqual(res.statusCode, 405);
    console.log('✓ Method other than GET/POST/OPTIONS returns 405');
  }

  console.log('\nAll save-profile-handler tests passed.');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
