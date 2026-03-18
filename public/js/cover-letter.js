(function () {
  const form = document.querySelector('[data-cover-letter-form]');
  const output = document.querySelector('[data-cover-letter-output]');
  const copyButton = document.querySelector('[data-copy-cover-letter]');
  const downloadButton = document.querySelector('[data-download-cover-letter]');

  if (form && output) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await window.JobHunter.request('/api/cover-letters/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        output.value = response.content;
        window.JobHunter.showToast('Cover letter generated');
      } catch (error) {
        window.JobHunter.showToast(error.message);
      }
    });
  }

  if (copyButton && output) {
    copyButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(output.value);
      window.JobHunter.showToast('Copied to clipboard');
    });
  }

  if (downloadButton && output) {
    downloadButton.addEventListener('click', () => {
      const blob = new Blob([output.value], { type: 'text/plain;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'cover-letter.txt';
      link.click();
      URL.revokeObjectURL(link.href);
    });
  }
})();
