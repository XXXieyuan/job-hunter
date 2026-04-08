/**
 * Onboarding overlay – step navigation, localStorage persistence, fade animation
 * Per DESIGN.md OnboardingOverlay spec
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'jh-onboarding-completed';
  var TOTAL_STEPS = 3;
  var currentStep = 0;

  var overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;

  // Check localStorage – if already completed, do not show
  try {
    if (localStorage.getItem(STORAGE_KEY) === 'true') return;
  } catch (e) {
    // localStorage unavailable; proceed to show overlay
  }

  var backdrop = document.getElementById('onboarding-backdrop');
  var nextBtn = document.getElementById('onboarding-next');
  var backBtn = document.getElementById('onboarding-back');
  var skipBtn = document.getElementById('onboarding-skip');
  var steps = overlay.querySelectorAll('.onboarding-step');
  var dots = overlay.querySelectorAll('.onboarding-dot');

  var prefersReducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  function showOverlay() {
    overlay.hidden = false;
    overlay.style.opacity = '0';
    if (!prefersReducedMotion) {
      requestAnimationFrame(function () {
        overlay.style.transition = 'opacity 250ms ease-out';
        overlay.style.opacity = '1';
      });
    } else {
      overlay.style.opacity = '1';
    }
  }

  function hideOverlay() {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch (e) {
      // Ignore storage errors
    }

    if (!prefersReducedMotion) {
      overlay.style.transition = 'opacity 250ms ease-out';
      overlay.style.opacity = '0';
      overlay.addEventListener('transitionend', function handler() {
        overlay.hidden = true;
        overlay.removeEventListener('transitionend', handler);
      });
    } else {
      overlay.hidden = true;
    }
  }

  function goToStep(index) {
    if (index < 0 || index >= TOTAL_STEPS) return;
    currentStep = index;

    // Update steps
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (i === currentStep) {
        step.classList.add('active');
        if (!prefersReducedMotion) {
          step.style.opacity = '0';
          step.style.transition = 'opacity 200ms ease-out';
          requestAnimationFrame(function () {
            step.style.opacity = '1';
          });
        }
      } else {
        step.classList.remove('active');
      }
    }

    // Update dots
    for (var j = 0; j < dots.length; j++) {
      dots[j].classList.toggle('active', j === currentStep);
    }

    // Update nav buttons
    backBtn.hidden = currentStep === 0;
    nextBtn.textContent = currentStep === TOTAL_STEPS - 1 ? 'Get Started' : 'Next';
  }

  // Event listeners
  if (nextBtn) {
    nextBtn.addEventListener('click', function () {
      if (currentStep < TOTAL_STEPS - 1) {
        goToStep(currentStep + 1);
      } else {
        hideOverlay();
      }
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', function () {
      if (currentStep > 0) {
        goToStep(currentStep - 1);
      }
    });
  }

  if (skipBtn) {
    skipBtn.addEventListener('click', function () {
      hideOverlay();
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', function () {
      hideOverlay();
    });
  }

  // Keyboard support (Escape to dismiss)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) {
      hideOverlay();
    }
  });

  // Initialize: show overlay
  goToStep(0);
  showOverlay();
})();
