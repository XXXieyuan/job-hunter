(function () {
  const filterForm = document.querySelector('[data-filter-form]');
  if (filterForm) {
    filterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const formData = new FormData(filterForm);
      const url = new URL('/jobs', window.location.origin);
      for (const [key, value] of formData.entries()) {
        if (value) {
          url.searchParams.set(key, value);
        }
      }
      window.location.href = url.toString();
    });
  }

  document.querySelectorAll('[data-job-status]').forEach((element) => {
    element.addEventListener('change', async (event) => {
      const target = event.currentTarget;
      try {
        await window.JobHunter.request(`/api/jobs/${target.dataset.jobId}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: target.value })
        });
        window.JobHunter.showToast('Status updated');
      } catch (error) {
        window.JobHunter.showToast(error.message);
      }
    });
  });
})();
