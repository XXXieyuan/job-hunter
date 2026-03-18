import { http } from './http';

export interface Job {
  id: number;
  title: string;
  company_name?: string;
  location?: string;
  source?: string;
  is_active: number;
  description?: string;
  skills?: {
    required?: string[];
    nice_to_have?: string[];
  };
}

export interface JobsListResponse {
  items: Job[];
  page: number;
  pageSize: number;
  total: number;
}

export const jobsApi = {
  list: (params: Record<string, string | number | undefined> = {}) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        query.set(key, String(value));
      }
    });
    const q = query.toString();
    const url = q ? `/api/jobs?${q}` : '/api/jobs';
    return http.get<JobsListResponse>(url);
  },
  get: (id: number) => http.get<Job>(`/api/jobs/${id}`),
  export: (format: 'csv' | 'json') => {
    const url = `/api/jobs/export?format=${format}`;
    return fetch(url);
  }
};

