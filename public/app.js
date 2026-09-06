// ─── Server sync (Next.js API route, backed by AWS + Cognito auth) ───────────
// Points at the /api/save-profile route from the nextjs-api project
// (S3 for photos, DynamoDB for profile/journal data), guarded by Cognito.
// Base URL now comes from config.js so it's set in one place — update
// public/config.js's apiBaseUrl, not this file.
const API_BASE_URL = window.APP_CONFIG.apiBaseUrl;

// Filled in by the photo upload handlers below; sent up as base64 data URLs
// so the API route can push them to S3.
let coverDataUrl  = null;
let avatarDataUrl = null;

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

    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('syncToServer failed (continuing offline):', err);
    showToast('Save failed — check your connection');
    return null;
  }
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
  } catch (err) {
    showToast(err.message || 'Sign-in failed');
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
    showToast(err.message || 'Sign-up failed');
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
  } catch (err) {
    showToast(err.message || 'Confirmation failed');
  }
}

function signOut() {
  window.CognitoAuth.signOut();
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

  const who = document.getElementById('auth-current-user');
  if (who) who.textContent = signedIn ? (window.CognitoAuth.currentEmail() || 'your account') : '';
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
// Cover photo
document.getElementById('cover-input').addEventListener('change', function () {
  const file = this.files[0]; // this refers to document.getElementById('cover-input')
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img  = document.getElementById('cover-img');
    const hint = document.getElementById('cover-hint');
    coverDataUrl = e.target.result;
    img.src = coverDataUrl;
    img.classList.add('loaded');
    hint.style.display = 'none';
  };
  reader.readAsDataURL(file);
});

// Avatar / profile photo (the blue circle icon)
document.getElementById('avatar-input').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img         = document.getElementById('avatar-img');
    const placeholder = document.getElementById('avatar-placeholder');
    avatarDataUrl = e.target.result;
    img.src = avatarDataUrl;
    img.classList.add('loaded');
    placeholder.style.display = 'none';
  };
  reader.readAsDataURL(file);
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

  const saved = await syncToServer();
  if(!saved) return; // SynctoServer already shows why

  showToast('Profile saved ✓');
  setTimeout(() => goTo(0), 600);
  
  // Name / handle at the top of the profile body
  const nameEl = document.getElementById('disp-full_name');
  if (nameinput) {
    nameEl.textContent = nameinput;
    nameEl.classList.remove('empty');
  } else {
    nameEl.textContent = 'Your Name';
    nameEl.classList.add('empty');
  }
  setChipValue('disp-email', email || '');

  syncToServer();

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
