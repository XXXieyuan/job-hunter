import React, { useEffect, useState } from 'react';
import { resumesApi, Resume } from '../../api/resumes';
import { matchApi, MatchResponse } from '../../api/match';
import './MatchPage.css';

export const MatchPage: React.FC = () => {
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [matches, setMatches] = useState<MatchResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    resumesApi
      .list()
      .then((res) => setResumes(res))
      .catch(() => setResumes([]));
  }, []);

  const runMatch = () => {
    if (!selectedId) return;
    setLoading(true);
    matchApi
      .run(selectedId)
      .then((res) => setMatches(res))
      .finally(() => setLoading(false));
  };

  return (
    <div className="match-page">
      <h1>Match</h1>
      <div className="match-controls">
        <select
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Select resume</option>
          {resumes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button onClick={runMatch} disabled={!selectedId || loading}>
          {loading ? 'Matching...' : 'Run Matching'}
        </button>
      </div>

      {matches && (
        <div className="match-results">
          {matches.matches.map((m) => (
            <div key={m.job_id} className="match-card">
              <div className="match-header">
                <div className="match-title">
                  {m.job.title}{' '}
                  {m.job.company_name && <span className="match-company">· {m.job.company_name}</span>}
                </div>
                <div className="match-score">
                  <div className="match-score-bar">
                    <div
                      className="match-score-fill"
                      style={{ width: `${Math.round(m.overall_score * 100)}%` }}
                    />
                  </div>
                  <div className="match-score-text">
                    {Math.round(m.overall_score * 100)}% match
                  </div>
                </div>
              </div>
              <div className="match-meta">
                {m.job.location && <span>{m.job.location}</span>}
                {m.job.source && <span> · {m.job.source}</span>}
              </div>
              <div className="match-skills">
                <div>
                  <div className="match-skills-label">Matched skills</div>
                  <div className="match-skills-chips">
                    {m.explanation.matched_skills.map((s) => (
                      <span key={s} className="chip chip-green">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="match-skills-label">Missing skills</div>
                  <div className="match-skills-chips">
                    {m.explanation.missing_skills.map((s) => (
                      <span key={s} className="chip chip-red">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

