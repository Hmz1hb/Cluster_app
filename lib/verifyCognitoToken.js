// lib/verifyCognitoToken.js
//
// Verifies a Cognito access token (the one from CognitoAuth.getAccessToken()
// in cognito-auth.js) against the User Pool's public JWKS. Shared by:
//   - pages/api/save-profile.js  (Next.js on ECS/Fargate)
//   - lambda/save-profile-handler.js (API Gateway + Lambda deployment)
//
// Required env vars: AWS_REGION, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID
//
// Uses aws-jwt-verify, which handles JWKS fetching/caching and signature
// verification for you — no need to hand-roll JWK -> PEM conversion.

const { CognitoJwtVerifier } = require('aws-jwt-verify');

let verifier = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse: 'access',
      clientId: process.env.COGNITO_CLIENT_ID,
    });
  }
  return verifier;
}

// Pulls the token out of "Authorization: Bearer <token>" and verifies it.
// Returns the decoded claims (includes `sub`, the Cognito user id) on
// success, or throws on a missing/invalid/expired token.
async function verifyAuthHeader(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or malformed Authorization header');
  }
  const token = authHeader.slice('Bearer '.length);
  return getVerifier().verify(token);
}

module.exports = { verifyAuthHeader };
