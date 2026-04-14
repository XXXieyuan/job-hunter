/* global Chart */
'use strict';

(function () {
  var data = window.__salaryData;
  var locale = window.__salaryLocale || {};

  // DOM elements
  var chartCanvas = document.getElementById('salary-chart');
  var chartContainer = document.getElementById('salary-chart-container');
  var keywordInput = document.getElementById('salary-filter-keyword');
  var locationSelect = document.getElementById('salary-filter-location');
  var sourceSelect = document.getElementById('salary-filter-source');
  var apsSelect = document.getElementById('salary-filter-aps');
  var resetBtn = document.getElementById('salary-filter-reset');
  var emptyState = document.getElementById('salary-empty-state');
  var emptyMessage = document.getElementById('salary-empty-message');
  var errorState = document.getElementById('salary-error-state');
  var errorMessage = document.getElementById('salary-error-message');
  var retryBtn = document.getElementById('salary-retry-btn');
  var loadingEl = document.getElementById('salary-loading');
  var liveRegion = document.getElementById('salary-live-region');
  var activeFiltersEl = document.getElementById('salary-active-filters');
  var groupIndicatorEl = document.getElementById('salary-group-indicator');
  var truncationNotice = document.getElementById('salary-truncation-notice');
  var footnote = document.getElementById('salary-footnote');
  var srTbody = document.getElementById('salary-sr-tbody');

  // Colour-blind-safe 7-colour palette
  var PALETTE = [
    '#2563EB', '#D97706', '#059669', '#7C3AED',
    '#DC2626', '#0891B2', '#BE185D',
  ];

  var chart = null;
  var abortController = null;
  var debounceTimer = null;
  var filtersDisabled = false;
  // Stores last successful groups for chart retention on error
  var lastGroups = null;
  var lastGroupBy = 'location';

  /**
   * Translate helper with {{placeholder}} replacement.
   */
  function t(key, fallback, replacements) {
    var text = locale[key] || fallback || key;
    if (replacements) {
      for (var k in replacements) {
        if (Object.prototype.hasOwnProperty.call(replacements, k)) {
          text = text.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), replacements[k]);
        }
      }
    }
    return text;
  }

  /**
   * Format dollar value as "$XXK".
   */
  function formatDollarK(value) {
    return '$' + Math.round(value / 1000) + 'K';
  }

  /**
   * Escape HTML entities for safe insertion.
   */
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /**
   * Create a canvas pattern for colour-blind differentiation.
   * Index 0=solid, 1=diagonal 45°, 2=dots, 3=crosshatch,
   * 4=horizontal lines, 5=vertical lines, 6=checkerboard
   */
  function createPattern(ctx, colorHex, patternIndex, opacity) {
    var size = 10;
    var pCanvas = document.createElement('canvas');
    pCanvas.width = size;
    pCanvas.height = size;
    var pCtx = pCanvas.getContext('2d');

    // Parse hex to rgba
    var r = parseInt(colorHex.slice(1, 3), 16);
    var g = parseInt(colorHex.slice(3, 5), 16);
    var b = parseInt(colorHex.slice(5, 7), 16);
    var fillColor = 'rgba(' + r + ',' + g + ',' + b + ',' + opacity + ')';
    var lineColor = 'rgba(' + r + ',' + g + ',' + b + ',' + Math.min(1, opacity + 0.3) + ')';

    // Fill background with semi-transparent color
    pCtx.fillStyle = fillColor;
    pCtx.fillRect(0, 0, size, size);

    pCtx.strokeStyle = lineColor;
    pCtx.lineWidth = 1.5;

    switch (patternIndex % 7) {
      case 0: // solid — just the fill
        break;
      case 1: // diagonal 45°
        pCtx.beginPath();
        pCtx.moveTo(0, size);
        pCtx.lineTo(size, 0);
        pCtx.moveTo(-2, 2);
        pCtx.lineTo(2, -2);
        pCtx.moveTo(size - 2, size + 2);
        pCtx.lineTo(size + 2, size - 2);
        pCtx.stroke();
        break;
      case 2: // dots
        pCtx.beginPath();
        pCtx.arc(size / 2, size / 2, 2, 0, Math.PI * 2);
        pCtx.fillStyle = lineColor;
        pCtx.fill();
        break;
      case 3: // crosshatch
        pCtx.beginPath();
        pCtx.moveTo(0, size);
        pCtx.lineTo(size, 0);
        pCtx.moveTo(0, 0);
        pCtx.lineTo(size, size);
        pCtx.stroke();
        break;
      case 4: // horizontal lines
        pCtx.beginPath();
        pCtx.moveTo(0, size / 2);
        pCtx.lineTo(size, size / 2);
        pCtx.stroke();
        break;
      case 5: // vertical lines
        pCtx.beginPath();
        pCtx.moveTo(size / 2, 0);
        pCtx.lineTo(size / 2, size);
        pCtx.stroke();
        break;
      case 6: // checkerboard
        pCtx.fillStyle = lineColor;
        pCtx.fillRect(0, 0, size / 2, size / 2);
        pCtx.fillRect(size / 2, size / 2, size / 2, size / 2);
        break;
    }

    return ctx.createPattern(pCanvas, 'repeat');
  }

  /**
   * Resolve the group_by parameter based on current filter state.
   * Rules from INTERFACE_CONTRACT:
   *   No filters → location
   *   Location selected → source
   *   Source selected → location
   *   APS level selected → aps_classification
   *   Multiple filters → priority: aps_classification > source > location
   */
  function resolveGroupBy() {
    var hasAps = apsSelect.value !== '';
    var hasSource = sourceSelect.value !== '';
    var hasLocation = locationSelect.value !== '';

    if (hasAps) return 'aps_classification';
    if (hasSource && hasLocation) return 'aps_classification';
    if (hasSource) return 'location';
    if (hasLocation) return 'source';
    return 'location';
  }

  /**
   * Get the display name for a group_by dimension.
   */
  function dimensionLabel(groupBy) {
    var map = {
      location: t('salary.group.location', 'Location'),
      source: t('salary.group.source', 'Platform'),
      aps_classification: t('salary.group.aps_classification', 'APS Classification'),
    };
    return map[groupBy] || groupBy;
  }

  /**
   * Check if Chart.js CDN failed and render fallback table.
   */
  function checkCdnFallback(groups) {
    if (window.__chartjsFailed || typeof Chart === 'undefined') {
      renderFallbackTable(groups);
      return true;
    }
    return false;
  }

  /**
   * Render a simple HTML table as fallback when Chart.js is unavailable.
   */
  function renderFallbackTable(groups) {
    chartContainer.innerHTML = '';
    var table = document.createElement('table');
    table.className = 'salary-fallback-table';
    table.innerHTML =
      '<thead><tr>' +
        '<th>Label</th><th>Count</th><th>Min</th><th>Q1</th>' +
        '<th>Median</th><th>Q3</th><th>Max</th>' +
      '</tr></thead><tbody>' +
      groups.map(function (g) {
        return '<tr><td>' + escapeHtml(g.label) + '</td><td>' + g.count +
          '</td><td>' + formatDollarK(g.min) + '</td><td>' + formatDollarK(g.q1) +
          '</td><td>' + formatDollarK(g.median) + '</td><td>' + formatDollarK(g.q3) +
          '</td><td>' + formatDollarK(g.max) + '</td></tr>';
      }).join('') +
      '</tbody>';
    chartContainer.appendChild(table);
  }

  /**
   * Build background colours array — uses pattern fills for colour-blind safety.
   * Groups with count < 5 get 50% opacity.
   */
  function buildBackgrounds(groups, ctx) {
    return groups.map(function (g, i) {
      var color = PALETTE[i % PALETTE.length];
      var opacity = g.count < 5 ? 0.5 : 0.8;
      return createPattern(ctx, color, i, opacity);
    });
  }

  /**
   * Chart.js plugin: draw a median line within each bar.
   */
  var medianLinePlugin = {
    id: 'medianLine',
    afterDatasetDraw: function (chartInstance) {
      var meta = chartInstance.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      var ctx2 = chartInstance.ctx;
      var groups2 = chartInstance.__salaryGroups;
      if (!groups2) return;
      var isMobile = chartInstance.__isMobile;

      ctx2.save();
      ctx2.strokeStyle = '#111827';
      ctx2.lineWidth = 2.5;

      meta.data.forEach(function (bar, idx) {
        var g = groups2[idx];
        if (!g) return;
        var scale = isMobile ? chartInstance.scales.x : chartInstance.scales.y;
        var medianPixel = scale.getPixelForValue(g.median);

        ctx2.beginPath();
        if (isMobile) {
          // Horizontal bars: median is on x-axis, bar spans y
          ctx2.moveTo(medianPixel, bar.y - bar.height / 2);
          ctx2.lineTo(medianPixel, bar.y + bar.height / 2);
        } else {
          // Vertical bars: median is on y-axis, bar spans x
          ctx2.moveTo(bar.x - bar.width / 2, medianPixel);
          ctx2.lineTo(bar.x + bar.width / 2, medianPixel);
        }
        ctx2.stroke();
      });
      ctx2.restore();
    },
  };

  /**
   * Chart.js plugin: render sample size labels below/inside each bar.
   */
  var sampleSizePlugin = {
    id: 'sampleSize',
    afterDatasetDraw: function (chartInstance) {
      var meta = chartInstance.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      var ctx2 = chartInstance.ctx;
      var groups2 = chartInstance.__salaryGroups;
      if (!groups2) return;
      var isMobile = chartInstance.__isMobile;

      ctx2.save();
      ctx2.font = '11px Inter, system-ui, sans-serif';
      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'top';

      meta.data.forEach(function (bar, idx) {
        var g = groups2[idx];
        if (!g) return;
        var label = 'n=' + g.count;
        if (g.count < 5) label += '*';
        ctx2.fillStyle = g.count < 5 ? '#DC2626' : '#6B7280';

        if (isMobile) {
          ctx2.textAlign = 'left';
          ctx2.fillText(label, bar.x + 4, bar.y - 6);
        } else {
          ctx2.fillText(label, bar.x, bar.y + bar.height / 2 + 4);
        }
      });
      ctx2.restore();
    },
  };

  /**
   * Initialize or update the Chart.js bar chart with error-bar whiskers.
   * Bar body = Q1–Q3, whiskers = min–max, median line via plugin.
   */
  function renderChart(groups, groupBy) {
    if (checkCdnFallback(groups)) return;

    var isMobile = window.innerWidth < 768;
    var labels = groups.map(function (g) { return g.label; });
    var ctx = chartCanvas.getContext('2d');
    var bgColors = buildBackgrounds(groups, ctx);
    var borderColors = groups.map(function (_, i) { return PALETTE[i % PALETTE.length]; });

    // Use barWithErrorBars if the plugin loaded, otherwise fall back to plain bar
    var useErrorBars = typeof Chart.controllers !== 'undefined' &&
      typeof Chart.controllers.barWithErrorBars !== 'undefined';

    var chartType = useErrorBars ? 'barWithErrorBars' : 'bar';

    var datasetData;
    if (useErrorBars) {
      // Floating bar: body spans Q1–Q3, whiskers extend to min/max
      // Median line is drawn by the medianLinePlugin inside the Q1-Q3 bar
      datasetData = groups.map(function (g) {
        if (isMobile) {
          return { x: [g.q1, g.q3], xMin: g.min, xMax: g.max };
        }
        return { y: [g.q1, g.q3], yMin: g.min, yMax: g.max };
      });
    } else {
      // Fallback: floating bar spanning Q1–Q3 (Chart.js native format)
      datasetData = groups.map(function (g) { return [g.q1, g.q3]; });
    }

    var errorBarConfig = useErrorBars ? {
      errorBarLineWidth: 1.5,
      errorBarWhiskerLineWidth: 1.5,
      errorBarColor: '#374151',
      errorBarWhiskerColor: '#374151',
      errorBarWhiskerSize: 0.5,
    } : {};

    var chartConfig = {
      type: chartType,
      data: {
        labels: labels,
        datasets: [{
          label: t('salary.chart.range', 'Q1–Q3 Range'),
          data: datasetData,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1,
          errorBarLineWidth: errorBarConfig.errorBarLineWidth,
          errorBarWhiskerLineWidth: errorBarConfig.errorBarWhiskerLineWidth,
          errorBarColor: errorBarConfig.errorBarColor,
          errorBarWhiskerColor: errorBarConfig.errorBarWhiskerColor,
          errorBarWhiskerSize: errorBarConfig.errorBarWhiskerSize,
        }],
      },
      options: {
        indexAxis: isMobile ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) {
                return items[0].label;
              },
              label: function (context) {
                var idx = context.dataIndex;
                var g = groups[idx];
                var lines = [
                  t('salary.chart.tooltip.median', 'Median: ${{value}}', { value: g.median.toLocaleString() }),
                  t('salary.chart.tooltip.q1_q3', 'Q1–Q3: ${{q1}} – ${{q3}}', { q1: g.q1.toLocaleString(), q3: g.q3.toLocaleString() }),
                  t('salary.chart.tooltip.range', 'Range: ${{min}} – ${{max}}', { min: g.min.toLocaleString(), max: g.max.toLocaleString() }),
                  t('salary.chart.tooltip.count', 'Based on {{count}} listings', { count: g.count }),
                ];
                if (g.count < 5) {
                  lines.push('\u26a0 ' + t('salary.chart.low_sample', 'Based on only {{count}} listings \u2014 interpret with caution', { count: g.count }));
                }
                return lines;
              },
            },
          },
        },
        scales: {
          [isMobile ? 'x' : 'y']: {
            beginAtZero: false,
            ticks: {
              callback: function (value) {
                return formatDollarK(value);
              },
            },
          },
        },
      },
      plugins: [medianLinePlugin, sampleSizePlugin],
    };

    if (chart) {
      chart.destroy();
    }

    chart = new Chart(chartCanvas, chartConfig);
    // Attach groups for plugin access
    chart.__salaryGroups = groups;
    chart.__isMobile = isMobile;
  }

  /**
   * Update the SR-only data table with current groups.
   */
  function updateSrTable(groups) {
    srTbody.innerHTML = groups.map(function (g) {
      return '<tr><td>' + escapeHtml(g.label) + '</td><td>' + g.count +
        '</td><td>' + formatDollarK(g.min) + '</td><td>' + formatDollarK(g.q1) +
        '</td><td>' + formatDollarK(g.median) + '</td><td>' + formatDollarK(g.q3) +
        '</td><td>' + formatDollarK(g.max) + '</td></tr>';
    }).join('');
  }

  /**
   * Update all UI state from response data.
   */
  function updateUI(groups, meta, groupBy) {
    // Hide all state containers
    emptyState.style.display = 'none';
    errorState.style.display = 'none';

    if (groups.length === 0) {
      chartContainer.style.display = 'none';
      footnote.style.display = 'none';
      truncationNotice.style.display = 'none';
      emptyState.style.display = '';
      var hasFilters = keywordInput.value || locationSelect.value || sourceSelect.value || apsSelect.value;
      emptyMessage.textContent = hasFilters
        ? t('salary.empty.no_results', 'No salary data found for this combination. Try broadening your filters.')
        : t('salary.empty.no_data', 'No salary data available yet. Salary information will appear as jobs are scraped.');
      return;
    }

    chartContainer.style.display = '';
    footnote.style.display = '';

    // Truncation notice
    truncationNotice.style.display = meta && meta.truncated ? '' : 'none';

    // Group indicator
    groupIndicatorEl.textContent = t('salary.chart.grouped_by', 'Grouped by: {{dimension}}', { dimension: dimensionLabel(groupBy) });

    // Active filter summary
    var keyword = keywordInput.value.trim();
    if (keyword) {
      activeFiltersEl.textContent = t('salary.showing_results', "Showing results for: '{{keyword}}'", { keyword: keyword });
    } else {
      activeFiltersEl.textContent = '';
    }

    // Render chart
    renderChart(groups, groupBy);

    // Update SR table
    updateSrTable(groups);

    // Store last successful data for retention on error
    lastGroups = groups;
    lastGroupBy = groupBy;

    // Live region announcement
    liveRegion.textContent = t('salary.chart.updated', 'Chart updated. Showing {{count}} groups grouped by {{dimension}}.', {
      count: groups.length,
      dimension: dimensionLabel(groupBy),
    });
  }

  /**
   * Show error state inline with optional retry button.
   * Chart retains last successful data per spec.
   */
  function showError(message, showRetry) {
    emptyState.style.display = 'none';
    errorState.style.display = '';
    errorMessage.textContent = message;
    retryBtn.style.display = showRetry ? '' : 'none';
  }

  /**
   * Show a toast notification that auto-dismisses.
   */
  function showToast(message, type, duration) {
    var toast = document.createElement('div');
    toast.className = 'salary-toast salary-toast-' + (type || 'error');
    toast.textContent = message;
    toast.setAttribute('role', 'alert');
    document.body.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, duration || 5000);
  }

  /**
   * Disable all filter controls for a cooldown period (rate limit 429).
   */
  function disableFilters(seconds) {
    filtersDisabled = true;
    keywordInput.disabled = true;
    locationSelect.disabled = true;
    sourceSelect.disabled = true;
    apsSelect.disabled = true;
    resetBtn.disabled = true;

    var remaining = seconds;
    var countdownInterval = setInterval(function () {
      remaining--;
      showToast(
        t('salary.error.countdown', 'Try again in {{seconds}}s', { seconds: remaining }),
        'warning',
        1000
      );
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        filtersDisabled = false;
        keywordInput.disabled = false;
        locationSelect.disabled = false;
        sourceSelect.disabled = false;
        apsSelect.disabled = false;
        resetBtn.disabled = false;
      }
    }, 1000);
  }

  /**
   * Fetch salary data from the API with current filter state.
   * Uses AbortController to cancel in-flight requests.
   */
  function fetchData() {
    if (filtersDisabled) return;

    // Cancel any in-flight request
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    var groupBy = resolveGroupBy();
    var params = new URLSearchParams();
    params.set('group_by', groupBy);

    var keyword = keywordInput.value.trim();
    if (keyword) params.set('keyword', keyword);
    if (locationSelect.value) params.set('location', locationSelect.value);
    if (sourceSelect.value) params.set('source', sourceSelect.value);
    if (apsSelect.value) params.set('aps_level', apsSelect.value);

    // Show loading state
    chartContainer.classList.add('loading');
    chartContainer.setAttribute('aria-busy', 'true');
    loadingEl.style.display = '';

    // 12-second client timeout
    var timeoutId = setTimeout(function () {
      if (abortController) abortController.abort();
    }, 12000);

    fetch('/api/salary-insights?' + params.toString(), {
      signal: abortController.signal,
    })
      .then(function (response) {
        clearTimeout(timeoutId);
        if (response.status === 429) {
          var retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
          return response.json().then(function () {
            showToast(
              t('salary.error.rate_limit', 'Too many requests \u2014 please wait a moment and try again.'),
              'warning',
              5000
            );
            disableFilters(retryAfter > 0 ? retryAfter : 5);
            throw new Error('rate_limited');
          });
        }
        if (response.status === 400) {
          return response.json().then(function (body) {
            showToast(body.error || 'Invalid request', 'error', 5000);
            throw new Error('bad_request');
          });
        }
        if (response.status === 503) {
          showError(
            t('salary.error.timeout', 'Salary data is temporarily unavailable. Please try again later.'),
            true
          );
          throw new Error('timeout');
        }
        if (!response.ok) {
          throw new Error('server_error');
        }
        return response.json();
      })
      .then(function (result) {
        if (!result) return;
        chartContainer.classList.remove('loading');
        chartContainer.removeAttribute('aria-busy');
        loadingEl.style.display = 'none';
        updateUI(result.groups, result.meta, groupBy);
      })
      .catch(function (err) {
        chartContainer.classList.remove('loading');
        chartContainer.removeAttribute('aria-busy');
        loadingEl.style.display = 'none';
        if (err.name === 'AbortError') return;
        if (err.message === 'rate_limited' || err.message === 'bad_request' || err.message === 'timeout') return;
        showError(
          t('salary.error.load_failed', 'Could not load salary data. Please try again.'),
          true
        );
      });
  }

  /**
   * Debounced fetch for keyword input (300ms).
   */
  function debouncedFetch() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fetchData, 300);
  }

  /**
   * Initialize the page on DOMContentLoaded.
   */
  function init() {
    if (!data) return;

    // Render initial data from server-embedded JSON
    var groupBy = 'location';
    updateUI(data.groups, data.meta, groupBy);

    // Show truncation notice from initial data
    if (data.meta && data.meta.truncated) {
      truncationNotice.style.display = '';
    }

    // Wire up filter event handlers
    keywordInput.addEventListener('input', debouncedFetch);
    locationSelect.addEventListener('change', fetchData);
    sourceSelect.addEventListener('change', fetchData);
    apsSelect.addEventListener('change', fetchData);

    // Reset button: clear all filters, fetch with default grouping
    resetBtn.addEventListener('click', function () {
      keywordInput.value = '';
      locationSelect.value = '';
      sourceSelect.value = '';
      apsSelect.value = '';
      fetchData();
    });

    // Retry button on error state
    retryBtn.addEventListener('click', function () {
      errorState.style.display = 'none';
      fetchData();
    });

    // Re-render chart on resize for responsive orientation switch
    var resizeTimer;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var currentGroups = lastGroups || data.groups;
        if (chart && currentGroups && currentGroups.length > 0) {
          renderChart(currentGroups, lastGroupBy || resolveGroupBy());
        }
      }, 250);
    });
  }

  // Start on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
