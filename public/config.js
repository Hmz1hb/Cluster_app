// config.js
//
// Plain global config object — loaded via a normal <script> tag before
// cognito-auth.js and app.js, so no bundler/module system is required.
//
// Fill these in with values from the Cognito console:
//   Amazon Cognito -> User pools -> <your pool> -> "User pool overview"
//     -> User pool ID           -> USER_POOL_ID
//   Amazon Cognito -> User pools -> <your pool> -> App integration
//     -> App clients -> <your app client> -> Client ID
//                                          -> USER_POOL_CLIENT_ID
//
// Never put a client SECRET here — this file ships to the browser. When you
// create the app client in Cognito, make sure "Generate a client secret" is
// UNCHECKED (public/SPA clients must not have a secret).

window.APP_CONFIG = {
  // AWS region the User Pool lives in, e.g. 'us-west-1'
  region: 'us-west-1',

  // Cognito User Pool ID, e.g. 'us-west-1_AbCdEfGhI'
  userPoolId: 'us-west-1_9JyaVN2bh',

  // Cognito App Client ID (no secret), e.g. '1h5p3q...'
  userPoolClientId: '1755e0ikj26gudpt4l1v10ag7k',

  // Base URL of the save-profile API. Empty string = same origin, which is
  // correct now that the ECS/Fargate container serves both this static
  // frontend and /api/* behind the same load balancer. Leaving it relative
  // means a custom domain needs no rebuild.
  apiBaseUrl: '',
};
