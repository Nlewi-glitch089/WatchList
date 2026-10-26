// Shared form helpers: inline field errors that are linked to their inputs,
// so screen readers announce the error along with the field.

function setDescribedBy(input, id, include) {
  const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== id);
  if (include) ids.unshift(id);
  if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
  else input.removeAttribute('aria-describedby');
}

// Shows `message` in the field's #<input id>-error element and marks the input invalid.
function setFieldError(input, message) {
  const error = document.getElementById(`${input.id}-error`);
  error.textContent = message;
  error.hidden = false;
  input.setAttribute('aria-invalid', 'true');
  setDescribedBy(input, error.id, true);
}

function clearFieldError(input) {
  const error = document.getElementById(`${input.id}-error`);
  error.textContent = '';
  error.hidden = true;
  input.removeAttribute('aria-invalid');
  setDescribedBy(input, error.id, false);
}

// Puts a submit button into (or out of) its busy state without losing its label.
function setButtonBusy(button, busy, busyLabel) {
  const label = button.querySelector('.btn-label');
  if (!button.dataset.label) button.dataset.label = label.textContent;
  button.disabled = busy;
  button.classList.toggle('is-busy', busy);
  label.textContent = busy ? busyLabel : button.dataset.label;
}
