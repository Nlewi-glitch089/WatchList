// Handles the login and registration forms: validation, inline errors, and password visibility.
const form = document.getElementById('auth-form');
const message = document.getElementById('form-message');
const submitButton = form.querySelector('button[type="submit"]');
const isRegister = form.dataset.mode === 'register';
const lengthRule = document.getElementById('password-length-rule');
const passwordToggles = document.querySelectorAll('.password-toggle');

let submitted = false;
let submitting = false;

function showMessage(text) {
  message.textContent = text;
}

// Returns the error message for one field, or '' when it's valid.
function validateField(input) {
  const value = input.name === 'username' ? input.value.trim() : input.value;

  if (input.name === 'username') {
    if (!value) return isRegister ? 'Choose a username.' : 'Enter your username.';
    if (isRegister && !/^[A-Za-z0-9_]{3,30}$/.test(value)) {
      return 'Use 3–30 characters with only letters, numbers, or underscores (no spaces).';
    }
  }
  if (input.name === 'password') {
    if (!value) return isRegister ? 'Create a password.' : 'Enter your password.';
    if (isRegister && value.length < 8) {
      return `Use at least 8 characters. You've entered ${value.length}.`;
    }
    if (isRegister && value.length > 72) return 'Use 72 characters or fewer.';
  }
  if (input.name === 'confirm') {
    if (!value) return 'Re-enter your password to confirm it.';
    if (value !== form.password.value) return "Passwords don't match. Type the same password in both fields.";
  }
  return '';
}

function checkField(input) {
  const error = validateField(input);
  if (error) setFieldError(input, error);
  else clearFieldError(input);
  return error;
}

function updateLengthRule() {
  if (!lengthRule) return;
  const length = form.password.value.length;
  const met = length >= 8 && length <= 72;
  lengthRule.classList.toggle('is-met', met);
  lengthRule.querySelector('.req-state').textContent = met ? ' (met)' : '';
}

// Show/hide password buttons. Changing the input type keeps its value.
passwordToggles.forEach((button) => {
  const input = document.getElementById(button.getAttribute('aria-controls'));
  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.classList.toggle('is-visible', show);
    button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${button.dataset.name}`);
  });
});

function hidePasswords() {
  passwordToggles.forEach((button) => {
    if (button.classList.contains('is-visible')) button.click();
  });
}

// After the first submit attempt, errors update as the user fixes them.
form.addEventListener('input', (event) => {
  if (event.target.name === 'password') updateLengthRule();
  if (!submitted) return;
  checkField(event.target);
  if (event.target.name === 'password' && form.confirm && form.confirm.value) checkField(form.confirm);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  submitted = true;
  showMessage('');

  const inputs = [...form.querySelectorAll('input')];
  const invalid = inputs.filter((input) => checkField(input));
  if (invalid.length) {
    invalid[0].focus();
    return;
  }

  submitting = true;
  hidePasswords();
  setButtonBusy(submitButton, true, isRegister ? 'Creating account…' : 'Logging in…');

  try {
    await apiRequest(isRegister ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: { username: form.username.value.trim(), password: form.password.value },
      operation: isRegister ? 'create account' : 'log in',
    });
    window.location.href = '/';
  } catch (error) {
    submitting = false;
    setButtonBusy(submitButton, false);
    if (isRegister && error.status === 409) {
      setFieldError(form.username, 'That username is already taken. Try a different one.');
      form.username.focus();
    } else if (!isRegister && error.status === 401) {
      showMessage("That username and password don't match an account. Check both and try again — passwords are case-sensitive.");
      form.password.focus();
    } else {
      showMessage(error.message);
    }
  }
});
