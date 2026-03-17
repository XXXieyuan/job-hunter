document.addEventListener('DOMContentLoaded', () => {
  const adminRoot = document.getElementById('admin-root');
  const ADMIN_TOKEN = adminRoot && adminRoot.dataset.adminToken
    ? adminRoot.dataset.adminToken
    : '';

  const runBtn = document.getElementById('run-analysis-btn');
  const runStatus = document.getElementById('run-analysis-status');
  const uploadForm = document.getElementById('upload-form');
  const uploadTextarea = document.getElementById('upload-json');
  const uploadStatus = document.getElementById('upload-status');
  const scraperSection = document.getElementById('scraper-section');
  const analysisSection = document.getElementById('analysis-section');
  const scraperBtn = document.getElementById('trigger-scraper-btn');
  const scraperStatus = document.getElementById('scraper-status');
  const scraperRunsTable = document.getElementById('scraper-runs-table');
  const scraperSourceInput = document.getElementById('scraper-source');
  const scraperKeywordsInput = document.getElementById('scraper-keywords');
  const scraperRegionInput = document.getElementById('scraper-region');
  const scraperMaxPagesInput = document.getElementById('scraper-max-pages');
  const scraperProgress = document.getElementById('scraper-progress');
  const scraperProgressBar = document.getElementById('scraper-progress-bar');
  const scraperProgressPercent = document.getElementById('scraper-progress-percent');
  const scraperProgressState = document.getElementById('scraper-progress-state');
  const scraperProgressSteps = document.getElementById('scraper-progress-steps');
  const scraperProgressJobs = document.getElementById('scraper-progress-jobs');
  const scraperProgressMessage = document.getElementById('scraper-progress-message');

  let scraperEventSource = null;
  const scraperStreamEvents = new EventTarget();

  const analysisTexts = analysisSection
    ? {
        triggering:
          analysisSection.dataset.i18nTriggering ||
          '正在触发分析，请稍候…',
        startedWithId:
          analysisSection.dataset.i18nStartedWithId ||
          '分析已启动，运行 ID：{runId}。请稍后刷新查看结果。',
        started:
          analysisSection.dataset.i18nStarted ||
          '分析已启动，请稍后刷新查看结果。',
        triggerFailedPrefix:
          analysisSection.dataset.i18nTriggerFailedPrefix ||
          '触发分析失败：',
        networkError:
          analysisSection.dataset.i18nNetworkError ||
          '触发分析失败：网络错误或服务器不可用。',
      }
    : {
        triggering: '正在触发分析，请稍候…',
        startedWithId:
          '分析已启动，运行 ID：{runId}。请稍后刷新查看结果。',
        started: '分析已启动，请稍后刷新查看结果。',
        triggerFailedPrefix: '触发分析失败：',
        networkError: '触发分析失败：网络错误或服务器不可用。',
      };

  const scraperTexts = scraperSection
    ? {
        triggering:
          scraperSection.dataset.i18nTriggering ||
          '正在触发抓取，请稍候…',
        startedWithId:
          scraperSection.dataset.i18nStartedWithId ||
          '抓取已启动，运行 ID：{runId}。',
        started:
          scraperSection.dataset.i18nStarted ||
          '抓取已启动。',
        emptyRuns:
          scraperSection.dataset.i18nEmptyRuns ||
          '暂无抓取记录。',
        triggerFailedPrefix:
          scraperSection.dataset.i18nTriggerFailedPrefix ||
          '触发抓取失败：',
        networkError:
          scraperSection.dataset.i18nNetworkError ||
          '触发抓取失败：网络错误或服务器不可用。',
        statuses: {
          running:
            scraperSection.dataset.i18nStatusRunning ||
            '运行中',
          queued:
            scraperSection.dataset.i18nStatusQueued ||
            '排队中',
          success:
            scraperSection.dataset.i18nStatusSuccess ||
            '成功',
          failure:
            scraperSection.dataset.i18nStatusFailure ||
            '失败',
          completed:
            scraperSection.dataset.i18nStatusSuccess ||
            '成功',
          failed:
            scraperSection.dataset.i18nStatusFailure ||
            '失败',
          unknown:
            scraperSection.dataset.i18nStatusUnknown ||
            '未知',
        },
      }
    : {
        triggering: '正在触发抓取，请稍候…',
        startedWithId: '抓取已启动，运行 ID：{runId}。',
        started: '抓取已启动。',
        emptyRuns: '暂无抓取记录。',
        triggerFailedPrefix: '触发抓取失败：',
        networkError: '触发抓取失败：网络错误或服务器不可用。',
        statuses: {
          running: '运行中',
          queued: '排队中',
          success: '成功',
          failure: '失败',
          completed: '成功',
          failed: '失败',
          unknown: '未知',
        },
      };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        case '\'':
          return '&#39;';
        default:
          return char;
      }
    });
  }

  function getScraperStatusClass(status) {
    if (status === 'running' || status === 'queued') {
      return 'status-pill status-running';
    }
    if (status === 'success' || status === 'completed') {
      return 'status-pill status-success';
    }
    if (status === 'failure' || status === 'failed') {
      return 'status-pill status-failed';
    }
    return 'status-pill';
  }

  function getScraperStatusLabel(status) {
    return (
      (scraperTexts.statuses && scraperTexts.statuses[status]) ||
      status ||
      (scraperTexts.statuses && scraperTexts.statuses.unknown) ||
      ''
    );
  }

  function getScraperProgressPercent(run) {
    if (!run) {
      return 0;
    }

    if (run.progress && run.progress.total > 0) {
      return Math.max(
        0,
        Math.min(100, Math.round((run.progress.current / run.progress.total) * 100)),
      );
    }

    if (run.status === 'completed' || run.status === 'success') {
      return 100;
    }

    return 0;
  }

  function renderScraperRunRow(run) {
    const status = run.status || '';
    const jobsAdded =
      typeof run.jobs_added === 'number' ? run.jobs_added : '-';
    const errorMessage = run.error_message || '-';
    const startedAt = run.started_at || '-';
    const finishedAt = run.finished_at || '-';

    return `
      <tr data-run-id="${escapeHtml(run.id)}">
        <td>${escapeHtml(run.id)}</td>
        <td>${escapeHtml(run.scraper_name || '-')}</td>
        <td><span class="${getScraperStatusClass(status)}">${escapeHtml(getScraperStatusLabel(status))}</span></td>
        <td>${escapeHtml(startedAt)}</td>
        <td>${escapeHtml(finishedAt)}</td>
        <td>${escapeHtml(jobsAdded)}</td>
        <td class="small">${escapeHtml(errorMessage)}</td>
      </tr>
    `;
  }

  function upsertScraperRunRow(run) {
    if (!scraperRunsTable || !run) return;

    const tbody = scraperRunsTable.querySelector('tbody');
    if (!tbody) return;

    const existingRow = Array.from(
      tbody.querySelectorAll('tr[data-run-id]'),
    ).find((row) => row.dataset.runId === String(run.id));
    const rowHtml = renderScraperRunRow(run);

    if (existingRow) {
      existingRow.outerHTML = rowHtml;
      return;
    }

    const emptyRow = tbody.querySelector('td[colspan="7"]');
    if (emptyRow) {
      tbody.innerHTML = '';
    }

    tbody.insertAdjacentHTML('afterbegin', rowHtml);

    while (tbody.querySelectorAll('tr[data-run-id]').length > 20) {
      tbody.lastElementChild.remove();
    }
  }

  function renderScraperProgress(run) {
    if (
      !scraperProgress ||
      !scraperProgressBar ||
      !scraperProgressPercent ||
      !scraperProgressState ||
      !scraperProgressSteps ||
      !scraperProgressJobs ||
      !scraperProgressMessage ||
      !run
    ) {
      return;
    }

    const percent = getScraperProgressPercent(run);
    const progress = run.progress || {};
    const statusLabel = getScraperStatusLabel(run.status);

    scraperProgress.hidden = false;
    scraperProgress.classList.toggle('is-complete', run.status === 'completed');
    scraperProgress.classList.toggle('is-failed', run.status === 'failed');
    scraperProgressBar.style.width = `${percent}%`;
    scraperProgressBar.parentElement.setAttribute('aria-valuenow', String(percent));
    scraperProgressPercent.textContent = `${percent}%`;
    scraperProgressState.textContent = statusLabel;
    scraperProgressSteps.textContent =
      typeof progress.total === 'number' && progress.total > 0
        ? `${progress.current || 0}/${progress.total}`
        : '';
    scraperProgressJobs.textContent =
      typeof run.jobs_added === 'number' ? `新增职位：${run.jobs_added}` : '';
    scraperProgressMessage.textContent =
      progress.message || run.error_message || '';
  }

  function closeScraperEventSource() {
    if (scraperEventSource) {
      scraperEventSource.close();
      scraperEventSource = null;
    }
  }

  function handleScraperSnapshot(snapshot) {
    if (!snapshot || !snapshot.id) {
      return;
    }

    upsertScraperRunRow(snapshot);
    renderScraperProgress(snapshot);

    const eventName =
      snapshot.status === 'completed' || snapshot.status === 'failed'
        ? 'complete'
        : 'progress';

    scraperStreamEvents.dispatchEvent(
      new CustomEvent(eventName, {
        detail: snapshot,
      }),
    );
  }

  if (runBtn && runStatus) {
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.classList.add('loading');
      runStatus.textContent = analysisTexts.triggering;

      try {
        const res = await fetch(`/admin/run?token=${encodeURIComponent(ADMIN_TOKEN)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token: ADMIN_TOKEN }),
        });

        let json;
        try {
          json = await res.json();
        } catch (parseErr) {
          json = {};
        }

        if (res.ok) {
          runStatus.textContent =
            json && json.runId
              ? analysisTexts.startedWithId.replace('{runId}', json.runId)
              : analysisTexts.started;
        } else {
          const message = (json && json.error) || res.statusText || '未知错误';
          runStatus.textContent = `${analysisTexts.triggerFailedPrefix}${message}`;
          runStatus.classList.add('error-message');
        }
      } catch (err) {
        runStatus.textContent = analysisTexts.networkError;
        runStatus.classList.add('error-message');
      } finally {
        runBtn.disabled = false;
        runBtn.classList.remove('loading');
      }
    });
  }

  async function refreshScraperRuns() {
    if (!scraperRunsTable) return;

    try {
      const query = ADMIN_TOKEN
        ? `?token=${encodeURIComponent(ADMIN_TOKEN)}`
        : '';
      const res = await fetch(`/admin/scraper/runs${query}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        return;
      }

      const json = await res.json();
      const runs = (json && json.runs) || [];
      const tbody = scraperRunsTable.querySelector('tbody');
      if (!tbody) return;

      if (!runs.length) {
        tbody.innerHTML =
          `<tr><td colspan="7" class="muted">${scraperTexts.emptyRuns}</td></tr>`;
        return;
      }

      const rowsHtml = runs.map(renderScraperRunRow).join('');

      tbody.innerHTML = rowsHtml;
    } catch {
      // Ignore refresh errors; UI will show last known state.
    }
  }

  function connectScraperProgress(runId) {
    if (!runId || typeof EventSource === 'undefined') {
      return;
    }

    closeScraperEventSource();

    const query = ADMIN_TOKEN
      ? `?token=${encodeURIComponent(ADMIN_TOKEN)}`
      : '';
    const progressUrl = `/admin/scraper/progress/${encodeURIComponent(runId)}${query}`;
    const eventSource = new EventSource(progressUrl);
    scraperEventSource = eventSource;

    const parseSnapshot = (event) => {
      try {
        return JSON.parse(event.data);
      } catch {
        return null;
      }
    };

    const onProgress = (event) => {
      const snapshot = parseSnapshot(event);
      if (snapshot) {
        handleScraperSnapshot(snapshot);
      }
    };

    const onComplete = (event) => {
      const snapshot = parseSnapshot(event);
      if (snapshot) {
        handleScraperSnapshot(snapshot);
      }

      closeScraperEventSource();
      refreshScraperRuns();
    };

    eventSource.addEventListener('progress', onProgress);
    eventSource.addEventListener('complete', onComplete);
    eventSource.addEventListener('message', (event) => {
      const snapshot = parseSnapshot(event);
      if (!snapshot) {
        return;
      }

      if (snapshot.status === 'completed' || snapshot.status === 'failed') {
        onComplete(event);
        return;
      }

      onProgress(event);
    });
    eventSource.onerror = () => {
      if (
        eventSource.readyState === EventSource.CLOSED &&
        scraperEventSource === eventSource
      ) {
        closeScraperEventSource();
      }
    };
  }

  scraperStreamEvents.addEventListener('progress', (event) => {
    const snapshot = event.detail;
    if (!snapshot || !scraperStatus) {
      return;
    }

    if (snapshot.progress && snapshot.progress.message) {
      scraperStatus.textContent = snapshot.progress.message;
    }
  });

  scraperStreamEvents.addEventListener('complete', (event) => {
    const snapshot = event.detail;
    if (!snapshot || !scraperStatus) {
      return;
    }

    if (snapshot.status === 'failed') {
      scraperStatus.textContent = snapshot.error_message || getScraperStatusLabel(snapshot.status);
      scraperStatus.classList.add('error-message');
      return;
    }

    scraperStatus.classList.remove('error-message');
    scraperStatus.textContent =
      typeof snapshot.jobs_added === 'number'
        ? `${getScraperStatusLabel(snapshot.status)}，新增职位：${snapshot.jobs_added}`
        : getScraperStatusLabel(snapshot.status);
  });

  if (scraperBtn && scraperStatus) {
    scraperBtn.addEventListener('click', async () => {
      scraperStatus.textContent = '';
      scraperStatus.classList.remove('error-message');
      scraperBtn.disabled = true;
      scraperBtn.classList.add('loading');
      scraperStatus.textContent = scraperTexts.triggering;

      const options = {};
      const keywordsValue =
        scraperKeywordsInput && scraperKeywordsInput.value
          ? scraperKeywordsInput.value.trim()
          : '';
      const regionValue =
        scraperRegionInput && scraperRegionInput.value
          ? scraperRegionInput.value.trim()
          : '';
      const maxPagesValue =
        scraperMaxPagesInput && scraperMaxPagesInput.value
          ? scraperMaxPagesInput.value.trim()
          : '';

      if (keywordsValue) {
        options.keywords = keywordsValue;
      }
      if (regionValue) {
        options.region = regionValue;
      }
      if (maxPagesValue) {
        options.maxPages = maxPagesValue;
      }

      const scraperName =
        scraperSourceInput && scraperSourceInput.value
          ? scraperSourceInput.value
          : 'apsjobs';

      try {
        const res = await fetch(
          `/admin/scraper/run?token=${encodeURIComponent(ADMIN_TOKEN)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: scraperName,
              options,
            }),
          }
        );

        let json;
        try {
          json = await res.json();
        } catch {
          json = {};
        }

        if (res.ok) {
          if (json && json.runId) {
            scraperStatus.textContent = scraperTexts.startedWithId.replace(
              '{runId}',
              json.runId,
            );
            handleScraperSnapshot({
              id: String(json.runId),
              scraper_name: scraperName,
              status: 'queued',
              progress: {
                total: 0,
                current: 0,
                message: scraperTexts.triggering,
              },
            });
            connectScraperProgress(json.runId);
          } else {
            scraperStatus.textContent = scraperTexts.started;
          }
        } else {
          const message = (json && json.error) || res.statusText || '未知错误';
          scraperStatus.textContent = `${scraperTexts.triggerFailedPrefix}${message}`;
          scraperStatus.classList.add('error-message');
        }
      } catch (err) {
        scraperStatus.textContent = scraperTexts.networkError;
        scraperStatus.classList.add('error-message');
      } finally {
        scraperBtn.disabled = false;
        scraperBtn.classList.remove('loading');
      }
    });
  }

  if (uploadForm && uploadTextarea && uploadStatus) {
    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      uploadStatus.textContent = '';
      uploadStatus.classList.remove('error-message');

      let parsed;
      try {
        parsed = JSON.parse(uploadTextarea.value);
      } catch (err) {
        uploadStatus.textContent = 'JSON 解析失败，请检查格式。';
        uploadStatus.classList.add('error-message');
        return;
      }

      try {
        const res = await fetch('/admin/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(parsed),
        });
        const json = await res.json();
        if (res.ok) {
          uploadStatus.textContent = `上传成功，插入职位数量：${json.inserted}`;
        } else {
          uploadStatus.textContent = `上传失败：${json.error || res.statusText}`;
          uploadStatus.classList.add('error-message');
        }
      } catch (err) {
        uploadStatus.textContent = `上传失败：网络错误或服务器不可用。`;
        uploadStatus.classList.add('error-message');
      }
    });
  }

  window.addEventListener('beforeunload', closeScraperEventSource);
});
