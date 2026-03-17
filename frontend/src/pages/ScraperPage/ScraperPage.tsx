import React, { useEffect, useState } from 'react';
import { scrapeApi, ScrapeRun } from '../../api/scrape';
import './ScraperPage.css';

export const ScraperPage: React.FC = () => {
  const [current, setCurrent] = useState<ScrapeRun | null>(null);
  const [history, setHistory] = useState<ScrapeRun[]>([]);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    scrapeApi
      .history()
      .then((runs) => setHistory(runs))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    if (!current || !polling) return;
    const started = Date.now();

    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      if (elapsed > 10 * 60 * 1000) {
        setPolling(false);
        setCurrent((prev) =>
          prev
            ? {
                ...prev,
                status: 'failed',
                error: 'Scrape timed out. Check logs.'
              }
            : prev
        );
        clearInterval(timer);
        return;
      }

      scrapeApi
        .status(current.id)
        .then((run) => {
          setCurrent(run);
          if (run.status === 'completed' || run.status === 'failed') {
            setPolling(false);
            clearInterval(timer);
            scrapeApi
              .history()
              .then((runs) => setHistory(runs))
              .catch(() => {});
          }
        })
        .catch(() => {
          // non-blocking error: keep polling
        });
    }, 3000);

    return () => clearInterval(timer);
  }, [current, polling]);

  const runScraper = () => {
    scrapeApi
      .run()
      .then((run) => {
        setCurrent(run);
        setPolling(true);
      })
      .catch(() => {
        // ignore
      });
  };

  const progress = current?.progress;
  const percent =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : current?.status === 'completed'
      ? 100
      : 0;

  return (
    <div className="scraper-page">
      <h1>Scraper</h1>
      <button onClick={runScraper} className="scraper-run-button">
        Run Scraper
      </button>

      {current && (
        <div className="scraper-progress-card">
          <div className="scraper-progress-header">
            <span>Run {current.id}</span>
            <span className={`status status-${current.status}`}>{current.status}</span>
          </div>
          <div className="scraper-progress-bar">
            <div className="scraper-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="scraper-progress-meta">
            <span>{percent}%</span>
            {current.jobs_added != null && <span>{current.jobs_added} jobs added</span>}
          </div>
          {progress?.message && <div className="scraper-progress-message">{progress.message}</div>}
          {current.error && <div className="scraper-error-banner">{current.error}</div>}
        </div>
      )}

      <h2>Recent Runs</h2>
      <table className="scraper-history-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Jobs Added</th>
          </tr>
        </thead>
        <tbody>
          {history.map((run) => (
            <tr key={run.id}>
              <td>{run.id}</td>
              <td>
                <span className={`status status-${run.status}`}>{run.status}</span>
              </td>
              <td>{run.jobs_added ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

