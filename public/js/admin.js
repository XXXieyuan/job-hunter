document.addEventListener('DOMContentLoaded', () => {
  const runBtn = document.getElementById('run-analysis-btn');
  const runStatus = document.getElementById('run-analysis-status');
  const uploadForm = document.getElementById('upload-form');
  const uploadTextarea = document.getElementById('upload-json');
  const uploadStatus = document.getElementById('upload-status');

  if (runBtn && runStatus) {
    const token = 'job-hunter-admin-2026';

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.classList.add('loading');
      runStatus.textContent = '正在触发分析，请稍候…';

      try {
        const res = await fetch(`/admin/run?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token }),
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
              ? `分析已启动，运行 ID：${json.runId}。请稍后刷新查看结果。`
              : '分析已启动，请稍后刷新查看结果。';
        } else {
          const message = (json && json.error) || res.statusText || '未知错误';
          runStatus.textContent = `触发分析失败：${message}`;
          runStatus.classList.add('error-message');
        }
      } catch (err) {
        runStatus.textContent = `触发分析失败：网络错误或服务器不可用。`;
        runStatus.classList.add('error-message');
      } finally {
        runBtn.disabled = false;
        runBtn.classList.remove('loading');
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
});

