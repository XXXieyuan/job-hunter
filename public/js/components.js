/**
 * Job Hunter – Component Interactions
 * Filter bar, status badge dropdown, resume uploader drag-and-drop
 */

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Filter Bar Interactions
  // -------------------------------------------------------------------------

  function initFilterBar() {
    // Min score slider value display
    var slider = document.getElementById('filter-min-score');
    var sliderValue = document.getElementById('min-score-value');
    if (slider && sliderValue) {
      slider.addEventListener('input', function () {
        sliderValue.textContent = slider.value;
      });
    }

    // Filter pill removal
    var pills = document.querySelectorAll('.filter-pill-remove');
    pills.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-filter-key');
        if (!key) return;
        removeFilterFromURL(key);
      });
    });
  }

  function removeFilterFromURL(key) {
    var url = new URL(window.location.href);
    url.searchParams.delete(key);
    window.location.href = url.toString();
  }

  // -------------------------------------------------------------------------
  // Status Badge Dropdown
  // -------------------------------------------------------------------------

  function initStatusBadges() {
    var wrappers = document.querySelectorAll('.status-badge-wrapper');
    wrappers.forEach(function (wrapper) {
      var trigger = wrapper.querySelector('.status-badge-trigger');
      var dropdown = wrapper.querySelector('.status-dropdown');
      if (!trigger || !dropdown) return;

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = !dropdown.hidden;
        closeAllStatusDropdowns();
        if (!isOpen) {
          dropdown.hidden = false;
          trigger.setAttribute('aria-expanded', 'true');
        }
      });

      var items = dropdown.querySelectorAll('.status-dropdown-item');
      items.forEach(function (item) {
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          var newStatus = item.getAttribute('data-status');
          var applicationId = wrapper.getAttribute('data-application-id');
          if (!newStatus || !applicationId) return;

          updateApplicationStatus(applicationId, newStatus, wrapper);
          dropdown.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
        });
      });
    });

    // Close dropdowns on outside click
    document.addEventListener('click', function () {
      closeAllStatusDropdowns();
    });
  }

  function closeAllStatusDropdowns() {
    var dropdowns = document.querySelectorAll('.status-dropdown');
    dropdowns.forEach(function (dd) {
      dd.hidden = true;
    });
    var triggers = document.querySelectorAll('.status-badge-trigger');
    triggers.forEach(function (t) {
      t.setAttribute('aria-expanded', 'false');
    });
  }

  function updateApplicationStatus(applicationId, newStatus, wrapper) {
    var csrfMeta = document.querySelector('meta[name="csrf-token"]');
    var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';

    if (newStatus === 'remove') {
      fetch('/api/applications/' + applicationId, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        }
      }).then(function (res) {
        if (res.ok) {
          wrapper.remove();
          if (window.Toast) window.Toast.show('Application removed', 'success');
        } else {
          if (window.Toast) window.Toast.show('Failed to remove application', 'error');
        }
      }).catch(function () {
        if (window.Toast) window.Toast.show('Failed to remove application', 'error');
      });
      return;
    }

    fetch('/api/applications/' + applicationId + '/status', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({ status: newStatus })
    }).then(function (res) {
      if (res.ok) {
        // Update the badge visually
        var trigger = wrapper.querySelector('.status-badge-trigger');
        if (trigger) {
          // Remove old badge class, add new
          var classes = trigger.className.split(' ');
          trigger.className = classes.filter(function (c) {
            return !c.startsWith('badge-') || c === 'badge';
          }).join(' ') + ' badge-' + newStatus;

          var statusLabels = {
            saved: 'Saved',
            applied: 'Applied',
            interviewing: 'Interviewing',
            offered: 'Offered',
            rejected: 'Rejected'
          };
          var statusIcons = {
            saved: '\u2605',
            applied: '\u2713',
            interviewing: '\u25CF',
            offered: '\u25C6',
            rejected: '\u2715'
          };

          trigger.innerHTML =
            '<span aria-hidden="true">' + (statusIcons[newStatus] || '') + '</span> ' +
            (statusLabels[newStatus] || newStatus) +
            ' <span aria-hidden="true" style="font-size: 10px; margin-left: 2px;">&#9662;</span>';
        }

        if (window.Toast) window.Toast.show('Status updated to ' + newStatus, 'success');
      } else {
        if (window.Toast) window.Toast.show('Failed to update status', 'error');
      }
    }).catch(function () {
      if (window.Toast) window.Toast.show('Failed to update status', 'error');
    });
  }

  // -------------------------------------------------------------------------
  // Resume Uploader Drag-and-Drop
  // -------------------------------------------------------------------------

  function initResumeUploader() {
    var uploadZone = document.querySelector('.upload-zone');
    var fileInput = document.getElementById('resume-file-input');
    if (!uploadZone || !fileInput) return;

    // Click to browse
    uploadZone.addEventListener('click', function () {
      fileInput.click();
    });

    // Drag and drop events
    uploadZone.addEventListener('dragenter', function (e) {
      e.preventDefault();
      e.stopPropagation();
      uploadZone.classList.add('drag-over');
    });

    uploadZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      uploadZone.classList.add('drag-over');
    });

    uploadZone.addEventListener('dragleave', function (e) {
      e.preventDefault();
      e.stopPropagation();
      uploadZone.classList.remove('drag-over');
    });

    uploadZone.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      uploadZone.classList.remove('drag-over');

      var files = e.dataTransfer.files;
      if (files.length > 0) {
        handleFileSelection(files[0], uploadZone, fileInput);
      }
    });

    // File input change
    fileInput.addEventListener('change', function () {
      if (fileInput.files.length > 0) {
        handleFileSelection(fileInput.files[0], uploadZone, fileInput);
      }
    });
  }

  function handleFileSelection(file, uploadZone, fileInput) {
    var maxSize = 10 * 1024 * 1024; // 10MB
    var allowedTypes = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (!allowedTypes.includes(file.type)) {
      if (window.Toast) window.Toast.show('Please upload a Word (.docx) file.', 'error');
      return;
    }

    if (file.size > maxSize) {
      if (window.Toast) window.Toast.show('File size exceeds 10MB limit.', 'error');
      return;
    }

    // Show selected file info
    var fileInfo = uploadZone.querySelector('.upload-zone-file-info');
    if (!fileInfo) {
      fileInfo = document.createElement('div');
      fileInfo.className = 'upload-zone-file-info';
      uploadZone.appendChild(fileInfo);
    }

    var sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    fileInfo.innerHTML =
      '<span>' + escapeHtml(file.name) + ' (' + sizeMB + ' MB)</span> ' +
      '<button type="button" class="btn btn-ghost btn-sm upload-zone-remove" aria-label="Remove file">Remove</button>';

    var removeBtn = fileInfo.querySelector('.upload-zone-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        fileInput.value = '';
        fileInfo.remove();
      });
    }

    // Transfer file to the hidden input
    var dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // -------------------------------------------------------------------------
  // Confirmation Dialog (Focus Trap, Escape to Dismiss)
  // -------------------------------------------------------------------------

  var ConfirmDialog = {
    /**
     * Show a confirmation dialog.
     * @param {object} options - { title, message, confirmText, cancelText, onConfirm, onCancel, danger }
     * @returns {HTMLElement} The overlay element
     */
    show: function (options) {
      var opts = options || {};
      var title = opts.title || 'Confirm';
      var message = opts.message || 'Are you sure?';
      var confirmText = opts.confirmText || 'Confirm';
      var cancelText = opts.cancelText || 'Cancel';
      var danger = opts.danger || false;

      var dialogId = 'confirm-dialog-' + Date.now();

      var overlay = document.createElement('div');
      overlay.className = 'confirm-dialog-overlay';
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', title);
      overlay.setAttribute('aria-describedby', dialogId + '-body');

      var dialog = document.createElement('div');
      dialog.className = 'confirm-dialog';

      var titleEl = document.createElement('h3');
      titleEl.className = 'confirm-dialog-title';
      titleEl.textContent = title;

      var bodyEl = document.createElement('p');
      bodyEl.className = 'confirm-dialog-body';
      bodyEl.id = dialogId + '-body';
      bodyEl.textContent = message;

      var actions = document.createElement('div');
      actions.className = 'confirm-dialog-actions';

      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost btn-sm';
      cancelBtn.type = 'button';
      cancelBtn.textContent = cancelText;

      var confirmBtn = document.createElement('button');
      confirmBtn.className = danger ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
      confirmBtn.type = 'button';
      confirmBtn.textContent = confirmText;

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      dialog.appendChild(titleEl);
      dialog.appendChild(bodyEl);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      // Focus trap: keep focus within dialog
      var focusableEls = [cancelBtn, confirmBtn];
      var firstFocusable = focusableEls[0];
      var lastFocusable = focusableEls[focusableEls.length - 1];
      confirmBtn.focus();

      function trapFocus(e) {
        if (e.key === 'Tab') {
          if (e.shiftKey) {
            if (document.activeElement === firstFocusable) {
              e.preventDefault();
              lastFocusable.focus();
            }
          } else {
            if (document.activeElement === lastFocusable) {
              e.preventDefault();
              firstFocusable.focus();
            }
          }
        }
      }

      function dismiss(confirmed) {
        overlay.removeEventListener('keydown', onKeydown);
        document.body.removeChild(overlay);
        if (confirmed && typeof opts.onConfirm === 'function') {
          opts.onConfirm();
        } else if (!confirmed && typeof opts.onCancel === 'function') {
          opts.onCancel();
        }
      }

      function onKeydown(e) {
        if (e.key === 'Escape') {
          dismiss(false);
          return;
        }
        trapFocus(e);
      }

      overlay.addEventListener('keydown', onKeydown);
      cancelBtn.addEventListener('click', function () { dismiss(false); });
      confirmBtn.addEventListener('click', function () { dismiss(true); });

      // Click on backdrop to dismiss
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) dismiss(false);
      });

      return overlay;
    }
  };

  window.ConfirmDialog = ConfirmDialog;

  // -------------------------------------------------------------------------
  // Debounce Helper
  // -------------------------------------------------------------------------

  /**
   * Returns a debounced version of the given function.
   * @param {function} fn - Function to debounce
   * @param {number} delay - Delay in ms (default 300)
   * @returns {function}
   */
  function debounce(fn, delay) {
    var timer = null;
    delay = delay || 300;
    return function () {
      var context = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(context, args);
      }, delay);
    };
  }

  window.debounce = debounce;

  // -------------------------------------------------------------------------
  // Clipboard API with execCommand Fallback
  // -------------------------------------------------------------------------

  /**
   * Copy text to clipboard.
   * Uses Clipboard API with fallback to execCommand('copy').
   * @param {string} text - Text to copy
   * @returns {Promise<boolean>} True if copied successfully
   */
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    var success = false;
    try {
      success = document.execCommand('copy');
    } catch (e) {
      success = false;
    }
    document.body.removeChild(textarea);
    return success;
  }

  window.copyToClipboard = copyToClipboard;

  // -------------------------------------------------------------------------
  // Debounced Filter Input
  // -------------------------------------------------------------------------

  function initDebouncedFilterInputs() {
    var keywordInput = document.getElementById('filter-keyword');
    var filterForm = document.getElementById('filter-bar-form');
    if (!keywordInput || !filterForm) return;

    keywordInput.addEventListener('input', debounce(function () {
      // Auto-submit filter form on debounced keyword input
      var event = new Event('submit', { cancelable: true, bubbles: true });
      filterForm.dispatchEvent(event);
    }, 300));
  }

  // -------------------------------------------------------------------------
  // Initialize
  // -------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    initFilterBar();
    initStatusBadges();
    initResumeUploader();
    initDebouncedFilterInputs();
  });
})();
