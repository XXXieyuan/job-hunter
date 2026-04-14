(function () {
  'use strict';

  var container = document.querySelector('[data-session-id]');
  if (!container) return;

  var sessionId = container.getAttribute('data-session-id');
  var sessionStatus = container.getAttribute('data-session-status');

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';

  /* -----------------------------------------------------------------------
     SSE connection (only for active sessions)
     ----------------------------------------------------------------------- */

  var evtSource = null;

  if (sessionStatus === 'pending' || sessionStatus === 'in-progress') {
    evtSource = new EventSource('/batch-apply/progress/' + sessionId + '/events');

    evtSource.addEventListener('job-start', function (e) {
      var data = JSON.parse(e.data);
      updateJobCard(data.jobId, 'in-progress', {
        title: data.title,
        company: data.company
      });
    });

    evtSource.addEventListener('awaiting-submit', function (e) {
      var data = JSON.parse(e.data);
      updateJobCard(data.jobId, 'awaiting-submit', {
        filledFields: data.filledFields,
        warnings: data.warnings
      });
      showActiveOverlay(data.jobId);
    });

    evtSource.addEventListener('applied', function (e) {
      var data = JSON.parse(e.data);
      updateJobCard(data.jobId, 'applied');
      hideActiveOverlay();
      incrementCounter('applied');
      announceStatus('Applied to job');
    });

    evtSource.addEventListener('skipped', function (e) {
      var data = JSON.parse(e.data);
      updateJobCard(data.jobId, 'skipped');
      hideActiveOverlay();
      incrementCounter('skipped');
    });

    evtSource.addEventListener('failed', function (e) {
      var data = JSON.parse(e.data);
      updateJobCard(data.jobId, 'failed', {
        errorReason: data.errorReason
      });
      hideActiveOverlay();
      incrementCounter('failed');
    });

    evtSource.addEventListener('captcha-detected', function () {
      var notice = document.getElementById('ba-captcha-notice');
      if (notice) notice.style.display = '';
    });

    evtSource.addEventListener('rate-limited', function () {
      var notice = document.getElementById('ba-rate-limited-notice');
      if (notice) notice.style.display = '';
    });

    evtSource.addEventListener('error', function (e) {
      if (e.data) {
        var data = JSON.parse(e.data);
        var notice = document.getElementById('ba-error-notice');
        var msgEl = document.getElementById('ba-error-message');
        if (notice && msgEl) {
          msgEl.textContent = data.message || 'An error occurred.';
          notice.style.display = '';
        }
      }
    });

    evtSource.addEventListener('batch-complete', function (e) {
      var data = JSON.parse(e.data);
      hideActiveOverlay();
      hideCancelButton();
      updateSessionBadge('completed');
      if (data.summary) {
        setCounter('applied', data.summary.applied);
        setCounter('failed', data.summary.failed);
        setCounter('skipped', data.summary.skipped);
      }
      announceStatus('Batch complete');
      closeSSE();
    });

    evtSource.addEventListener('batch-cancelled', function () {
      hideActiveOverlay();
      hideCancelButton();
      updateSessionBadge('cancelled');
      announceStatus('Batch cancelled');
      closeSSE();
    });

    /* On EventSource error, reload page to sync from DB state */
    evtSource.onerror = function () {
      closeSSE();
      setTimeout(function () {
        window.location.reload();
      }, 2000);
    };
  }

  function closeSSE() {
    if (evtSource) {
      evtSource.close();
      evtSource = null;
    }
  }

  /* -----------------------------------------------------------------------
     DOM update helpers
     ----------------------------------------------------------------------- */

  var statusBadgeClasses = {
    'pending': 'ba-job-badge--pending',
    'in-progress': 'ba-job-badge--in-progress',
    'awaiting-submit': 'ba-job-badge--awaiting-submit',
    'applied': 'ba-job-badge--applied',
    'failed': 'ba-job-badge--failed',
    'skipped': 'ba-job-badge--skipped'
  };

  var statusCardClasses = {
    'pending': 'ba-job-card--pending',
    'in-progress': 'ba-job-card--in-progress',
    'awaiting-submit': 'ba-job-card--awaiting-submit',
    'applied': 'ba-job-card--applied',
    'failed': 'ba-job-card--failed',
    'skipped': 'ba-job-card--skipped'
  };

  var statusLabels = {
    'pending': 'Pending',
    'in-progress': 'In Progress',
    'awaiting-submit': 'Awaiting Submit',
    'applied': 'Applied',
    'failed': 'Failed',
    'skipped': 'Skipped'
  };

  var statusIcons = {
    'pending': '<svg class="ba-job-badge__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke-width="2"/><path d="M8 4v4l3 1.5" stroke-width="1.5" stroke-linecap="round"/></svg>',
    'in-progress': '<svg class="ba-job-badge__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M8 1.5A6.5 6.5 0 0114.5 8" stroke-width="2" stroke-linecap="round"/></svg>',
    'awaiting-submit': '<svg class="ba-job-badge__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3C4.7 3 2 5.1 1 8c1 2.9 3.7 5 7 5s6-2.1 7-5c-1-2.9-3.7-5-7-5zm0 8a3 3 0 110-6 3 3 0 010 6z"/></svg>',
    'applied': '<svg class="ba-job-badge__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm3.3 5.3l-4 4a.75.75 0 01-1.1 0l-2-2a.75.75 0 111.1-1.1L6.8 8.7l3.4-3.4a.75.75 0 111.1 1.1z"/></svg>',
    'failed': '<svg class="ba-job-badge__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm2.8 9.2a.75.75 0 01-1.1 1.1L8 9.6 6.3 11.3a.75.75 0 01-1.1-1.1L6.9 8.5 5.2 6.8a.75.75 0 011.1-1.1L8 7.4l1.7-1.7a.75.75 0 011.1 1.1L9.1 8.5l1.7 1.7z"/></svg>',
    'skipped': '<svg class="ba-job-badge__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.3 3.7a.75.75 0 011.1 0L8 6.3l2.6-2.6a.75.75 0 111.1 1.1L9.1 7.4l2.6 2.6a.75.75 0 01-1.1 1.1L8 8.5 5.4 11.1a.75.75 0 01-1.1-1.1L6.9 7.4 4.3 4.8a.75.75 0 010-1.1z"/></svg>'
  };

  function updateJobCard(jobId, status, extras) {
    var card = document.getElementById('ba-job-' + jobId);
    if (!card) return;

    /* Update card class */
    Object.keys(statusCardClasses).forEach(function (s) {
      card.classList.remove(statusCardClasses[s]);
    });
    card.classList.add(statusCardClasses[status] || 'ba-job-card--pending');
    card.setAttribute('data-status', status);

    /* Update badge */
    var badge = card.querySelector('.ba-job-badge');
    if (badge) {
      Object.keys(statusBadgeClasses).forEach(function (s) {
        badge.classList.remove(statusBadgeClasses[s]);
      });
      badge.classList.add(statusBadgeClasses[status] || 'ba-job-badge--pending');
      badge.setAttribute('aria-label', 'Status: ' + (statusLabels[status] || status));
      badge.innerHTML = (statusIcons[status] || '') + ' ' + (statusLabels[status] || status);
    }

    /* Show skip button for awaiting-submit */
    if (status === 'awaiting-submit') {
      var actionsDiv = card.querySelector('.ba-job-card__actions');
      if (!actionsDiv) {
        actionsDiv = document.createElement('div');
        actionsDiv.className = 'ba-job-card__actions';
        card.querySelector('.ba-job-card__content').appendChild(actionsDiv);
      }
      /* Only add skip button if not already present */
      if (!actionsDiv.querySelector('.ba-job-skip-btn')) {
        var skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'ba-job-skip ba-job-skip-btn';
        skipBtn.setAttribute('data-session-id', sessionId);
        skipBtn.setAttribute('data-job-id', jobId);
        skipBtn.textContent = 'Skip This Job';
        actionsDiv.appendChild(skipBtn);
      }
    }

    /* Show filled fields for awaiting-submit */
    if (extras && extras.filledFields && extras.filledFields.length > 0) {
      var fieldsDiv = document.createElement('div');
      fieldsDiv.className = 'ba-job-card__actions';
      fieldsDiv.style.flexWrap = 'wrap';
      extras.filledFields.forEach(function (field) {
        var chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:2px;padding:1px 8px;border-radius:12px;font-size:0.75rem;background:rgba(5,150,105,0.1);color:#059669;';
        chip.textContent = field;
        fieldsDiv.appendChild(chip);
      });
      card.querySelector('.ba-job-card__content').appendChild(fieldsDiv);
    }

    /* Show warnings */
    if (extras && extras.warnings && extras.warnings.length > 0) {
      var warnDiv = document.createElement('div');
      warnDiv.className = 'ba-job-card__actions';
      warnDiv.style.cssText = 'flex-wrap:wrap;margin-top:4px;';
      extras.warnings.forEach(function (warning) {
        var chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:2px;padding:1px 8px;border-radius:12px;font-size:0.75rem;background:rgba(217,119,6,0.1);color:#D97706;';
        chip.textContent = warning;
        warnDiv.appendChild(chip);
      });
      card.querySelector('.ba-job-card__content').appendChild(warnDiv);
    }

    /* Show error accordion for failed */
    if (status === 'failed' && extras && extras.errorReason) {
      var errorDetails = document.createElement('details');
      errorDetails.className = 'ba-job-error';
      var summary = document.createElement('summary');
      summary.className = 'ba-job-error__toggle';
      summary.textContent = 'View error details';
      var detail = document.createElement('div');
      detail.className = 'ba-job-error__detail ba-job-error__detail--open';
      detail.textContent = extras.errorReason;
      errorDetails.appendChild(summary);
      errorDetails.appendChild(detail);
      card.querySelector('.ba-job-card__content').appendChild(errorDetails);
    }

    /* Remove pending queue position text for non-pending */
    if (status !== 'pending') {
      var positionTexts = card.querySelectorAll('[style*="color: var(--color-text-muted"]');
      positionTexts.forEach(function (el) {
        if (el.textContent.match(/^\d+ of \d+$/)) {
          el.remove();
        }
      });
    }
  }

  /* -----------------------------------------------------------------------
     Active job overlay
     ----------------------------------------------------------------------- */

  function showActiveOverlay(jobId) {
    var overlay = document.getElementById('ba-active-overlay');
    if (!overlay) return;

    var card = document.getElementById('ba-job-' + jobId);
    var title = '';
    var company = '';
    if (card) {
      var titleEl = card.querySelector('.ba-job-card__title');
      var companyEl = card.querySelector('.ba-job-card__company');
      if (titleEl) title = titleEl.textContent;
      if (companyEl) company = companyEl.textContent;
    }

    var textEl = document.getElementById('ba-overlay-text') || overlay.querySelector('.ba-progress-overlay__text');
    if (textEl) {
      textEl.textContent = '';
      var prefix = document.createTextNode('Now reviewing: ');
      var titleStrong = document.createElement('strong');
      titleStrong.textContent = title;
      var atText = document.createTextNode(' at ');
      var companyStrong = document.createElement('strong');
      companyStrong.textContent = company;
      textEl.appendChild(prefix);
      textEl.appendChild(titleStrong);
      textEl.appendChild(atText);
      textEl.appendChild(companyStrong);
    }

    var skipBtn = document.getElementById('ba-overlay-skip');
    if (skipBtn) {
      skipBtn.setAttribute('data-job-id', jobId);
      skipBtn.disabled = false;
    }

    overlay.style.display = '';
  }

  function hideActiveOverlay() {
    var overlay = document.getElementById('ba-active-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /* -----------------------------------------------------------------------
     Summary counters and progress bar
     ----------------------------------------------------------------------- */

  var counters = { applied: 0, failed: 0, skipped: 0 };

  /* Initialize from DOM */
  var appliedEl = document.getElementById('ba-summary-applied');
  var failedEl = document.getElementById('ba-summary-failed');
  var skippedEl = document.getElementById('ba-summary-skipped');

  if (appliedEl) counters.applied = parseInt(appliedEl.textContent, 10) || 0;
  if (failedEl) counters.failed = parseInt(failedEl.textContent, 10) || 0;
  if (skippedEl) counters.skipped = parseInt(skippedEl.textContent, 10) || 0;

  function incrementCounter(type) {
    counters[type]++;
    setCounter(type, counters[type]);
  }

  function setCounter(type, value) {
    counters[type] = value;
    var el = document.getElementById('ba-summary-' + type);
    if (el) {
      el.textContent = value;
      /* Brief scale-up pulse animation */
      el.style.transform = 'scale(1.3)';
      setTimeout(function () { el.style.transform = 'scale(1)'; }, 200);
    }
    updateProgressBar();
  }

  function updateProgressBar() {
    var totalJobs = parseInt(container.querySelector('.ba-progress-bar') ?
      container.querySelector('.ba-progress-bar').getAttribute('aria-valuemax') : '0', 10) || 1;
    var totalProcessed = counters.applied + counters.failed + counters.skipped;

    var bar = document.getElementById('ba-progress-bar');
    if (bar) {
      bar.setAttribute('aria-valuenow', totalProcessed);
    }

    var appliedBar = document.getElementById('ba-bar-applied');
    var failedBar = document.getElementById('ba-bar-failed');
    var skippedBar = document.getElementById('ba-bar-skipped');

    if (appliedBar) appliedBar.style.width = ((counters.applied / totalJobs) * 100).toFixed(1) + '%';
    if (failedBar) failedBar.style.width = ((counters.failed / totalJobs) * 100).toFixed(1) + '%';
    if (skippedBar) skippedBar.style.width = ((counters.skipped / totalJobs) * 100).toFixed(1) + '%';
  }

  /* -----------------------------------------------------------------------
     Session badge update
     ----------------------------------------------------------------------- */

  function updateSessionBadge(status) {
    container.setAttribute('data-session-status', status);
  }

  function hideCancelButton() {
    var cancelBtn = document.getElementById('ba-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';
  }

  /* -----------------------------------------------------------------------
     Screen reader announcements
     ----------------------------------------------------------------------- */

  function announceStatus(message) {
    var liveRegion = document.getElementById('ba-sr-announcer');
    if (!liveRegion) {
      liveRegion = document.createElement('div');
      liveRegion.id = 'ba-sr-announcer';
      liveRegion.setAttribute('role', 'status');
      liveRegion.setAttribute('aria-live', 'polite');
      liveRegion.className = 'visually-hidden';
      document.body.appendChild(liveRegion);
    }
    liveRegion.textContent = message;
  }

  /* -----------------------------------------------------------------------
     Skip action (delegated)
     ----------------------------------------------------------------------- */

  document.addEventListener('click', function (e) {
    var skipBtn = e.target.closest('.ba-job-skip-btn, #ba-overlay-skip');
    if (!skipBtn) return;

    var sid = skipBtn.getAttribute('data-session-id');
    var jid = skipBtn.getAttribute('data-job-id');
    if (!sid || !jid) return;

    skipBtn.disabled = true;

    fetch('/batch-apply/skip/' + sid + '/' + jid, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      }
    })
      .then(function (res) {
        if (!res.ok) {
          skipBtn.disabled = false;
          if (window.Toast) window.Toast.show('Failed to skip job', 'error');
        }
      })
      .catch(function () {
        skipBtn.disabled = false;
        if (window.Toast) window.Toast.show('Failed to skip job', 'error');
      });
  });

  /* -----------------------------------------------------------------------
     Cancel batch action
     ----------------------------------------------------------------------- */

  var cancelBtn = document.getElementById('ba-cancel-btn');
  var cancelDialog = document.getElementById('ba-cancel-dialog');
  var cancelDismiss = document.getElementById('ba-cancel-dialog-dismiss');
  var cancelConfirm = document.getElementById('ba-cancel-dialog-confirm');

  if (cancelBtn && cancelDialog) {
    cancelBtn.addEventListener('click', function () {
      cancelDialog.classList.add('ba-dialog-backdrop--open');
      if (cancelDismiss) cancelDismiss.focus();
    });

    if (cancelDismiss) {
      cancelDismiss.addEventListener('click', function () {
        cancelDialog.classList.remove('ba-dialog-backdrop--open');
        cancelBtn.focus();
      });
    }

    if (cancelConfirm) {
      cancelConfirm.addEventListener('click', function () {
        cancelDialog.classList.remove('ba-dialog-backdrop--open');
        cancelBtn.disabled = true;

        fetch('/batch-apply/cancel/' + sessionId, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
          }
        })
          .then(function (res) {
            if (!res.ok) {
              cancelBtn.disabled = false;
              if (window.Toast) window.Toast.show('Failed to cancel batch', 'error');
            }
          })
          .catch(function () {
            cancelBtn.disabled = false;
            if (window.Toast) window.Toast.show('Failed to cancel batch', 'error');
          });
      });
    }

    /* Escape closes cancel dialog */
    cancelDialog.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        cancelDialog.classList.remove('ba-dialog-backdrop--open');
        cancelBtn.focus();
      }
    });
  }

})();
