(function () {
  const form = document.querySelector('[data-admin-config-form]');
  const filter = document.querySelector('[data-log-filter]');
  const logList = document.querySelector('[data-log-list]');

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        await window.JobHunter.request('/api/admin/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        window.JobHunter.showToast('Configuration saved');
      } catch (error) {
        window.JobHunter.showToast(error.message);
      }
    });
  }

  if (filter && logList) {
    filter.addEventListener('change', async () => {
      const query = filter.value ? `?level=${filter.value}` : '';
      try {
        const rows = await window.JobHunter.request(`/api/admin/logs${query}`);
        logList.innerHTML = rows.map((entry) => `
          <article class="log-item log-item--${entry.level}">
            <strong>${entry.action}</strong>
            <span>${entry.detail || ''}</span>
            <time>${entry.created_at}</time>
          </article>
        `).join('');
      } catch (error) {
        window.JobHunter.showToast(error.message);
      }
    });
  }
})();
