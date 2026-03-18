(function () {
  const form = document.querySelector('[data-scrape-form]');
  const progressBlock = document.querySelector('[data-scrape-progress]');
  const progressFill = document.querySelector('[data-scrape-progress-fill]');
  const progressText = document.querySelector('[data-scrape-progress-text]');

  if (!form) {
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    try {
      const response = await window.JobHunter.request('/api/scrape/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      progressBlock.hidden = false;
      progressFill.style.width = '10%';
      progressText.textContent = 'Scrape started...';

      const source = new EventSource(`/api/scrape/progress/${response.history_id}`);
      source.onmessage = (message) => {
        const payloadData = JSON.parse(message.data);
        if (payloadData.type === 'page_done') {
          progressFill.style.width = `${Math.min(100, payloadData.page * 20)}%`;
          progressText.textContent = `Page ${payloadData.page} complete · ${payloadData.total_found} jobs`;
        }
        if (payloadData.type === 'done') {
          progressFill.style.width = '100%';
          progressText.textContent = `Completed with ${payloadData.jobsFound} jobs`;
          source.close();
        }
        if (payloadData.type === 'warning' || payloadData.type === 'error') {
          progressText.textContent = payloadData.message;
        }
      };
    } catch (error) {
      window.JobHunter.showToast(error.message);
    }
  });
})();
