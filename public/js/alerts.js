/**
 * Alert History Page interactivity
 * Fetches GET /api/notifications with pagination and is_read filter,
 * mark-as-read on click, mark all read, badge refresh, URL pushState.
 */
(function () {
  'use strict';

  var listEl = document.getElementById('alert-list');
  var skeleton = document.getElementById('alerts-skeleton');
  var emptyEl = document.getElementById('alert-empty');
  var paginationEl = document.getElementById('alert-pagination');
  var statsText = document.getElementById('alert-stats-text');
  var markAllBtn = document.getElementById('mark-all-read');
  var emptyHeading = document.getElementById('empty-heading');
  var emptyDesc = document.getElementById('empty-description');
  var emptyCta = document.getElementById('empty-cta');

  if (!listEl) return; // guard: not on alerts page

  var currentFilter = 'all';
  var currentPage = 1;

  // --- Helpers ---

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function formatTime(dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    var now = new Date();
    var diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function scoreClass(score) {
    if (score >= 75) return 'notification-card__score--high';
    if (score >= 60) return 'notification-card__score--medium';
    return 'notification-card__score--low';
  }

  function showToast(msg, type) {
    if (typeof window.Toast !== 'undefined' && window.Toast.show) {
      window.Toast.show(msg, type || 'error');
    } else if (typeof window.showToast === 'function') {
      window.showToast(msg, type || 'error');
    }
  }

  // --- Card rendering ---

  function renderCard(n) {
    var readClass = n.is_read ? 'notification-card--read' : 'notification-card--unread';
    var skills = (n.top_matched_skills || []).slice(0, 3).map(function (s) {
      return '<span class="notification-card__skill-pill">' + escapeHtml(s) + '</span>';
    }).join('');

    var visaHtml = '';
    if (n.visa_match !== null && typeof n.visa_match !== 'undefined') {
      var visaClass = n.visa_match === 1
        ? 'notification-card__visa--eligible'
        : 'notification-card__visa--required';
      var visaLabel = n.visa_match === 1 ? 'Visa eligible' : 'Visa required';
      visaHtml = '<span class="notification-card__visa ' + visaClass + '">' + escapeHtml(visaLabel) + '</span>';
    }

    return '<div class="notification-card ' + readClass + '" role="listitem" data-id="' + n.id + '" data-job-id="' + n.job_id + '" style="animation-delay: ' + (n._index || 0) * 50 + 'ms">' +
      '<div class="notification-card__unread-dot"></div>' +
      '<div class="notification-card__content">' +
        '<div class="notification-card__header">' +
          '<span class="notification-card__job-title"><a href="/jobs/' + n.job_id + '">' + escapeHtml(n.job_title || 'Untitled') + '</a></span>' +
          '<span class="notification-card__time" title="' + escapeHtml(n.created_at || '') + '">' + formatTime(n.created_at) + '</span>' +
        '</div>' +
        '<div class="notification-card__meta">' +
          '<span>' + escapeHtml(n.company_name || '') + '</span>' +
          (n.location ? '<span class="notification-card__meta-dot"></span><span>' + escapeHtml(n.location) + '</span>' : '') +
          (n.source ? '<span class="notification-card__meta-dot"></span><span class="tag-' + escapeHtml(n.source) + '">' + escapeHtml(n.source) + '</span>' : '') +
        '</div>' +
        (skills ? '<div class="notification-card__skills">' + skills + '</div>' : '') +
        visaHtml +
      '</div>' +
      '<div class="notification-card__score ' + scoreClass(n.score) + '">' + n.score + '</div>' +
    '</div>';
  }

  // --- URL state management ---

  function pushState() {
    var params = new URLSearchParams();
    if (currentPage > 1) params.set('page', currentPage);
    if (currentFilter !== 'all') params.set('filter', currentFilter);
    var qs = params.toString();
    var url = '/alerts' + (qs ? '?' + qs : '');
    history.pushState({ page: currentPage, filter: currentFilter }, '', url);
  }

  function readUrlState() {
    var params = new URLSearchParams(window.location.search);
    currentPage = parseInt(params.get('page'), 10) || 1;
    currentFilter = params.get('filter') || 'all';
  }

  // --- Badge refresh ---

  function refreshBadge() {
    fetch('/api/notifications/unread-count')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var badge = document.getElementById('nav-alert-badge');
        var count = data.unread_count || 0;
        if (count > 0) {
          var label = count > 99 ? '99+' : String(count);
          if (badge) {
            badge.textContent = label;
            badge.classList.add('nav-alert-badge--bounce');
            setTimeout(function () { badge.classList.remove('nav-alert-badge--bounce'); }, 300);
          } else {
            // Create badge if it doesn't exist
            var alertLink = document.querySelector('a[href="/alerts"]');
            if (alertLink) {
              var span = document.createElement('span');
              span.className = 'nav-alert-badge';
              span.id = 'nav-alert-badge';
              span.textContent = label;
              alertLink.appendChild(span);
            }
          }
        } else if (badge) {
          badge.remove();
        }
      })
      .catch(function () { /* silent */ });
  }

  // --- Pagination rendering ---

  function renderPagination(p) {
    var html = '';
    html += '<button class="alert-pagination__btn" ' + (p.page <= 1 ? 'disabled' : '') + ' data-page="' + (p.page - 1) + '">&laquo; Prev</button>';
    for (var i = 1; i <= p.total_pages; i++) {
      if (i === p.page) {
        html += '<button class="alert-pagination__btn alert-pagination__btn--active alert-pagination__btn--page-number" data-page="' + i + '">' + i + '</button>';
      } else if (Math.abs(i - p.page) <= 2 || i === 1 || i === p.total_pages) {
        html += '<button class="alert-pagination__btn alert-pagination__btn--page-number" data-page="' + i + '">' + i + '</button>';
      } else if (Math.abs(i - p.page) === 3) {
        html += '<span class="alert-pagination__ellipsis">&hellip;</span>';
      }
    }
    html += '<button class="alert-pagination__btn" ' + (p.page >= p.total_pages ? 'disabled' : '') + ' data-page="' + (p.page + 1) + '">Next &raquo;</button>';
    paginationEl.innerHTML = html;
  }

  // --- Main data loader ---

  function loadNotifications(page, filter) {
    var url = '/api/notifications?page=' + page + '&per_page=20';
    if (filter === 'unread') url += '&is_read=0';
    else if (filter === 'read') url += '&is_read=1';

    listEl.classList.add('alert-list--loading');

    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        skeleton.style.display = 'none';
        var notifications = data.notifications || [];
        var pagination = data.pagination || {};
        var unreadCount = data.unread_count || 0;
        var total = pagination.total || 0;

        // Update stats bar
        if (unreadCount > 0) {
          statsText.textContent = unreadCount + ' unread of ' + total + ' total';
          markAllBtn.disabled = false;
        } else {
          statsText.textContent = total > 0 ? 'All caught up!' : '';
          markAllBtn.disabled = true;
        }

        // Update tab counts
        var countAll = document.getElementById('count-all');
        var countUnread = document.getElementById('count-unread');
        var countRead = document.getElementById('count-read');
        if (countAll) countAll.textContent = total > 0 ? '(' + total + ')' : '';
        if (countUnread) countUnread.textContent = unreadCount > 0 ? '(' + unreadCount + ')' : '';
        if (countRead && total > 0) {
          var readCount = total - unreadCount;
          countRead.textContent = readCount > 0 ? '(' + readCount + ')' : '';
        }

        if (notifications.length === 0) {
          listEl.style.display = 'none';
          paginationEl.style.display = 'none';
          emptyEl.style.display = '';
          if (filter !== 'all') {
            emptyHeading.textContent = '';
            emptyDesc.textContent = 'No alerts match this filter.';
            emptyCta.style.display = 'none';
          } else {
            emptyHeading.textContent = 'No alerts yet';
            emptyDesc.textContent = "When new jobs match your resume above your threshold, they'll appear here.";
            emptyCta.style.display = '';
          }
        } else {
          emptyEl.style.display = 'none';
          listEl.style.display = '';
          // Add animation index for stagger
          notifications.forEach(function (n, idx) { n._index = idx; });
          listEl.innerHTML = notifications.map(renderCard).join('');
          listEl.classList.remove('alert-list--loading');

          // Pagination
          if (pagination.total_pages > 1) {
            paginationEl.style.display = '';
            renderPagination(pagination);
          } else {
            paginationEl.style.display = 'none';
          }
        }
      })
      .catch(function () {
        skeleton.style.display = 'none';
        listEl.style.display = 'none';
        paginationEl.style.display = 'none';
        emptyEl.style.display = '';
        emptyHeading.textContent = 'Error';
        emptyDesc.textContent = 'Failed to load alerts. Please try again.';
        emptyCta.style.display = 'none';

        // Add retry button
        var retryBtn = document.createElement('button');
        retryBtn.className = 'alert-empty-state__cta';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', function () {
          retryBtn.remove();
          skeleton.style.display = '';
          emptyEl.style.display = 'none';
          loadNotifications(currentPage, currentFilter);
        });
        emptyEl.appendChild(retryBtn);
      });
  }

  // --- Mark single notification as read on card click ---

  listEl.addEventListener('click', function (e) {
    var card = e.target.closest('.notification-card');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var jobId = card.getAttribute('data-job-id');

    // Fire-and-forget mark as read
    if (card.classList.contains('notification-card--unread')) {
      card.classList.remove('notification-card--unread');
      card.classList.add('notification-card--read');
      fetch('/api/notifications/' + id + '/read', { method: 'PUT' })
        .then(function () { refreshBadge(); })
        .catch(function () { /* silent */ });
    }

    // Navigate to job detail if clicking on non-link area
    if (!e.target.closest('a')) {
      window.location.href = '/jobs/' + jobId;
    }
  });

  // --- Mark All Read with loading state ---

  markAllBtn.addEventListener('click', function () {
    markAllBtn.disabled = true;
    markAllBtn.textContent = 'Marking...';

    fetch('/api/notifications/read-all', { method: 'PUT' })
      .then(function (res) {
        markAllBtn.textContent = 'Mark all as read';
        if (res.ok) {
          loadNotifications(currentPage, currentFilter);
          refreshBadge();
        } else {
          markAllBtn.disabled = false;
          showToast('Failed to mark all as read.', 'error');
        }
      })
      .catch(function () {
        markAllBtn.textContent = 'Mark all as read';
        markAllBtn.disabled = false;
        showToast('Failed to mark all as read.', 'error');
      });
  });

  // --- Filter tabs ---

  document.querySelectorAll('.filter-tabs__tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.filter-tabs__tab').forEach(function (t) {
        t.classList.remove('filter-tabs__tab--active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('filter-tabs__tab--active');
      tab.setAttribute('aria-selected', 'true');
      currentFilter = tab.getAttribute('data-filter');
      currentPage = 1;
      pushState();
      loadNotifications(currentPage, currentFilter);
    });
  });

  // --- Pagination clicks ---

  paginationEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.alert-pagination__btn');
    if (!btn || btn.disabled) return;
    currentPage = parseInt(btn.getAttribute('data-page'), 10);
    pushState();
    loadNotifications(currentPage, currentFilter);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // --- Back/forward navigation ---

  window.addEventListener('popstate', function (e) {
    if (e.state && typeof e.state.page !== 'undefined') {
      currentPage = e.state.page;
      currentFilter = e.state.filter || 'all';
    } else {
      readUrlState();
    }

    // Sync filter tab UI
    document.querySelectorAll('.filter-tabs__tab').forEach(function (tab) {
      var isActive = tab.getAttribute('data-filter') === currentFilter;
      tab.classList.toggle('filter-tabs__tab--active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    loadNotifications(currentPage, currentFilter);
  });

  // --- Initial load ---

  readUrlState();

  // Sync filter tab UI from URL
  document.querySelectorAll('.filter-tabs__tab').forEach(function (tab) {
    var isActive = tab.getAttribute('data-filter') === currentFilter;
    tab.classList.toggle('filter-tabs__tab--active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  loadNotifications(currentPage, currentFilter);
})();
