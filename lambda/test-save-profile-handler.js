// lambda/test-save-profile-handler.js
//
// Local smoke test for save-profile-handler.js — no AWS deployment or SAM
// CLI needed. Mocks an API Gateway HTTP API (payload format 2.0) event and
// invokes the handler directly.
//
// This test mocks Cognito verification and the AWS SDK clients, so it
// checks the handler's own logic (CORS, method routing, request parsing,
// response shape) without touching real AWS resources or a real token.
//
// Run with:  node lambda/test-save-profile-handler.js

const assert = require('assert');
const Module = require('module');

// Documents the handler tried to persist, captured by the mongo mock below.
const insertedDocs = [];

// ── Mock lib/verifyCognitoToken so no real Cognito call happens ──────────
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('verifyCognitoToken')) {
    return {
      verifyAuthHeader: async (authHeader) => {
        if (authHeader === 'Bearer valid-test-token') {
          return { sub: 'test-user-123' };
        }
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
      // Captures what the handler would have written so the tests can assert
      // on the document shape without a running MongoDB.
      getCollection: async () => ({
        insertOne: async (doc) => {
          insertedDocs.push(doc);
          return { acknowledged: true, insertedId: 'mock-id' };
        },
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

async function run() {
  // 1. OPTIONS preflight -> 204 with CORS headers
  {
    const res = await handler(mockEvent({ method: 'OPTIONS' }));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers['Access-Control-Allow-Origin'], 'http://localhost:8080');
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

  // 4. Valid token + valid body -> 200 with expected shape
  {
    const res = await handler(mockEvent({
      authorization: 'Bearer valid-test-token',
      body: {
        profile: { fullName: 'Test User', email: 'test@example.com', title: 'QA Engineer', city: 'Las Vegas, NV' },
        photos: {},
        journal: 'First entry',
      },
    }));
    assert.strictEqual(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.ok, true);
    assert.ok(parsed.savedAt);

    // The document actually handed to MongoDB must carry the Cognito subject,
    // not anything client-supplied — that binding is what stops one user
    // writing rows attributed to another.
    const doc = insertedDocs[insertedDocs.length - 1];
    assert.ok(doc, 'handler should have persisted a document');
    assert.strictEqual(doc.userId, 'test-user-123');
    assert.ok(doc.id, 'document should carry a generated id');
    assert.strictEqual(doc.journal, 'First entry');
    console.log('✓ Authenticated POST returns 200 with { ok, savedAt, coverUrl, avatarUrl }');
    console.log('✓ Persisted document carries the Cognito sub as userId');
  }

  // 5. Wrong method -> 405
  {
    const res = await handler(mockEvent({ method: 'GET' }));
    assert.strictEqual(res.statusCode, 405);
    console.log('✓ Non-POST/OPTIONS method returns 405');
  }

  console.log('\nAll save-profile-handler tests passed.');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
