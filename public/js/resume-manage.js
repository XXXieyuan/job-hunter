(function() {
  'use strict';

  // ── Upload Zone: File selection ──
  var dropzone = document.getElementById('upload-dropzone');
  var fileInput = document.getElementById('resume-file-input');
  var defaultState = document.getElementById('upload-default-state');
  var selectedState = document.getElementById('upload-selected-state');
  var fileNameEl = document.getElementById('upload-file-name');
  var fileSizeEl = document.getElementById('upload-file-size');
  var removeBtn = document.getElementById('upload-file-remove');

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function showFile(file) {
    if (!file) return;
    var ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'docx') {
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      return;
    }
    if (fileNameEl) fileNameEl.textContent = file.name;
    if (fileSizeEl) fileSizeEl.textContent = formatSize(file.size);
    if (defaultState) defaultState.hidden = true;
    if (selectedState) selectedState.hidden = false;
  }

  function resetUpload() {
    if (fileInput) fileInput.value = '';
    if (defaultState) defaultState.hidden = false;
    if (selectedState) selectedState.hidden = true;
  }

  if (dropzone && fileInput) {
    dropzone.addEventListener('dragover', function(e) {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--color-primary, #3b82f6)';
      dropzone.style.background = 'var(--color-primary-light, #dbeafe)';
    });
    dropzone.addEventListener('dragleave', function(e) {
      e.preventDefault();
      dropzone.style.borderColor = '';
      dropzone.style.background = '';
    });
    dropzone.addEventListener('drop', function(e) {
      e.preventDefault();
      dropzone.style.borderColor = '';
      dropzone.style.background = '';
      var files = e.dataTransfer.files;
      if (files.length > 0) {
        fileInput.files = e.dataTransfer.files;
        showFile(files[0]);
      }
    });

    fileInput.addEventListener('change', function() {
      if (fileInput.files.length > 0) {
        showFile(fileInput.files[0]);
      }
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener('click', function() {
      resetUpload();
    });
  }

  // ── Label Chip Selection ──
  var chips = document.querySelectorAll('.label-chip');
  var labelInput = document.getElementById('resume-label-input');
  var liveRegion = document.getElementById('label-chip-live');

  chips.forEach(function(chip) {
    chip.addEventListener('click', function() {
      if (labelInput) {
        labelInput.value = chip.textContent.trim();
        labelInput.focus();
      }
    });
  });

  // Arrow key navigation for chips
  var chipRow = document.querySelector('.label-chip-row');
  if (chipRow) {
    chipRow.addEventListener('keydown', function(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var chipButtons = Array.from(chipRow.querySelectorAll('.label-chip'));
      var currentIndex = chipButtons.indexOf(document.activeElement);
      if (currentIndex === -1) return;

      e.preventDefault();
      var nextIndex;
      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % chipButtons.length;
      } else {
        nextIndex = (currentIndex - 1 + chipButtons.length) % chipButtons.length;
      }
      chipButtons[nextIndex].focus();
    });
  }

  // ── Edit Label Modal ──
  var editModal = document.getElementById('edit-label-modal');
  var editForm = document.getElementById('edit-label-form');
  var editInput = document.getElementById('edit-label-input');
  var editCancel = document.getElementById('edit-label-cancel');
  var editTriggerBtn = null;

  function openEditModal(resumeId, currentLabel) {
    if (!editModal || !editForm || !editInput) return;
    editForm.action = '/resumes/' + resumeId + '/label';
    editInput.value = currentLabel || '';
    editModal.style.display = 'block';
    editInput.focus();
    trapFocus(editModal);
  }

  function closeEditModal() {
    if (editModal) editModal.style.display = 'none';
    if (editTriggerBtn) editTriggerBtn.focus();
    editTriggerBtn = null;
  }

  document.querySelectorAll('.edit-label-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      editTriggerBtn = btn;
      openEditModal(btn.getAttribute('data-resume-id'), btn.getAttribute('data-current-label'));
    });
  });

  if (editCancel) {
    editCancel.addEventListener('click', closeEditModal);
  }

  if (editModal) {
    editModal.querySelector('.modal-overlay').addEventListener('click', closeEditModal);
    editModal.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeEditModal();
    });
  }

  // ── Delete Confirmation Dialog ──
  var deleteDialog = document.getElementById('delete-confirm-dialog');
  var deleteForm = document.getElementById('delete-confirm-form');
  var deleteBody = document.getElementById('delete-confirm-body');
  var deleteCancel = document.getElementById('delete-confirm-cancel');
  var deleteTriggerBtn = null;

  function openDeleteDialog(resumeId, resumeLabel, scoreCount, coverLetterCount) {
    if (!deleteDialog || !deleteForm || !deleteBody) return;
    deleteForm.action = '/resumes/' + resumeId + '/delete';
    deleteBody.textContent = 'Delete "' + resumeLabel + '"? This will permanently remove ' +
      scoreCount + ' scores and ' + coverLetterCount + ' cover letters associated with this resume.';
    deleteDialog.style.display = 'block';
    var confirmBtn = deleteForm.querySelector('button[type="submit"]');
    if (confirmBtn) confirmBtn.focus();
    trapFocus(deleteDialog);
  }

  function closeDeleteDialog() {
    if (deleteDialog) deleteDialog.style.display = 'none';
    if (deleteTriggerBtn) deleteTriggerBtn.focus();
    deleteTriggerBtn = null;
  }

  document.querySelectorAll('.delete-resume-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      deleteTriggerBtn = btn;
      openDeleteDialog(
        btn.getAttribute('data-resume-id'),
        btn.getAttribute('data-resume-label'),
        btn.getAttribute('data-score-count'),
        btn.getAttribute('data-cover-letter-count')
      );
    });
  });

  if (deleteCancel) {
    deleteCancel.addEventListener('click', closeDeleteDialog);
  }

  if (deleteDialog) {
    deleteDialog.querySelector('.modal-overlay').addEventListener('click', closeDeleteDialog);
    deleteDialog.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeDeleteDialog();
    });
  }

  // ── Focus Trap Utility ──
  function trapFocus(container) {
    var focusableSelectors = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]';
    var focusableElements = container.querySelectorAll(focusableSelectors);
    if (focusableElements.length === 0) return;

    var firstFocusable = focusableElements[0];
    var lastFocusable = focusableElements[focusableElements.length - 1];

    function handleTab(e) {
      if (e.key !== 'Tab') return;
      if (container.style.display === 'none') {
        container.removeEventListener('keydown', handleTab);
        return;
      }
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

    container.addEventListener('keydown', handleTab);
  }
})();
