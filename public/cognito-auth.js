// cognito-auth.js
//
// Minimal Cognito User Pool auth for a plain static page (loaded via a
// normal <script> tag, no bundler). Talks directly to the Cognito
// Identity Provider's public JSON API over HTTPS — no AWS SDK needed in
// the browser, so no npm install / webpack step for index.html.
//
// Load order in index.html:
//   <script src="config.js"></script>
//   <script src="cognito-auth.js"></script>
//   <script src="app.js"></script>
//
// Exposes window.CognitoAuth with: signUp, confirmSignUp, signIn, signOut,
// getIdToken, getAccessToken, isSignedIn, currentUser.
//
// Tokens are kept in sessionStorage (cleared when the tab closes) rather
// than localStorage, so a shared/public machine doesn't leave a session
// behind. Swap STORAGE for localStorage yourself if you want "remember me"
// behavior.

(function () {
  const STORAGE = window.sessionStorage;
  const TOKEN_KEY = 'cognito_tokens';

  function endpoint() {
    return `https://cognito-idp.${window.APP_CONFIG.region}.amazonaws.com/`;
  }

  async function cognitoRequest(target, body) {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.message || data.__type || 'Cognito request failed');
      err.code = data.__type;
      throw err;
    }
    return data;
  }

  function saveTokens(authResult) {
    // authResult: { AccessToken, IdToken, RefreshToken, ExpiresIn, TokenType }
    STORAGE.setItem(TOKEN_KEY, JSON.stringify({
      ...authResult,
      obtainedAt: Date.now(),
    }));
  }

  function loadTokens() {
    const raw = STORAGE.getItem(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function clearTokens() {
    STORAGE.removeItem(TOKEN_KEY);
  }

  // Registers a new user. Cognito emails/texts a confirmation code
  // (depending on how the User Pool is configured) unless auto-verify is on.
  async function signUp(email, password, attributes = {}) {
    const userAttributes = Object.entries({ email, ...attributes }).map(([Name, Value]) => ({ Name, Value }));
    return cognitoRequest('SignUp', {
      ClientId: window.APP_CONFIG.userPoolClientId,
      Username: email,
      Password: password,
      UserAttributes: userAttributes,
    });
  }

  // Submits the code from the confirmation email/SMS.
  async function confirmSignUp(email, code) {
    return cognitoRequest('ConfirmSignUp', {
      ClientId: window.APP_CONFIG.userPoolClientId,
      Username: email,
      ConfirmationCode: code,
    });
  }

  // Signs in with USER_PASSWORD_AUTH. Requires that auth flow be enabled
  // on the app client (Cognito console -> App client -> Authentication
  // flows -> "ALLOW_USER_PASSWORD_AUTH").
  async function signIn(email, password) {
    const data = await cognitoRequest('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: window.APP_CONFIG.userPoolClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });

    if (data.ChallengeName) {
      // e.g. NEW_PASSWORD_REQUIRED — hand the challenge back to the caller
      // instead of guessing what to do with it.
      const err = new Error(`Auth challenge required: ${data.ChallengeName}`);
      err.challenge = data;
      throw err;
    }

    saveTokens(data.AuthenticationResult);
    return data.AuthenticationResult;
  }

  // Uses the stored refresh token to get a fresh access/id token pair.
  async function refresh() {
    const tokens = loadTokens();
    if (!tokens || !tokens.RefreshToken) throw new Error('No refresh token available');

    const data = await cognitoRequest('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: window.APP_CONFIG.userPoolClientId,
      AuthParameters: { REFRESH_TOKEN: tokens.RefreshToken },
    });

    // Refresh responses don't include a new RefreshToken — keep the old one.
    saveTokens({ ...data.AuthenticationResult, RefreshToken: tokens.RefreshToken });
    return data.AuthenticationResult;
  }

  function signOut() {
    clearTokens();
  }

  function isSignedIn() {
    const tokens = loadTokens();
    if (!tokens) return false;
    const expiresAt = tokens.obtainedAt + tokens.ExpiresIn * 1000;
    return Date.now() < expiresAt;
  }

  function getIdToken() {
    const tokens = loadTokens();
    return tokens ? tokens.IdToken : null;
  }

  function getAccessToken() {
    const tokens = loadTokens();
    return tokens ? tokens.AccessToken : null;
  }

  // Returns an access token that is good to use right now, or null if the
  // user genuinely has to sign in again.
  //
  // isSignedIn() only looks at the access token, which lives 60 minutes. The
  // refresh token lives days longer, so treating an expired access token as
  // "signed out" would log people out mid-session for no reason. Try the
  // refresh first, and only give up if that fails too.
  async function ensureFreshToken() {
    const tokens = loadTokens();
    if (!tokens) return null;
    if (isSignedIn()) return tokens.AccessToken;
    if (!tokens.RefreshToken) return null;

    try {
      const refreshed = await refresh();
      return refreshed.AccessToken;
    } catch (err) {
      clearTokens(); // refresh token spent or revoked - a real sign-out
      return null;
    }
  }

  // The email this session belongs to, read out of the ID token, for display
  // only. The server never trusts anything decoded here - it verifies the
  // token itself on every request.
  function currentEmail() {
    const tokens = loadTokens();
    if (!tokens || !tokens.IdToken) return null;
    try {
      const payload = tokens.IdToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(payload)).email || null;
    } catch (err) {
      return null;
    }
  }

  window.CognitoAuth = {
    signUp,
    confirmSignUp,
    signIn,
    signOut,
    refresh,
    isSignedIn,
    getIdToken,
    getAccessToken,
    ensureFreshToken,
    currentEmail,
  };
})();
