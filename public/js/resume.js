(function () {
  const form = document.querySelector('[data-resume-form]');
  const zone = document.querySelector('[data-upload-zone]');
  if (!form || !zone) {
    return;
  }

  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-dragging');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('is-dragging');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const file = formData.get('file');
    if (!file || !file.name) {
      window.JobHunter.showToast('Please choose a resume file');
      return;
    }

    if (!/\.(docx|pdf)$/i.test(file.name)) {
      window.JobHunter.showToast('Only .docx and .pdf files are supported');
      return;
    }

    try {
      await window.JobHunter.request('/api/resumes/upload', {
        method: 'POST',
        body: formData
      });
      window.JobHunter.showToast('Resume uploaded');
      window.location.reload();
    } catch (error) {
      window.JobHunter.showToast(error.message);
    }
  });

  document.querySelectorAll('[data-set-primary]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await window.JobHunter.request(`/api/resumes/${button.dataset.id}/primary`, { method: 'PUT' });
        window.location.reload();
      } catch (error) {
        window.JobHunter.showToast(error.message);
      }
    });
  });

  document.querySelectorAll('[data-delete-resume]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await window.JobHunter.request(`/api/resumes/${button.dataset.id}`, { method: 'DELETE' });
        window.location.reload();
      } catch (error) {
        window.JobHunter.showToast(error.message);
      }
    });
  });
})();
