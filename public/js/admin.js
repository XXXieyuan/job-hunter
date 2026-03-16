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
  const scraperKeywordsInput = document.getElementById('scraper-keywords');
  const scraperRegionInput = document.getElementById('scraper-region');
  const scraperMaxPagesInput = document.getElementById('scraper-max-pages');

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
          unknown: '未知',
        },
      };

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
      const res = await fetch('/admin/scraper/runs', {
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

      const rowsHtml = runs
        .map((run) => {
          const status = run.status || '';
          let statusClass = 'status-pill';
          if (status === 'running' || status === 'queued') {
            statusClass += ' status-running';
          } else if (status === 'success') {
            statusClass += ' status-success';
          } else if (status === 'failure') {
            statusClass += ' status-failed';
          }

          const statusLabel =
            (scraperTexts.statuses && scraperTexts.statuses[status]) ||
            status ||
            (scraperTexts.statuses && scraperTexts.statuses.unknown) ||
            '';

          const jobsAdded =
            typeof run.jobs_added === 'number' ? run.jobs_added : '-';
          const errorMessage = run.error_message || '-';
          const startedAt = run.started_at || '-';
          const finishedAt = run.finished_at || '-';

          return `
            <tr data-run-id="${run.id}">
              <td>${run.id}</td>
              <td>${run.scraper_name || '-'}</td>
              <td><span class="${statusClass}">${statusLabel}</span></td>
              <td>${startedAt}</td>
              <td>${finishedAt}</td>
              <td>${jobsAdded}</td>
              <td class="small">${errorMessage}</td>
            </tr>
          `;
        })
        .join('');

      tbody.innerHTML = rowsHtml;
    } catch {
      // Ignore polling errors; UI will show last known state.
    }
  }

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

      try {
        const res = await fetch(
          `/admin/scraper/run?token=${encodeURIComponent(ADMIN_TOKEN)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: 'apsjobs',
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
          } else {
            scraperStatus.textContent = scraperTexts.started;
          }
          // Immediately refresh history once after triggering
          refreshScraperRuns();
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

    // Initial fetch and polling for scraper run status
    refreshScraperRuns();
    setInterval(refreshScraperRuns, 5000);
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
});
