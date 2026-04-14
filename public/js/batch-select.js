(function () {
  'use strict';

  var MAX_SELECTION = 10;
  var selectedJobs = new Set();

  var floatingBar = document.getElementById('ba-select-bar');
  var countEl = document.getElementById('ba-select-count');
  var applyBtn = document.getElementById('ba-apply-all');
  var clearBtn = document.getElementById('ba-clear-selection');

  if (!floatingBar) return;

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';

  /* -----------------------------------------------------------------------
     Checkbox handling
     ----------------------------------------------------------------------- */

  function onCheckboxChange(e) {
    var input = e.target;
    if (!input.classList.contains('ba-select-input')) return;

    var jobId = parseInt(input.getAttribute('data-job-id'), 10);
    var wrapper = input.closest('.ba-select-wrapper');
    var card = input.closest('.job-card');

    if (input.checked) {
      if (selectedJobs.size >= MAX_SELECTION) {
        input.checked = false;
        return;
      }
      selectedJobs.add(jobId);
      if (wrapper) wrapper.querySelector('.ba-select-checkbox').classList.add('ba-select-checkbox--checked');
      if (card) card.classList.add('ba-select-card--checked');
    } else {
      selectedJobs.delete(jobId);
      if (wrapper) wrapper.querySelector('.ba-select-checkbox').classList.remove('ba-select-checkbox--checked');
      if (card) card.classList.remove('ba-select-card--checked');
    }

    updateFloatingBar();
    updateCheckboxStates();
  }

  document.addEventListener('change', onCheckboxChange);

  /* Also handle click on the visual checkbox div (for keyboard/screen readers the input handles it) */
  document.addEventListener('click', function (e) {
    var checkbox = e.target.closest('.ba-select-checkbox');
    if (!checkbox) return;
    var input = checkbox.parentElement.querySelector('.ba-select-input');
    if (input && e.target !== input) {
      e.preventDefault();
      e.stopPropagation();
      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  /* -----------------------------------------------------------------------
     Floating bar visibility and count
     ----------------------------------------------------------------------- */

  function updateFloatingBar() {
    if (selectedJobs.size > 0) {
      floatingBar.classList.add('ba-select-bar--visible');
    } else {
      floatingBar.classList.remove('ba-select-bar--visible');
    }

    if (countEl) {
      if (selectedJobs.size >= MAX_SELECTION) {
        countEl.textContent = MAX_SELECTION + ' jobs selected (maximum)';
        countEl.classList.add('ba-select-bar__count--max');
      } else {
        countEl.textContent = selectedJobs.size + ' job' + (selectedJobs.size !== 1 ? 's' : '') + ' selected';
        countEl.classList.remove('ba-select-bar__count--max');
      }
    }

    /* Announce to screen readers */
    floatingBar.setAttribute('aria-label', selectedJobs.size + ' jobs selected');
  }

  function updateCheckboxStates() {
    var allInputs = document.querySelectorAll('.ba-select-input');
    allInputs.forEach(function (input) {
      var jobId = parseInt(input.getAttribute('data-job-id'), 10);
      if (!selectedJobs.has(jobId) && selectedJobs.size >= MAX_SELECTION) {
        input.disabled = true;
        var wrapper = input.closest('.ba-select-wrapper');
        if (wrapper) wrapper.querySelector('.ba-select-checkbox').classList.add('ba-select-checkbox--disabled');
      } else {
        input.disabled = false;
        var wrapper2 = input.closest('.ba-select-wrapper');
        if (wrapper2) wrapper2.querySelector('.ba-select-checkbox').classList.remove('ba-select-checkbox--disabled');
      }
    });
  }

  /* -----------------------------------------------------------------------
     Clear selection
     ----------------------------------------------------------------------- */

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      clearSelection();
    });
  }

  function clearSelection() {
    selectedJobs.clear();
    var allInputs = document.querySelectorAll('.ba-select-input');
    allInputs.forEach(function (input) {
      input.checked = false;
      input.disabled = false;
      var wrapper = input.closest('.ba-select-wrapper');
      if (wrapper) {
        wrapper.querySelector('.ba-select-checkbox').classList.remove('ba-select-checkbox--checked');
        wrapper.querySelector('.ba-select-checkbox').classList.remove('ba-select-checkbox--disabled');
      }
      var card = input.closest('.job-card');
      if (card) card.classList.remove('ba-select-card--checked');
    });
    updateFloatingBar();
  }

  /* Escape clears selection */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && selectedJobs.size > 0) {
      clearSelection();
    }
  });

  /* -----------------------------------------------------------------------
     Apply All — preflight + hidden form submit
     ----------------------------------------------------------------------- */

  if (applyBtn) {
    applyBtn.addEventListener('click', function () {
      if (selectedJobs.size === 0) return;
      applyBtn.disabled = true;
      applyBtn.textContent = 'Checking...';

      var jobIds = Array.from(selectedJobs);

      /* Build form-encoded body for preflight */
      var body = jobIds.map(function (id) {
        return 'jobIds=' + encodeURIComponent(id);
      }).join('&');

      fetch('/batch-apply/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': csrfToken
        },
        body: body
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Preflight failed');
          return res.json();
        })
        .then(function (data) {
          if (data.jobsMissingCoverLetter && data.jobsMissingCoverLetter.length > 0) {
            showCoverLetterWarning(jobIds);
          } else {
            submitBatchForm(jobIds);
          }
        })
        .catch(function () {
          if (window.Toast) window.Toast.show('Failed to start batch apply. Please try again.', 'error');
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply All';
        });
    });
  }

  /* -----------------------------------------------------------------------
     Cover letter warning dialog
     ----------------------------------------------------------------------- */

  function showCoverLetterWarning(jobIds) {
    var backdrop = document.getElementById('ba-coverLetter-dialog');

    if (!backdrop) {
      /* Create dialog dynamically */
      backdrop = document.createElement('div');
      backdrop.id = 'ba-coverLetter-dialog';
      backdrop.className = 'ba-dialog-backdrop ba-dialog-backdrop--open';
      backdrop.setAttribute('role', 'alertdialog');
      backdrop.setAttribute('aria-modal', 'true');
      backdrop.innerHTML =
        '<div class="ba-dialog">' +
        '  <h3 class="ba-dialog__title">Missing Cover Letters</h3>' +
        '  <p class="ba-dialog__body">Some selected jobs will be submitted without a cover letter. Continue?</p>' +
        '  <div class="ba-dialog__actions">' +
        '    <button type="button" class="ba-dialog__btn ba-dialog__btn--cancel" id="ba-cl-cancel">Cancel</button>' +
        '    <button type="button" class="ba-dialog__btn ba-dialog__btn--confirm" id="ba-cl-continue">Continue Anyway</button>' +
        '  </div>' +
        '</div>';
      document.body.appendChild(backdrop);
    } else {
      backdrop.classList.add('ba-dialog-backdrop--open');
    }

    var cancelBtn2 = document.getElementById('ba-cl-cancel');
    var continueBtn = document.getElementById('ba-cl-continue');

    function dismiss() {
      backdrop.classList.remove('ba-dialog-backdrop--open');
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply All';
    }

    cancelBtn2.addEventListener('click', dismiss, { once: true });
    continueBtn.addEventListener('click', function () {
      backdrop.classList.remove('ba-dialog-backdrop--open');
      submitBatchForm(jobIds);
    }, { once: true });

    backdrop.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') dismiss();
    });
  }

  /* -----------------------------------------------------------------------
     Hidden form submit to POST /batch-apply/start
     ----------------------------------------------------------------------- */

  function submitBatchForm(jobIds) {
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = '/batch-apply/start';
    form.style.display = 'none';

    jobIds.forEach(function (id) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'jobIds';
      input.value = id;
      form.appendChild(input);
    });

    document.body.appendChild(form);
    form.submit();
  }

})();
