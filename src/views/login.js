import { supabase } from '../supabase.js';

/**
 * Sign-in is a one-time code mailed by Supabase: enter the email, then type
 * the code into this same tab. There is no redirect, so nothing comes back in
 * the URL to fight the hash router, and a code read on the phone works on the
 * laptop.
 *
 * The code comes from the Magic Link email template's `{{ .Token }}`
 * (Supabase → Authentication → Emails). Its length is the project's
 * "Email OTP length" setting, so the field accepts 6–10 digits rather than
 * hard-coding one.
 */
const CODE_PATTERN = /^\d{6,10}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div id="login-page">
      <div class="login-bg-orb orb1"></div>
      <div class="login-bg-orb orb2"></div>
      <div class="login-bg-orb orb3"></div>

      <div class="login-card">
        <div class="login-logo">
          <div class="login-logo-icon" aria-hidden="true"><i class="fas fa-wallet"></i></div>
          <h1>FinanceHub</h1>
          <p>Your personal finance command centre</p>
        </div>

        <div class="login-features">
          <div class="login-feature"><i class="fas fa-check-circle"></i> Net Worth Tracking</div>
          <div class="login-feature"><i class="fas fa-check-circle"></i> Credit Card Points</div>
          <div class="login-feature"><i class="fas fa-check-circle"></i> Asset Allocation</div>
          <div class="login-feature"><i class="fas fa-check-circle"></i> FI Progress</div>
        </div>

        <div class="login-divider">Sign in with an email code</div>

        <form id="login-email-step" novalidate>
          <div class="login-form-group">
            <label for="email-input">Email address</label>
            <input type="email" id="email-input" placeholder="you@example.com" autocomplete="email" required />
          </div>
          <button type="submit" class="btn-primary" id="send-code-btn">
            <i class="fas fa-paper-plane" aria-hidden="true"></i>Send Code
          </button>
        </form>

        <form id="login-code-step" novalidate hidden>
          <div class="login-form-group">
            <label for="code-input">Code from the email</label>
            <input
              type="text"
              id="code-input"
              inputmode="numeric"
              autocomplete="one-time-code"
              pattern="[0-9]*"
              maxlength="10"
              placeholder="12345678"
              required
            />
          </div>
          <button type="submit" class="btn-primary" id="verify-code-btn">
            <i class="fas fa-right-to-bracket" aria-hidden="true"></i>Sign In
          </button>
          <div class="login-alt-actions">
            <button type="button" class="login-link-btn" id="resend-code-btn">Send a new code</button>
            <button type="button" class="login-link-btn" id="change-email-btn">Use a different email</button>
          </div>
        </form>

        <div class="login-status" id="login-status" role="status" aria-live="polite"></div>
      </div>
    </div>
  `;

  const emailStep = document.getElementById('login-email-step');
  const codeStep = document.getElementById('login-code-step');
  const emailInput = document.getElementById('email-input');
  const codeInput = document.getElementById('code-input');
  const sendBtn = document.getElementById('send-code-btn');
  const verifyBtn = document.getElementById('verify-code-btn');
  const resendBtn = document.getElementById('resend-code-btn');
  const status = document.getElementById('login-status');

  let email = '';

  /**
   * `parts` is text, or a list of text and nodes (see strong()). Never HTML:
   * this used to be innerHTML, and the messages carry server error strings —
   * and, before the email-code flow, an `error_description` read straight off
   * the URL, which made the login page an injection point.
   */
  function showStatus(parts, type) {
    status.replaceChildren(...[].concat(parts).map(p => (typeof p === 'string' ? document.createTextNode(p) : p)));
    status.className = `login-status ${type}`;
  }

  function strong(text) {
    const el = document.createElement('strong');
    el.textContent = text;
    return el;
  }

  /** Disable a button and swap its label for a spinner; returns the restorer. */
  function busy(btn, label) {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>${label}`;
    return () => { btn.disabled = false; btn.innerHTML = original; };
  }

  function showStep(step) {
    emailStep.hidden = step !== 'email';
    codeStep.hidden = step !== 'code';
    (step === 'email' ? emailInput : codeInput).focus();
  }

  async function sendCode(btn) {
    const done = busy(btn, 'Sending…');
    let error = null;
    try {
      // shouldCreateUser: false — this is a single-owner app; an unknown email
      // must not be able to mint itself an account through the login form.
      ({ error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }));
    } catch (e) {
      // createClient throws on a missing URL/key, and the request itself can
      // fail outright — without this the button just stuck on "Sending…".
      error = e;
    }
    done();
    return error;
  }

  emailStep.addEventListener('submit', async e => {
    e.preventDefault();
    const value = emailInput.value.trim();
    if (!EMAIL_PATTERN.test(value)) {
      showStatus('Please enter a valid email address.', 'error');
      return;
    }
    email = value;

    const error = await sendCode(sendBtn);
    if (error) {
      // otp_disabled is what shouldCreateUser: false returns for an unknown email.
      showStatus(
        error.code === 'otp_disabled'
          ? 'No account uses that email.'
          : `Error: ${error.message || 'Could not send the code. Please try again.'}`,
        'error'
      );
      return;
    }
    showStatus(['Code sent to ', strong(email), '. Enter it below.'], 'success');
    codeInput.value = '';
    showStep('code');
  });

  codeStep.addEventListener('submit', async e => {
    e.preventDefault();
    const token = codeInput.value.replace(/\s+/g, '');
    if (!CODE_PATTERN.test(token)) {
      showStatus('Enter the digits from the email.', 'error');
      return;
    }

    const done = busy(verifyBtn, 'Signing in…');
    let error = null;
    try {
      ({ error } = await supabase.auth.verifyOtp({ email, token, type: 'email' }));
    } catch (err) {
      error = err;
    }
    // On success onAuthStateChange swaps the login page for the app shell, so
    // only the failure path needs to touch this DOM again.
    if (!error) return;
    done();
    const expired = /expired|invalid/i.test(error.message || '');
    showStatus(
      expired
        ? 'That code is wrong or has expired. Check it, or send a new one.'
        : `Error: ${error.message || 'Could not sign in. Please try again.'}`,
      'error'
    );
    codeInput.select();
  });

  // Only digits belong in the field; strip pasted spaces or dashes as they land.
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D+/g, '');
  });

  resendBtn.addEventListener('click', async () => {
    const error = await sendCode(resendBtn);
    showStatus(
      error
        ? `Error: ${error.message || 'Could not send the code. Please try again.'}`
        : ['New code sent to ', strong(email), '. Earlier codes no longer work.'],
      error ? 'error' : 'success'
    );
    codeInput.value = '';
    codeInput.focus();
  });

  document.getElementById('change-email-btn').addEventListener('click', () => {
    status.className = 'login-status';
    showStep('email');
  });

  emailInput.focus();
}
