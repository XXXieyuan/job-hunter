(function () {
  function showToast(message) {
    const stack = document.querySelector('[data-toast-stack]');
    if (!stack) {
      return;
    }

    const element = document.createElement('div');
    element.className = 'toast';
    element.textContent = message;
    stack.appendChild(element);
    setTimeout(() => element.remove(), 3200);
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const error = new Error(payload.message || 'Request failed');
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function toggleLanguage() {
    const button = document.querySelector('[data-lang-toggle]');
    if (!button) {
      return;
    }

    button.addEventListener('click', () => {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('lang', document.body.dataset.lang === 'en' ? 'zh' : 'en');
      window.location.href = currentUrl.toString();
    });
  }

  window.JobHunter = {
    request,
    showToast
  };

  toggleLanguage();
})();
