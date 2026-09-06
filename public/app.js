// ─── Server sync (Next.js API route, backed by AWS + Cognito auth) ───────────
// Points at the /api/save-profile route from the nextjs-api project
// (S3 for photos, MongoDB for profile/journal data), guarded by Cognito.
// POST saves the card; GET reads it back so a refresh doesn't look empty.
// Base URL now comes from config.js so it's set in one place — update
// public/config.js's apiBaseUrl, not this file.
const API_BASE_URL = window.APP_CONFIG.apiBaseUrl;

// Filled in by the photo upload handlers below; sent up as base64 data URLs
// so the API route can push them to S3.
let coverDataUrl  = null;
let avatarDataUrl = null;

// Whether the form is currently showing what the server holds. A save writes
// the whole card in one go, so saving from a form that never loaded would
// overwrite stored data with blanks — these two guard against that.
let profileLoaded  = false;
let profileLoading = null;

// Gathers the current profile/photo/journal state and POSTs it to the API.
// Requires a signed-in Cognito user (see signIn()/signOut() below); if
// there's no valid access token, this shows a toast and skips the network
// call instead of sending an unauthenticated request that the API will
// reject with 401 anyway.
async function syncToServer() {
  const accessToken = await window.CognitoAuth.ensureFreshToken();
  if (!accessToken) {
    showToast('Sign in to save your profile');
    updateAuthUI();
    return null;
  }

  // Wait for a load that is still in flight, then refuse if it never
  // succeeded. Refusing is the safe side: a refresh fixes it, an overwrite
  // with an empty form does not.
  if (!profileLoaded && profileLoading) await profileLoading;
  if (!profileLoaded) {
    showToast('Could not load your saved card — refresh before saving');
    return null;
  }

  const payload = {
    profile: {
      fullName:  document.getElementById('input-full_name').value,
      email:     document.getElementById('input-email').value,
      title:     document.getElementById('sel-title').value,
      ethnicity: document.getElementById('sel-ethnicity').value,
      religion:  document.getElementById('sel-religion').value,
      city:      document.getElementById('sel-city').value,
      political: selectedPolitical || '',
    },
    photos: {
      cover:  coverDataUrl,
      avatar: avatarDataUrl,
    },
    journal: document.getElementById('journal-input').value,
  };

  try {

    const doFetch = (token) => fetch(`${API_BASE_URL}/api/save-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    let res = await doFetch(accessToken);

    // Access token likely expired — refresh once and retry.
    if (res.status === 401) {
      const refreshed = await window.CognitoAuth.refresh();
      res = await doFetch(refreshed.AccessToken);
    }

    // Photos are shrunk before they get here, so this should not happen —
    // but saying "check your connection" when the body was simply too big
    // sends people looking in entirely the wrong place.
    if (res.status === 413) {
      showToast('Those photos are too large to save — try smaller ones');
      return null;
    }

    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('syncToServer failed (continuing offline):', err);
    showToast('Save failed — check your connection');
    return null;
  }
}

// Pulls the signed-in user's card back from the server. Nothing is kept in
// the browser between visits, so without this a refresh leaves the page blank
// even though the data is safe in the database. Returns true once the form
// reflects the server — including for a brand-new account with nothing saved.
function loadProfile() {
  profileLoaded = false;
  profileLoading = (async () => {
    const accessToken = await window.CognitoAuth.ensureFreshToken();
    if (!accessToken) return false;

    try {
      const res = await fetch(`${API_BASE_URL}/api/save-profile`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);

      const data = await res.json();
      if (data.profile) applyProfile(data.profile);

      profileLoaded = true;
      return true;
    } catch (err) {
      console.warn('loadProfile failed:', err);
      showToast('Could not load your saved card — refresh to try again');
      return false;
    }
  })();
  return profileLoading;
}

// Puts a profile from the server into the form and onto the card face.
function applyProfile(p) {
  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value || '';
  };

  setValue('input-full_name', p.fullName);
  setValue('sel-title',       p.title);
  setValue('sel-ethnicity',   p.ethnicity);
  setValue('sel-religion',    p.religion);
  setValue('sel-city',        p.city);
  setValue('journal-input',   p.journal);

  // A saved address beats the account prefill, and is marked as the user's
  // own so updateAuthUI() leaves it alone from here on.
  const emailField = document.getElementById('input-email');
  if (emailField && p.email) {
    emailField.value = p.email;
    delete emailField.dataset.autofilled;
  }

  const nameEl = document.getElementById('disp-full_name');
  nameEl.textContent = p.fullName || 'Your Name';
  nameEl.classList.toggle('empty', !p.fullName);

  setChipValue('disp-email',     p.email);
  setChipValue('disp-title',     p.title);
  setChipValue('disp-ethnicity', p.ethnicity);
  setChipValue('disp-religion',  p.religion);
  setChipValue('disp-city',      p.city);

  selectedPolitical = p.political || null;
  document.querySelectorAll('.political-option').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.value === selectedPolitical);
  });

  // These URLs are signed by the server on each read and expire, so they are
  // only ever displayed — coverDataUrl/avatarDataUrl stay null, which is what
  // tells the API on the next save that the stored photos are unchanged.
  if (p.coverUrl) {
    const img = document.getElementById('cover-img');
    img.src = p.coverUrl;
    img.classList.add('loaded');
    document.getElementById('cover-hint').style.display = 'none';
  }
  if (p.avatarUrl) {
    const img = document.getElementById('avatar-img');
    img.src = p.avatarUrl;
    img.classList.add('loaded');
    document.getElementById('avatar-placeholder').style.display = 'none';
  }

  if (p.savedAt) {
    const when = new Date(p.savedAt);
    document.getElementById('journal-meta').textContent =
      `Last saved ${when.toLocaleDateString()} at ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}

// Wipes the card back to its empty state, so signing out doesn't leave one
// person's profile on screen for whoever signs in next.
function clearProfile() {
  ['input-full_name', 'input-email', 'sel-title', 'sel-ethnicity',
   'sel-religion', 'sel-city', 'journal-input'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  const emailField = document.getElementById('input-email');
  if (emailField) delete emailField.dataset.autofilled;

  const nameEl = document.getElementById('disp-full_name');
  nameEl.textContent = 'Your Name';
  nameEl.classList.add('empty');
  ['disp-email', 'disp-title', 'disp-ethnicity', 'disp-religion', 'disp-city']
    .forEach((id) => setChipValue(id, ''));

  selectedPolitical = null;
  document.querySelectorAll('.political-option').forEach((btn) => btn.classList.remove('selected'));

  coverDataUrl  = null;
  avatarDataUrl = null;

  const cover = document.getElementById('cover-img');
  cover.removeAttribute('src');
  cover.classList.remove('loaded');
  document.getElementById('cover-hint').style.display = '';

  const avatar = document.getElementById('avatar-img');
  avatar.removeAttribute('src');
  avatar.classList.remove('loaded');
  document.getElementById('avatar-placeholder').style.display = '';

  document.getElementById('journal-meta').textContent = 'No entries yet';

  profileLoaded  = false;
  profileLoading = null;
}

// Cognito's raw errors are long and internal-sounding ("Password did not
// conform with policy: Password not long enough"), and they overflowed the
// toast. Turn them into something a person can act on; the original is kept
// in the console for debugging.
function authErrorMessage(err) {
  const code = (err && err.code) || '';
  const msg  = (err && err.message) || '';
  const weakPassword = 'Password needs 8+ characters, mixed case, a number and a symbol';

  if (code.includes('NotAuthorizedException'))    return 'Wrong email or password';
  if (code.includes('UserNotFoundException'))     return 'No account with that email';
  if (code.includes('UsernameExistsException'))   return 'That email already has an account';
  if (code.includes('UserNotConfirmedException')) return 'Confirm your email first — check your inbox';
  if (code.includes('CodeMismatchException'))     return "That code doesn't match";
  if (code.includes('ExpiredCodeException'))      return 'That code expired — sign up again to get a new one';
  if (code.includes('LimitExceededException'))    return 'Too many attempts — wait a minute and try again';
  if (code.includes('InvalidPasswordException'))  return weakPassword;
  if (msg.includes('Password did not conform'))   return weakPassword;
  if (code.includes('InvalidParameterException') && msg.toLowerCase().includes('email')) {
    return 'Enter a valid email address';
  }
  return msg || 'Something went wrong — try again';
}

function authFields() {
  return {
    email: document.getElementById('auth-email').value.trim(),
    password: document.getElementById('auth-password').value.trim(),
  };
}

async function signIn() {
  const { email, password } = authFields();
  if (!email || !password) {
    showToast('Enter email & password');
    return;
  }
  try {
    await window.CognitoAuth.signIn(email, password);
    showToast('Signed in ✓');
    updateAuthUI();
    goTo(2); //directly to eddit profile panel after sign-in
    await loadProfile();
  } catch (err) {
    console.warn('Sign-in:', err);
    showToast(authErrorMessage(err));
  }
}

async function signUp() {
  const { email, password } = authFields();
  if (!email || !password) {
    showToast('Enter email & password');
    return;
  }

  try{
    await window.CognitoAuth.signUp(email, password);
    document.getElementById('auth-confirmation-step').style.display = '';
    showToast('Confirmation code sent to email');
  } catch (err) {
    console.warn('Sign-up:', err);
    showToast(authErrorMessage(err));
  }
}

async function confirmSignUp() {
  const { email, password } = authFields();
  const code = document.getElementById('auth-confirmation-code').value.trim();
  if (!code) {
    showToast('Enter confirmation code');
    return;
  }
  try {
    await window.CognitoAuth.confirmSignUp(email, code);
    await window.CognitoAuth.signIn(email, password);
    document.getElementById('auth-confirmation-step').style.display = 'none';
    showToast('Signed in ✓');
    updateAuthUI();
    goTo(2); //directly to eddit profile panel after sign-in
    await loadProfile();
  } catch (err) {
    console.warn('Confirmation:', err);
    showToast(authErrorMessage(err));
  }
}

function signOut() {
  // Grab the address before the tokens go, so signing back in is one field.
  const email = window.CognitoAuth.currentEmail();
  window.CognitoAuth.signOut();

  clearProfile();

  const field = document.getElementById('auth-email');
  if (field && email) field.value = email;

  showToast('Signed out');
  updateAuthUI();
}

// Toggles any element with [data-auth="signed-in"] / [data-auth="signed-out"]
// based on current session state. Add those attributes to your login panel
// markup in index.html.
function updateAuthUI() {
  const signedIn = window.CognitoAuth.isSignedIn();
  document.querySelectorAll('[data-auth="signed-in"]').forEach((el) => {
    el.style.display = signedIn ? '' : 'none';
  });
  document.querySelectorAll('[data-auth="signed-out"]').forEach((el) => {
    el.style.display = signedIn ? 'none' : '';
  });

  const email = signedIn ? window.CognitoAuth.currentEmail() : null;

  const who = document.getElementById('auth-current-user');
  if (who) who.textContent = signedIn ? (email || 'your account') : '';

  // Prefill the card's email with the account it will be saved under, so
  // nobody has to retype it. dataset.autofilled records what we put there,
  // so a value the user typed themselves is never overwritten or cleared.
  const field = document.getElementById('input-email');
  if (field) {
    const ours = !field.value || field.value === field.dataset.autofilled;
    if (email && ours) {
      field.value = email;
      field.dataset.autofilled = email;
    } else if (!email && field.value === field.dataset.autofilled) {
      field.value = '';
      delete field.dataset.autofilled;
    }
  }
}
updateAuthUI();

// ─── Panel navigation ─────────────────────────────────────────────────────────
// Panel order: 0 = Profile, 1 = Menu, 2 = Settings, 3 = Political Identity, 4 = Journal, 5 = account
const track  = document.getElementById('track');
const dots   = document.querySelectorAll('.dot');
const PANEL_W = 340;
let current  = 0;

function goTo(index) {
  current = Math.max(0, Math.min(5, index));
  track.style.transform = `translateX(${-current * PANEL_W}px)`;
  dots.forEach((d, i) => d.classList.toggle('active', i === current));
}

// ─── Clock ────────────────────────────────────────────────────────────────────
function updateClock() {
  const d = new Date();
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  document.getElementById('clock').textContent = h + ':' + (m < 10 ? '0' : '') + m;
}
updateClock();
setInterval(updateClock, 10000);

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

// ─── Photo uploads ────────────────────────────────────────────────────────────
// Photos used to be sent exactly as picked. A phone camera produces 3-8MB per
// shot, base64 adds a third on top, and the card sends two at once — so a
// normal upload sailed past the API's body limit and came back 413 without a
// byte reaching S3. Shrinking here fixes that at the source, and makes saving
// and loading markedly faster besides.
const MAX_COVER_DIM  = 1600;  // displayed at 340px wide; generous for retina
const MAX_AVATAR_DIM = 800;   // displayed in a 72px circle
const IMAGE_QUALITY  = 0.85;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

// Decodes a picked file, scales the long edge down to `maxDim`, and returns a
// JPEG data URL. Throws with a readable message if the browser cannot decode
// the file at all — an iPhone HEIC on desktop Chrome, for instance.
async function shrinkImage(file, maxDim) {
  let source;
  let objectUrl;

  try {
    // Honours the EXIF orientation tag, so portrait photos don't come out
    // on their side.
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    objectUrl = URL.createObjectURL(file);
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error(`This browser can't read ${file.type || 'that file type'}`));
      img.src = objectUrl;
    });
  }

  try {
    const scale  = Math.min(1, maxDim / Math.max(source.width, source.height));
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(source.width  * scale);
    canvas.height = Math.round(source.height * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);

    // Step the quality down until it comfortably fits the request budget.
    let quality = IMAGE_QUALITY;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > MAX_PHOTO_BYTES && quality > 0.4) {
      quality -= 0.15;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    return dataUrl;
  } finally {
    if (source.close) source.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

// Shared by both pickers: shrink, show, and remember for the next save.
async function handlePhotoPick(input, { maxDim, imgId, hideId, assign }) {
  const file = input.files[0];
  if (!file) return;

  try {
    const dataUrl = await shrinkImage(file, maxDim);
    assign(dataUrl);

    const img = document.getElementById(imgId);
    img.src = dataUrl;
    img.classList.add('loaded');
    document.getElementById(hideId).style.display = 'none';
  } catch (err) {
    console.warn('photo upload:', err);
    showToast(err.message || "Couldn't read that image");
  } finally {
    // Let the same file be picked again after a failure.
    input.value = '';
  }
}

// Cover photo
document.getElementById('cover-input').addEventListener('change', function () {
  handlePhotoPick(this, {
    maxDim: MAX_COVER_DIM,
    imgId:  'cover-img',
    hideId: 'cover-hint',
    assign: (dataUrl) => { coverDataUrl = dataUrl; },
  });
});

// Avatar / profile photo (the blue circle icon)
document.getElementById('avatar-input').addEventListener('change', function () {
  handlePhotoPick(this, {
    maxDim: MAX_AVATAR_DIM,
    imgId:  'avatar-img',
    hideId: 'avatar-placeholder',
    assign: (dataUrl) => { avatarDataUrl = dataUrl; },
  });
});

// ─── Profile fields — save & update card ─────────────────────────────────────
function setChipValue(id, value) {
  const el = document.getElementById(id);
  if (value && value !== '') {
    el.textContent = value;
    el.classList.remove('empty');
  } else {
    el.textContent = 'Not set';
    el.classList.add('empty');
  }
}

async function saveProfile() {
  const title     = document.getElementById('sel-title').value;
  const ethnicity = document.getElementById('sel-ethnicity').value;
  const religion  = document.getElementById('sel-religion').value;
  const city      = document.getElementById('sel-city').value;
  const nameinput = document.getElementById('input-full_name').value;
  const email     = document.getElementById('input-email').value;

  setChipValue('disp-title',     title     || '');
  setChipValue('disp-ethnicity', ethnicity || '');
  setChipValue('disp-religion',  religion  || '');
  setChipValue('disp-city',      city      || '');
  setChipValue('disp-email',     email     || '');

  // Name / handle at the top of the profile body
  const nameEl = document.getElementById('disp-full_name');
  if (nameinput) {
    nameEl.textContent = nameinput;
    nameEl.classList.remove('empty');
  } else {
    nameEl.textContent = 'Your Name';
    nameEl.classList.add('empty');
  }

  const saved = await syncToServer();
  if (!saved) return; // syncToServer already shows why

  showToast('Profile updated ✓');
  setTimeout(() => goTo(0), 600);
}

// ─── Political identity (Panel 3) ────────────────────────────────────────────
let selectedPolitical = null;

function selectPolitical(el) {
  document.querySelectorAll('.political-option').forEach((btn) => btn.classList.remove('selected'));
  el.classList.add('selected');
  selectedPolitical = el.dataset.value;
}

 async function savePolitical() {
  if (!selectedPolitical) {
    showToast('Pick an option first');
    return;
  }
  const saved = await syncToServer();
  if(!saved) return; // SynctoServer already shows why

  showToast(`Saved: ${selectedPolitical} ✓`);
  setTimeout(() => goTo(1), 600);
}

// ─── Journal (Panel 4) ────────────────────────────────────────────────────────
async function saveJournal() {
  const text = document.getElementById('journal-input').value.trim();
  const meta = document.getElementById('journal-meta');

  if (!text) {
    showToast('Nothing to save yet');
    return;
  }

  const saved = await syncToServer();
  if(!saved) return; // SynctoServer already shows why

  //only stamp "last saved" if the save has succeeded

  const now = new Date();
  meta.textContent = `Last saved ${now.toLocaleDateString()} at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;


  showToast('Journal entry saved ✓');
}

// ─── Startup ──────────────────────────────────────────────────────────────────
// Someone arriving with a session already open sees an empty page otherwise —
// the card lives on the server, not in this browser. Pull it back on load.
// getAccessToken() rather than isSignedIn() so an expired-but-refreshable
// session still loads; loadProfile() refreshes the token on its way through.
window.addEventListener('load', () => {
  if (window.CognitoAuth.getAccessToken()) loadProfile();
});
