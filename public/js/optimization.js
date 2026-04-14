/**
 * Optimization Suggestions — client-side interactivity
 * Feature: resume-optimization
 *
 * Handles: POST trigger, loading state, DOM update, error handling,
 * Show More toggle, View Suggestions toggle, client-side timeout,
 * focus management, rate-limit countdown, relative time.
 */
(function () {
  'use strict';

  var panel = document.getElementById('optimization-panel');
  if (!panel) return; // not on a page with the optimization panel

  var jobId = panel.getAttribute('data-job-id');
  var improveBtn = document.getElementById('opt-improve-btn');
  var improveText = document.getElementById('opt-improve-text');
  var viewBtn = document.getElementById('opt-view-btn');
  var skeleton = document.getElementById('optimization-skeleton');
  var content = document.getElementById('optimization-content');
  var errorContainer = document.getElementById('optimization-error');
  var errorText = document.getElementById('optimization-error-text');
  var heading = document.getElementById('optimization-heading');
  var showMoreBtn = document.getElementById('opt-show-more-btn');
  var showMoreText = document.getElementById('opt-show-more-text');
  var buttonsDiv = document.getElementById('optimization-buttons');

  var CLIENT_TIMEOUT_MS = 12000;

  // ── Locale helper (reads from embedded data or falls back) ──

  var localeKeys = {
    analyzingResume: 'Analyzing your resume against this job...',
    improveResume: 'Improve Resume',
    viewSuggestions: 'View Suggestions',
    showMore: 'Show more suggestions',
    showFewer: 'Show fewer suggestions',
    currentScore: 'Current Score',
    predictedScore: 'Predicted Score',
    errorGeneric: 'Something went wrong. Please try again later.',
    errorTimeout: 'Suggestion generation timed out — please try again.',
    errorRateLimit: 'Too many requests — try again in a minute.',
    errorServiceBusy: 'Service temporarily busy — try again in a moment.',
    errorJobNotFound: 'This job is no longer available.',
    errorNoResumeOrScore: 'Upload a resume and score this job first.',
    partialResults: 'Showing {count} of potentially more suggestions. Tap to generate more.',
    fewerSuggestions: 'We found {count} suggestions for this job.',
    generatedAt: 'Generated {time}',
    categoryAddKeyword: 'Add Keyword',
    categoryRephraseExperience: 'Rephrase Experience',
    categoryAddMissingSkill: 'Add Missing Skill',
    updateResume: 'Update Your Resume'
  };

  // Try to read locale from the page's t() if available
  function t(key, fallback) {
    return localeKeys[key] || fallback || key;
  }

  // ── Utility helpers ──

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function relativeTime(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    var now = new Date();
    var diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function scoreTierClass(val) {
    if (val >= 75) return 'opt-score--high';
    if (val >= 50) return 'opt-score--mid';
    return 'opt-score--low';
  }

  var categoryMap = {
    add_keyword: { label: t('categoryAddKeyword'), cls: 'opt-badge--keyword' },
    rephrase_experience: { label: t('categoryRephraseExperience'), cls: 'opt-badge--rephrase' },
    add_missing_skill: { label: t('categoryAddMissingSkill'), cls: 'opt-badge--skill' }
  };

  // ── Show / hide helpers ──

  function showError(msg) {
    errorText.innerHTML = msg;
    errorContainer.style.display = '';
  }

  function hideError() {
    errorContainer.style.display = 'none';
    errorText.innerHTML = '';
  }

  function showSkeleton() {
    skeleton.style.display = '';
    skeleton.setAttribute('aria-busy', 'true');
  }

  function hideSkeleton() {
    skeleton.style.display = 'none';
    skeleton.setAttribute('aria-busy', 'false');
  }

  function disableImproveBtn() {
    if (!improveBtn) return;
    improveBtn.setAttribute('aria-disabled', 'true');
    improveBtn.disabled = true;
  }

  function enableImproveBtn() {
    if (!improveBtn) return;
    improveBtn.removeAttribute('aria-disabled');
    improveBtn.disabled = false;
    improveBtn.classList.remove('opt-btn--rate-limited');
    if (improveText) improveText.textContent = t('improveResume');
  }

  // ── Build Improve button dynamically (for when View Suggestions was shown initially) ──

  function ensureImproveBtn() {
    if (improveBtn) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'opt-improve-btn';
    btn.className = 'opt-btn opt-btn--primary';
    btn.innerHTML =
      '<svg class="opt-btn__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M8 2l1.5 3.5L13 7l-3.5 1.5L8 12l-1.5-3.5L3 7l3.5-1.5L8 2z" fill="currentColor"/>' +
      '</svg>' +
      '<span id="opt-improve-text">' + escapeHtml(t('improveResume')) + '</span>';
    buttonsDiv.innerHTML = '';
    buttonsDiv.appendChild(btn);
    improveBtn = btn;
    improveText = document.getElementById('opt-improve-text');
    improveBtn.addEventListener('click', handleImproveClick);
  }

  // ── Render suggestions into DOM ──

  function renderSuggestions(data) {
    var suggestions = data.suggestions || [];
    var currentScore = data.current_score;
    var predictedScore = data.predicted_score;
    var partial = data.partial;
    var generatedAt = data.generated_at;
    var delta = Math.round(predictedScore - currentScore);

    var html = '';

    // Score visualization
    html += '<div class="optimization-scores">';
    html += buildScoreRing(currentScore, t('currentScore'), false);
    html += '<div class="optimization-scores__arrow optimization-scores__arrow--right" aria-hidden="true">' +
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
    html += '<div class="optimization-scores__arrow optimization-scores__arrow--down" aria-hidden="true">' +
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M6 13l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
    html += buildScoreRing(predictedScore, t('predictedScore'), partial);
    html += '</div>';

    // Delta summary
    html += '<p class="optimization-scores__delta">+' + delta + ' pts potential improvement</p>';

    // Partial banner
    if (partial) {
      html += '<div class="optimization-banner optimization-banner--partial">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.2"/><path d="M8 5v4M8 11v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        '<span>' + escapeHtml(t('partialResults').replace('{count}', suggestions.length)) + '</span></div>';
    }

    // Suggestion cards
    html += '<div class="optimization-cards" role="list">';
    suggestions.forEach(function (item, idx) {
      var cat = categoryMap[item.category] || { label: item.category, cls: '' };
      html += '<article class="optimization-card' + (idx >= 3 ? ' optimization-card--hidden' : '') + '" role="listitem" data-suggestion-index="' + idx + '">';
      html += '<div class="optimization-card__header">';
      html += '<span class="opt-badge ' + cat.cls + '">' + escapeHtml(cat.label) + '</span>';
      html += '<span class="optimization-card__delta">~+' + item.predicted_delta + ' pts</span>';
      html += '</div>';
      html += '<p class="optimization-card__action">' + escapeHtml(item.what) + '</p>';
      html += '<div class="optimization-card__meta">';
      html += '<span class="optimization-card__section">' +
        '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1"/><path d="M3 4h6M3 6h4M3 8h5" stroke="currentColor" stroke-width="0.8" stroke-linecap="round"/></svg> ' +
        escapeHtml(item.where) + '</span>';
      html += '<span class="optimization-card__addresses">Addresses: ' + escapeHtml(item.addresses) + '</span>';
      html += '</div></article>';
    });
    html += '</div>';

    // Show more
    if (suggestions.length > 3) {
      html += '<button type="button" id="opt-show-more-btn" class="opt-show-more">' +
        '<span id="opt-show-more-text">' + escapeHtml(t('showMore')) + ' (+' + (suggestions.length - 3) + ' more)</span>' +
        '<svg class="opt-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>';
    }

    // Fewer note
    if (suggestions.length > 0 && suggestions.length < 3) {
      html += '<p class="optimization-fewer">' + escapeHtml(t('fewerSuggestions').replace('{count}', suggestions.length)) + '</p>';
    }

    // Footer
    html += '<div class="optimization-footer">';
    html += '<a href="/resumes" class="optimization-footer__link">' +
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 1v10M1 6l5 5 5-5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg> ' +
      escapeHtml(t('updateResume')) + '</a>';
    if (generatedAt) {
      html += '<time class="optimization-footer__time" datetime="' + escapeHtml(generatedAt) + '" data-generated-at="' + escapeHtml(generatedAt) + '">' +
        escapeHtml(t('generatedAt').replace('{time}', relativeTime(generatedAt))) + '</time>';
    }
    html += '</div>';

    content.innerHTML = html;
    content.style.display = '';
    content.style.opacity = '';

    // Rebind show more
    var newShowMore = document.getElementById('opt-show-more-btn');
    if (newShowMore) {
      newShowMore.addEventListener('click', handleShowMore);
      showMoreBtn = newShowMore;
      showMoreText = document.getElementById('opt-show-more-text');
    }
  }

  function buildScoreRing(score, label, isPartial) {
    var rounded = Math.round(score);
    var offset = 100 - rounded;
    var tier = scoreTierClass(score);
    var prefix = isPartial ? '~' : '';
    return '<div class="optimization-scores__ring-container">' +
      '<svg class="optimization-scores__ring" viewBox="0 0 36 36" role="img" aria-label="' + escapeHtml(label) + ': ' + rounded + ' out of 100">' +
      '<circle class="optimization-scores__track" cx="18" cy="18" r="15.9155"/>' +
      '<circle class="optimization-scores__fill ' + tier + (isPartial ? ' optimization-scores__fill--partial' : '') + '" cx="18" cy="18" r="15.9155" style="stroke-dashoffset: ' + offset + ';" data-target-offset="' + offset + '"/>' +
      '<text class="optimization-scores__number" x="18" y="18" text-anchor="middle" dominant-baseline="central">' + prefix + rounded + '</text>' +
      '</svg>' +
      '<span class="optimization-scores__label">' + escapeHtml(label) + '</span></div>';
  }

  // ── Error handling by HTTP status ──

  function handleError(status, body) {
    hideSkeleton();
    var msg = '';

    switch (status) {
      case 401:
        window.location.href = '/auth/login?redirect=/jobs/' + jobId;
        return;
      case 404:
        msg = escapeHtml(t('errorJobNotFound')) +
          ' <a href="/jobs">Back to listings</a>';
        break;
      case 409:
        msg = escapeHtml(t('errorNoResumeOrScore')) +
          ' <a href="/resumes">Upload resume</a>';
        // Hide button — precondition no longer met
        if (improveBtn) improveBtn.style.display = 'none';
        showError(msg);
        return;
      case 429:
        msg = escapeHtml(t('errorRateLimit'));
        showError(msg);
        startRateLimitCountdown(60);
        return;
      case 503:
        msg = escapeHtml(t('errorServiceBusy'));
        showError(msg);
        setTimeout(enableImproveBtn, 10000);
        return;
      case 504:
        msg = escapeHtml(t('errorTimeout'));
        break;
      default:
        msg = escapeHtml(t('errorGeneric'));
        break;
    }

    showError(msg);
    enableImproveBtn();
  }

  // ── Rate-limit 60s countdown ──

  var countdownInterval = null;

  function startRateLimitCountdown(seconds) {
    if (!improveBtn) return;
    disableImproveBtn();
    improveBtn.classList.add('opt-btn--rate-limited');
    var remaining = seconds;

    function tick() {
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        countdownInterval = null;
        enableImproveBtn();
        return;
      }
      if (improveText) improveText.textContent = 'Try again in ' + remaining + 's';
      // Announce every 15 seconds for screen readers
      if (remaining % 15 === 0 && errorContainer.style.display !== 'none') {
        errorText.textContent = t('errorRateLimit') + ' (' + remaining + 's)';
      }
      remaining--;
    }

    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  // ── POST handler ──

  function handleImproveClick() {
    hideError();
    disableImproveBtn();

    // Show spinner in button
    if (improveBtn) {
      var iconEl = improveBtn.querySelector('.opt-btn__icon');
      if (iconEl) {
        iconEl.outerHTML =
          '<svg class="opt-btn__icon opt-btn__spinner" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
          '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-dasharray="20 12" fill="none"/></svg>';
      }
    }
    if (improveText) improveText.textContent = t('analyzingResume');

    showSkeleton();
    content.style.display = 'none';

    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, CLIENT_TIMEOUT_MS);

    fetch('/api/jobs/' + jobId + '/optimization-suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal
    })
      .then(function (res) {
        clearTimeout(timeoutId);
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            handleError(res.status, body);
            throw new Error('handled');
          });
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        hideSkeleton();
        renderSuggestions(data);

        // Swap to View Suggestions button
        buttonsDiv.innerHTML =
          '<button type="button" id="opt-view-btn" class="opt-btn opt-btn--secondary">' +
          '<span>' + escapeHtml(t('viewSuggestions')) + '</span>' +
          '<svg class="opt-chevron opt-chevron--rotated" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
          '<path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>';
        viewBtn = document.getElementById('opt-view-btn');
        improveBtn = null;
        improveText = null;
        viewBtn.addEventListener('click', handleViewToggle);

        // Focus management — move focus to heading
        if (heading) {
          heading.focus();
        }
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        if (err.message === 'handled') return;
        // AbortError = client-side timeout
        if (err.name === 'AbortError') {
          hideSkeleton();
          handleError(504, {});
          return;
        }
        hideSkeleton();
        handleError(0, {});
      });
  }

  // ── View Suggestions toggle ──

  function handleViewToggle() {
    var isVisible = content.style.display !== 'none';
    content.style.display = isVisible ? 'none' : '';
    var chevron = viewBtn.querySelector('.opt-chevron');
    if (chevron) {
      chevron.classList.toggle('opt-chevron--rotated');
    }
  }

  // ── Show More toggle ──

  var showMoreExpanded = false;

  function handleShowMore() {
    showMoreExpanded = !showMoreExpanded;
    var hiddenCards = content.querySelectorAll('.optimization-card--hidden');
    var allCards = content.querySelectorAll('.optimization-card[data-suggestion-index]');

    if (showMoreExpanded) {
      // Reveal all
      allCards.forEach(function (card) {
        card.classList.remove('optimization-card--hidden');
      });
      if (showMoreText) showMoreText.textContent = t('showFewer');
    } else {
      // Hide cards with index >= 3
      allCards.forEach(function (card) {
        var idx = parseInt(card.getAttribute('data-suggestion-index'), 10);
        if (idx >= 3) card.classList.add('optimization-card--hidden');
      });
      if (showMoreText) {
        var hiddenCount = allCards.length - 3;
        showMoreText.textContent = t('showMore') + ' (+' + hiddenCount + ' more)';
      }
    }

    var chevron = showMoreBtn.querySelector('.opt-chevron');
    if (chevron) {
      chevron.classList.toggle('opt-chevron--rotated');
    }
  }

  // ── Bind events ──

  if (improveBtn) {
    improveBtn.addEventListener('click', handleImproveClick);
  }

  if (viewBtn) {
    viewBtn.addEventListener('click', handleViewToggle);
  }

  if (showMoreBtn) {
    showMoreBtn.addEventListener('click', handleShowMore);
  }

  // Partial results "Tap to generate more" link
  panel.addEventListener('click', function (e) {
    if (e.target.closest('.optimization-banner--partial')) {
      ensureImproveBtn();
      handleImproveClick();
    }
  });

  // ── Relative time computation for existing timestamps ──

  var timeEls = panel.querySelectorAll('[data-generated-at]');
  timeEls.forEach(function (el) {
    var ts = el.getAttribute('data-generated-at');
    if (ts) {
      var key = t('generatedAt').replace('{time}', relativeTime(ts));
      el.textContent = key;
    }
  });
})();
