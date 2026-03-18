import React, { useEffect, useState } from 'react';
import { jobsApi, Job, JobsListResponse } from '../../api/jobs';
import './JobsPage.css';

export const JobsPage: React.FC = () => {
  const [items, setItems] = useState<Job[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('');
  const [source, setSource] = useState('');
  const [isActive, setIsActive] = useState<'1' | '0' | ''>('1');

  useEffect(() => {
    const params: Record<string, string | number | undefined> = {
      page,
      search: search || undefined,
      location: location || undefined,
      source: source || undefined,
      is_active: isActive || undefined
    };
    jobsApi
      .list(params)
      .then((res: JobsListResponse) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch(() => {
        setItems([]);
        setTotal(0);
      });
  }, [page, search, location, source, isActive]);

  const totalPages = total > 0 ? Math.ceil(total / 20) : 1;

  return (
    <div className="jobs-page">
      <h1>Jobs</h1>
      <div className="jobs-filters">
        <input
          placeholder="Search title, company, description"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
        />
        <input
          placeholder="Location"
          value={location}
          onChange={(e) => {
            setPage(1);
            setLocation(e.target.value);
          }}
        />
        <input
          placeholder="Source"
          value={source}
          onChange={(e) => {
            setPage(1);
            setSource(e.target.value);
          }}
        />
        <select
          value={isActive}
          onChange={(e) => {
            setPage(1);
            setIsActive(e.target.value as '1' | '0' | '');
          }}
        >
          <option value="">All</option>
          <option value="1">Active</option>
          <option value="0">Inactive</option>
        </select>
      </div>

      <div className="jobs-list">
        {items.map((job) => (
          <div key={job.id} className="job-card">
            <div className="job-card-header">
              <div>
                <div className="job-title">{job.title}</div>
                <div className="job-meta">
                  {job.company_name && <span>{job.company_name}</span>}
                  {job.location && <span> · {job.location}</span>}
                </div>
              </div>
              <div className="job-badges">
                {job.source && <span className="job-badge">{job.source}</span>}
                <span className={job.is_active ? 'job-status active' : 'job-status inactive'}>
                  {job.is_active ? 'Active' : 'Expired'}
                </span>
              </div>
            </div>
            {job.description && (
              <p className="job-description">
                {job.description.length > 280
                  ? job.description.slice(0, 280) + '...'
                  : job.description}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="jobs-pagination">
        <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Previous
        </button>
        <span>
          Page {page} / {totalPages}
        </span>
        <button
          disabled={page >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        >
          Next
        </button>
      </div>
    </div>
  );
};

