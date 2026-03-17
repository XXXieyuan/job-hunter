// Main frontend behaviors for Job Hunter
// - Job detail tab switching
// - Score color coding helpers

function classifyScore(score) {
  if (typeof score !== 'number' || isNaN(score)) return 'score-red';
  if (score >= 80) return 'score-green';
  if (score >= 60) return 'score-yellow';
  if (score >= 40) return 'score-orange';
  return 'score-red';
}

function applyScoreColoring() {
  const scores = document.querySelectorAll('.score-value[data-score]');
  scores.forEach((el) => {
    const raw = parseFloat(el.dataset.score);
    const variant = classifyScore(raw);
    el.classList.remove('score-green', 'score-yellow', 'score-orange', 'score-red');
    el.classList.add(variant);
  });
}

function initTabs() {
  const tabContainers = document.querySelectorAll('.tabs[data-tabs-root]');
  tabContainers.forEach((tabsEl) => {
    const rootId = tabsEl.dataset.tabsRoot;
    const root = rootId ? document.getElementById(rootId) : tabsEl.closest('.tab-content-root');
    if (!root) return;

    const buttons = tabsEl.querySelectorAll('.tab-btn[data-tab-target]');
    const panes = root.querySelectorAll('.tab-pane[data-tab-id]');

    const activate = (id) => {
      buttons.forEach((btn) => {
        const target = btn.getAttribute('data-tab-target');
        btn.classList.toggle('active', target === id);
      });
      panes.forEach((pane) => {
        const pid = pane.getAttribute('data-tab-id');
        pane.classList.toggle('active', pid === id);
      });
    };

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-tab-target');
        if (!id) return;
        activate(id);
      });
    });

    // Activate first tab by default if nothing is active
    const initial =
      Array.from(buttons).find((b) => b.classList.contains('active')) ||
      (buttons.length ? buttons[0] : null);
    if (initial) {
      const id = initial.getAttribute('data-tab-target');
      if (id) activate(id);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const prefersReducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  if (!prefersReducedMotion) {
    document.documentElement.classList.add('motion-enabled');
  }

  function initNavToggle() {
    const header = document.querySelector('.app-header');
    const toggle = document.querySelector('.nav-toggle');
    if (!header || !toggle) return;

    toggle.addEventListener('click', () => {
      const isOpen = header.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }

  applyScoreColoring();
  initTabs();
  initNavToggle();
});
