/**
 * Settings — Alert Preferences interactivity
 * Fetches GET /api/settings/notifications on load, binds controls,
 * debounces PUT at 500ms, optimistic updates with revert on error.
 */
(function () {
  'use strict';

  var skeleton = document.getElementById('settings-skeleton');
  var form = document.getElementById('settings-form');
  var toggle = document.getElementById('alerts-enabled');
  var toggleLabel = document.getElementById('alert-toggle');
  var children = document.getElementById('settings-children');
  var slider = document.getElementById('score-threshold');
  var readout = document.getElementById('threshold-readout');
  var freqImmediate = document.getElementById('freq-immediate');
  var freqDigest = document.getElementById('freq-digest');
  var freqImmediateCard = document.getElementById('freq-immediate-card');
  var freqDigestCard = document.getElementById('freq-digest-card');
  var digestHourPicker = document.getElementById('digest-hour-picker');
  var digestHour = document.getElementById('digest-hour');
  var saveIndicator = document.getElementById('save-indicator');

  if (!form) return; // guard: not on settings page

  var saveTimeout = null;
  var debounceTimer = null;
  var lastSavedPrefs = null;
  var rateLimitUntil = 0;
  var rateLimitInterval = null;

  // --- UI update helpers ---

  function updateToggleUI(enabled) {
    if (enabled) {
      toggleLabel.classList.add('alert-toggle--on');
      toggleLabel.setAttribute('aria-checked', 'true');
      children.classList.add('alert-settings__children--visible');
    } else {
      toggleLabel.classList.remove('alert-toggle--on');
      toggleLabel.setAttribute('aria-checked', 'false');
      children.classList.remove('alert-settings__children--visible');
    }
  }

  function updateSliderUI(val) {
    val = parseInt(val, 10);
    readout.textContent = val;
    slider.setAttribute('aria-valuenow', val);
    readout.className = 'threshold-slider__readout';
    if (val >= 80) {
      readout.classList.add('threshold-slider__readout--high');
      slider.className = 'threshold-slider__input threshold-slider__input--high';
    } else if (val >= 65) {
      readout.classList.add('threshold-slider__readout--medium');
      slider.className = 'threshold-slider__input threshold-slider__input--medium';
    } else {
      readout.classList.add('threshold-slider__readout--low');
      slider.className = 'threshold-slider__input threshold-slider__input--low';
    }
  }

  function updateFreqUI(freq) {
    if (freq === 'digest') {
      freqDigestCard.classList.add('frequency-card--selected');
      freqImmediateCard.classList.remove('frequency-card--selected');
      freqDigest.checked = true;
      digestHourPicker.style.display = '';
    } else {
      freqImmediateCard.classList.add('frequency-card--selected');
      freqDigestCard.classList.remove('frequency-card--selected');
      freqImmediate.checked = true;
      digestHourPicker.style.display = 'none';
    }
  }

  function showSaved() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveIndicator.classList.remove('save-indicator--visible');
    void saveIndicator.offsetWidth; // reflow to restart animation
    saveIndicator.classList.add('save-indicator--visible');
    saveTimeout = setTimeout(function () {
      saveIndicator.classList.remove('save-indicator--visible');
    }, 2000);
  }

  function showToast(msg, type) {
    if (typeof window.Toast !== 'undefined' && window.Toast.show) {
      window.Toast.show(msg, type || 'error');
    } else if (typeof window.showToast === 'function') {
      window.showToast(msg, type || 'error');
    }
  }

  // --- Preferences helpers ---

  function getPrefs() {
    return {
      alerts_enabled: toggle.checked,
      score_threshold: parseInt(slider.value, 10),
      frequency: freqDigest.checked ? 'digest' : 'immediate',
      digest_hour_utc: parseInt(digestHour.value, 10)
    };
  }

  function applyPrefs(p) {
    toggle.checked = p.alerts_enabled;
    updateToggleUI(p.alerts_enabled);
    slider.value = p.score_threshold;
    updateSliderUI(p.score_threshold);
    updateFreqUI(p.frequency);
    digestHour.value = p.digest_hour_utc;
  }

  function revertToLastSaved() {
    if (lastSavedPrefs) {
      applyPrefs(lastSavedPrefs);
    }
  }

  // --- Rate limit countdown ---

  function startRateLimitCountdown(retryAfterSec) {
    rateLimitUntil = Date.now() + retryAfterSec * 1000;
    setControlsDisabled(true);

    if (rateLimitInterval) clearInterval(rateLimitInterval);
    rateLimitInterval = setInterval(function () {
      var remaining = Math.ceil((rateLimitUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(rateLimitInterval);
        rateLimitInterval = null;
        setControlsDisabled(false);
        return;
      }
      showToast('Too many requests. Try again in ' + remaining + 's.', 'error');
    }, 1000);

    showToast('Too many requests. Try again in ' + retryAfterSec + 's.', 'error');
  }

  function setControlsDisabled(disabled) {
    toggle.disabled = disabled;
    slider.disabled = disabled;
    freqImmediate.disabled = disabled;
    freqDigest.disabled = disabled;
    digestHour.disabled = disabled;
    if (disabled) {
      toggleLabel.classList.add('alert-toggle--disabled');
    } else {
      toggleLabel.classList.remove('alert-toggle--disabled');
    }
  }

  // --- Save with debounce ---

  function scheduleSave() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(savePrefs, 500);
  }

  function savePrefs() {
    if (Date.now() < rateLimitUntil) return;

    var prefs = getPrefs();
    fetch('/api/settings/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs)
    })
      .then(function (res) {
        if (res.ok) {
          return res.json().then(function (data) {
            lastSavedPrefs = data.preferences || prefs;
            showSaved();
          });
        }

        // Handle rate limit
        if (res.status === 429) {
          var retryAfter = parseInt(res.headers.get('Retry-After'), 10) || 60;
          revertToLastSaved();
          startRateLimitCountdown(retryAfter);
          return;
        }

        return res.json().then(function (data) {
          if (data.error && data.error.code === 'RESUME_NOT_CONFIRMED') {
            // Revert toggle only; preserve other values
            toggle.checked = false;
            updateToggleUI(false);
            if (lastSavedPrefs) lastSavedPrefs.alerts_enabled = false;
            showToast(
              data.error.message || 'Please confirm a resume before enabling alerts.',
              'error'
            );
            return;
          }

          // Revert all on other errors
          revertToLastSaved();
          showToast(data.error ? data.error.message : 'Failed to save preferences.', 'error');
        });
      })
      .catch(function () {
        revertToLastSaved();
        showToast('Failed to save preferences. Please try again.', 'error');
      });
  }

  // --- Load current preferences ---

  fetch('/api/settings/notifications')
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      var p = data.preferences;
      lastSavedPrefs = {
        alerts_enabled: p.alerts_enabled,
        score_threshold: p.score_threshold,
        frequency: p.frequency,
        digest_hour_utc: p.digest_hour_utc
      };
      applyPrefs(p);
      skeleton.style.display = 'none';
      form.style.display = '';
    })
    .catch(function () {
      skeleton.style.display = 'none';
      form.style.display = '';
    });

  // --- Event listeners ---

  toggle.addEventListener('change', function () {
    updateToggleUI(toggle.checked);
    scheduleSave();
  });

  slider.addEventListener('input', function () {
    updateSliderUI(slider.value);
  });

  slider.addEventListener('change', function () {
    scheduleSave();
  });

  freqImmediate.addEventListener('change', function () {
    updateFreqUI('immediate');
    scheduleSave();
  });

  freqDigest.addEventListener('change', function () {
    updateFreqUI('digest');
    scheduleSave();
  });

  digestHour.addEventListener('change', function () {
    scheduleSave();
  });
})();
