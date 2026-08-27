// lib/mongo.js
//
// Shared MongoDB accessor for both deployment paths:
//   - pages/api/save-profile.js      (Next.js on ECS/Fargate)
//   - lambda/save-profile-handler.js (API Gateway + Lambda)
//
// Required env vars: MONGODB_URI  (injected from SSM Parameter Store as a
// SecureString — never hard-code it). Optional: MONGODB_DB, MONGODB_COLLECTION.
//
// The connection PROMISE is cached at module scope, not the resolved client.
// Both runtimes reuse a warm process across many requests, and caching the
// promise means concurrent requests arriving during the initial handshake
// share one connection attempt instead of each opening their own — which is
// how a small Mongo host ends up refusing connections under load.

const { MongoClient } = require('mongodb');

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');

    clientPromise = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    })
      .connect()
      .catch((err) => {
        // Drop the cached rejection so the next request retries instead of
        // replaying the same failure forever.
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

async function getCollection(name) {
  const client = await getClient();
  const db = client.db(process.env.MONGODB_DB || 'clusterapp');
  return db.collection(name || process.env.MONGODB_COLLECTION || 'profiles');
}

// Exposed for tests and for graceful shutdown.
async function closeClient() {
  if (clientPromise) {
    const client = await clientPromise.catch(() => null);
    clientPromise = null;
    if (client) await client.close();
  }
}

module.exports = { getClient, getCollection, closeClient };
