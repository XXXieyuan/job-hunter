/**
 * Job Hunter – Main Client-Side JavaScript
 * Toast system, mobile nav toggle, score animation, card stagger, tab switching,
 * score breakdown bars, APS tooltips, filter toggle, status badge transitions
 */

(function () {
  'use strict';

  var prefersReducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  // -------------------------------------------------------------------------
  // Toast System
  // -------------------------------------------------------------------------

  var Toast = {
    container: null,

    init: function () {
      this.container = document.getElementById('toast-container');
      if (!this.container) return;

      // Auto-dismiss existing toasts (error toasts are persistent)
      var existing = this.container.querySelectorAll('.toast');
      for (var i = 0; i < existing.length; i++) {
        this._bindClose(existing[i]);
        if (!existing[i].classList.contains('toast-error')) {
          this._autoDismiss(existing[i], 5000);
        }
      }
    },

    show: function (message, type, duration) {
      if (!this.container) return;
      type = type || 'info';
      // Error toasts are persistent by default
      duration = type === 'error' ? 0 : (duration || 5000);

      var toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.setAttribute('role', 'alert');
      toast.innerHTML =
        '<span class="toast-message">' + this._escapeHtml(message) + '</span>' +
        '<button class="toast-close" type="button" aria-label="Dismiss">&times;</button>';

      this.container.appendChild(toast);
      this._bindClose(toast);
      if (duration > 0) {
        this._autoDismiss(toast, duration);
      }
    },

    _bindClose: function (toast) {
      var closeBtn = toast.querySelector('.toast-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', function () {
          Toast._remove(toast);
        });
      }
    },

    _autoDismiss: function (toast, duration) {
      setTimeout(function () {
        Toast._remove(toast);
      }, duration);
    },

    _remove: function (toast) {
      if (!toast || !toast.parentNode) return;
      if (prefersReducedMotion) {
        toast.parentNode.removeChild(toast);
        return;
      }
      toast.style.animation = 'toast-exit 300ms ease-out forwards';
      toast.addEventListener('animationend', function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      });
    },

    _escapeHtml: function (str) {
      var div = document.createElement('div');
      div.appendChild(document.createTextNode(str));
      return div.innerHTML;
    }
  };

  // Expose globally for other scripts
  window.Toast = Toast;

  // -------------------------------------------------------------------------
  // Mobile Nav Toggle
  // -------------------------------------------------------------------------

  function initNavToggle() {
    var navShell = document.querySelector('.nav-shell');
    var toggle = document.querySelector('.nav-toggle');
    if (!navShell || !toggle) return;

    toggle.addEventListener('click', function () {
      var isOpen = navShell.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    // Close nav when clicking outside on mobile
    document.addEventListener('click', function (e) {
      if (navShell.classList.contains('nav-open') &&
          !navShell.contains(e.target)) {
        navShell.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // -------------------------------------------------------------------------
  // Nav Scroll Shadow
  // -------------------------------------------------------------------------

  function initScrollShadow() {
    var navShell = document.querySelector('.nav-shell');
    if (!navShell) return;

    var ticking = false;
    window.addEventListener('scroll', function () {
      if (!ticking) {
        window.requestAnimationFrame(function () {
          if (window.scrollY > 0) {
            navShell.classList.add('scrolled');
          } else {
            navShell.classList.remove('scrolled');
          }
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }

  // -------------------------------------------------------------------------
  // Score Number Count-Up
  // -------------------------------------------------------------------------

  function animateCountUp(el, target, durationMs) {
    if (prefersReducedMotion) {
      el.textContent = target + '%';
      return;
    }
    var start = 0;
    var startTime = null;

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / durationMs, 1);
      // ease-out: 1 - (1-t)^2
      var eased = 1 - Math.pow(1 - progress, 2);
      var current = Math.round(start + (target - start) * eased);
      el.textContent = current + '%';
      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
  }

  // -------------------------------------------------------------------------
  // Score Animation (IntersectionObserver) with count-up
  // -------------------------------------------------------------------------

  function initScoreAnimation() {
    // Selector for both legacy (.score-ring-value) and BEM (.score-ring__circle) naming
    var ringSelector = '[data-target-offset]';

    if (prefersReducedMotion) {
      var rings = document.querySelectorAll(ringSelector);
      for (var i = 0; i < rings.length; i++) {
        rings[i].style.strokeDashoffset = rings[i].getAttribute('data-target-offset');
      }
      return;
    }

    if (!('IntersectionObserver' in window)) {
      var allRings = document.querySelectorAll(ringSelector);
      for (var j = 0; j < allRings.length; j++) {
        allRings[j].style.strokeDashoffset = allRings[j].getAttribute('data-target-offset');
      }
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var el = entry.target;
          var ring = el.querySelector(ringSelector);
          // Support both BEM (.score-ring__label) and legacy (.score-ring-text) naming
          var textEl = el.querySelector('.score-ring__label') || el.querySelector('.score-ring-text');
          var scoreVal = parseInt(el.getAttribute('data-score'), 10);

          if (ring && !ring.classList.contains('animated')) {
            ring.classList.add('animated');
            requestAnimationFrame(function () {
              ring.style.strokeDashoffset = ring.getAttribute('data-target-offset');
            });
            if (textEl && !isNaN(scoreVal)) {
              animateCountUp(textEl, scoreVal, 400);
            }
          }
          observer.unobserve(el);
        }
      });
    }, { threshold: 0.3 });

    var indicators = document.querySelectorAll('.score-indicator[data-score]');
    for (var k = 0; k < indicators.length; k++) {
      observer.observe(indicators[k]);
    }
  }

  // -------------------------------------------------------------------------
  // Card Stagger Animation
  // -------------------------------------------------------------------------

  function initCardStagger() {
    if (prefersReducedMotion) return;

    if (!('IntersectionObserver' in window)) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.style.animationPlayState = 'running';
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    var cards = document.querySelectorAll('.job-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.animationPlayState = 'paused';
      observer.observe(cards[i]);
    }
  }

  // -------------------------------------------------------------------------
  // Score Breakdown Bar Animation (detail page)
  // -------------------------------------------------------------------------

  function initBreakdownBars() {
    var bars = document.querySelectorAll('.score-breakdown-bar[data-target-width]');
    if (bars.length === 0) return;

    if (prefersReducedMotion) {
      bars.forEach(function (bar) {
        bar.style.width = bar.getAttribute('data-target-width') + '%';
      });
      return;
    }

    if (!('IntersectionObserver' in window)) {
      bars.forEach(function (bar) {
        bar.style.width = bar.getAttribute('data-target-width') + '%';
      });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var bar = entry.target;
          requestAnimationFrame(function () {
            bar.style.width = bar.getAttribute('data-target-width') + '%';
            bar.classList.add('filled');
          });
          observer.unobserve(bar);
        }
      });
    }, { threshold: 0.2 });

    bars.forEach(function (bar) {
      bar.style.width = '0%';
      observer.observe(bar);
    });
  }

  // -------------------------------------------------------------------------
  // Tab Switching with Cross-Fade
  // -------------------------------------------------------------------------

  function initTabs() {
    var tabContainers = document.querySelectorAll('.tabs[data-tabs-root]');
    tabContainers.forEach(function (tabsEl) {
      var rootId = tabsEl.dataset.tabsRoot;
      var root = rootId ? document.getElementById(rootId) : tabsEl.closest('.tab-content-root');
      if (!root) return;

      var buttons = tabsEl.querySelectorAll('.tab-btn[data-tab-target]');
      var panes = root.querySelectorAll('.tab-pane[data-tab-id]');

      var activate = function (id) {
        buttons.forEach(function (btn) {
          btn.classList.toggle('active', btn.getAttribute('data-tab-target') === id);
        });

        if (prefersReducedMotion) {
          // No animation
          panes.forEach(function (pane) {
            pane.classList.toggle('active', pane.getAttribute('data-tab-id') === id);
          });
          return;
        }

        // Cross-fade: hide current, show new
        var currentActive = null;
        var targetPane = null;
        panes.forEach(function (pane) {
          if (pane.classList.contains('active') && pane.getAttribute('data-tab-id') !== id) {
            currentActive = pane;
          }
          if (pane.getAttribute('data-tab-id') === id) {
            targetPane = pane;
          }
        });

        if (currentActive && targetPane && currentActive !== targetPane) {
          // Fade out current
          currentActive.classList.remove('active');
          // Immediately show target with fade-in
          targetPane.classList.add('active');
        } else if (targetPane) {
          panes.forEach(function (pane) {
            pane.classList.toggle('active', pane.getAttribute('data-tab-id') === id);
          });
        }
      };

      buttons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-tab-target');
          if (id) activate(id);
        });
      });

      var initial = Array.from(buttons).find(function (b) {
        return b.classList.contains('active');
      }) || (buttons.length ? buttons[0] : null);

      if (initial) {
        var id = initial.getAttribute('data-tab-target');
        if (id) activate(id);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Filter Bar Toggle (mobile)
  // -------------------------------------------------------------------------

  function initFilterToggle() {
    var toggleBtn = document.querySelector('.filter-bar-toggle');
    var filterBar = document.querySelector('.filter-bar');
    if (!toggleBtn || !filterBar) return;

    toggleBtn.addEventListener('click', function () {
      var isOpen = filterBar.classList.toggle('filter-open');
      toggleBtn.classList.toggle('open', isOpen);
      toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    // On desktop, ensure filter bar is always visible
    var mql = window.matchMedia('(min-width: 769px)');
    function handleResize(e) {
      if (e.matches) {
        filterBar.classList.remove('filter-open');
        // Undo mobile hidden styles when on desktop
        filterBar.style.maxHeight = '';
        filterBar.style.opacity = '';
        filterBar.style.padding = '';
      }
    }
    if (mql.addEventListener) {
      mql.addEventListener('change', handleResize);
    } else if (mql.addListener) {
      mql.addListener(handleResize);
    }
  }

  // -------------------------------------------------------------------------
  // Status Badge Cross-Fade on Change
  // -------------------------------------------------------------------------

  function initStatusBadgeTransitions() {
    // Listen for clicks on status dropdown items and animate the change
    document.addEventListener('click', function (e) {
      var item = e.target.closest('.status-dropdown-item');
      if (!item) return;

      var wrapper = item.closest('.status-badge-wrapper');
      if (!wrapper) return;

      var trigger = wrapper.querySelector('.status-badge-trigger');
      if (!trigger) return;

      // Add transition attribute for 200ms cross-fade
      trigger.setAttribute('data-transitioning', '');
      setTimeout(function () {
        trigger.removeAttribute('data-transitioning');
      }, 200);
    });
  }

  // -------------------------------------------------------------------------
  // APS Classification Tooltip (keyboard accessible)
  // -------------------------------------------------------------------------

  function initApsTooltips() {
    var badges = document.querySelectorAll('.badge-aps-classification');
    badges.forEach(function (badge) {
      badge.setAttribute('tabindex', '0');
      badge.setAttribute('role', 'button');
    });
  }

  // -------------------------------------------------------------------------
  // AJAX Job List with pushState URL Sync
  // -------------------------------------------------------------------------

  function initAjaxJobList() {
    var jobsList = document.querySelector('.jobs-list');
    var filterForm = document.getElementById('filter-bar-form');
    if (!jobsList || !filterForm) return;

    var skeletonContainer = document.querySelector('.skeleton-container');
    var paginationContainer = document.querySelector('.pagination');

    function showSkeletons() {
      if (skeletonContainer) {
        skeletonContainer.hidden = false;
      }
      jobsList.style.opacity = '0.4';
      jobsList.style.pointerEvents = 'none';
    }

    function hideSkeletons() {
      if (skeletonContainer) {
        skeletonContainer.hidden = true;
      }
      jobsList.style.opacity = '';
      jobsList.style.pointerEvents = '';
    }

    function fetchJobs(params, pushHistory) {
      var url = '/jobs?' + params.toString();
      showSkeletons();

      fetch(url, {
        headers: { 'Accept': 'text/html', 'X-Requested-With': 'XMLHttpRequest' }
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Failed to load jobs');
          return res.text();
        })
        .then(function (html) {
          // Parse the returned HTML fragment
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');
          var newList = doc.querySelector('.jobs-list');
          var newPagination = doc.querySelector('.pagination');

          if (newList) {
            jobsList.innerHTML = newList.innerHTML;
          }
          if (paginationContainer && newPagination) {
            paginationContainer.innerHTML = newPagination.innerHTML;
            bindPaginationLinks();
          }

          if (pushHistory) {
            history.pushState({ jobsParams: params.toString() }, '', url);
          }

          hideSkeletons();
          initScoreAnimation();
          initCardStagger();
        })
        .catch(function (err) {
          hideSkeletons();
          if (window.Toast) window.Toast.show(err.message || 'Failed to load jobs', 'error');
        });
    }

    function getFormParams() {
      return new URLSearchParams(new FormData(filterForm));
    }

    // Handle filter form submission via AJAX
    filterForm.addEventListener('submit', function (e) {
      e.preventDefault();
      fetchJobs(getFormParams(), true);
    });

    // Handle pagination link clicks
    function bindPaginationLinks() {
      if (!paginationContainer) return;
      var links = paginationContainer.querySelectorAll('a[href]');
      links.forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          var href = link.getAttribute('href');
          var params = new URLSearchParams(href.split('?')[1] || '');
          fetchJobs(params, true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      });
    }

    bindPaginationLinks();

    // Handle browser back/forward
    window.addEventListener('popstate', function (e) {
      if (e.state && e.state.jobsParams) {
        fetchJobs(new URLSearchParams(e.state.jobsParams), false);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Initialize All
  // -------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    Toast.init();
    initNavToggle();
    initScrollShadow();
    initScoreAnimation();
    initCardStagger();
    initBreakdownBars();
    initTabs();
    initFilterToggle();
    initStatusBadgeTransitions();
    initApsTooltips();
    initAjaxJobList();
  });
})();
