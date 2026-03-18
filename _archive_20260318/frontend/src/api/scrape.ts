import { http } from './http';

export interface ScrapeRun {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress?: {
    total: number;
    current: number;
    message: string;
  };
  jobs_added?: number;
  error?: string | null;
}

export const scrapeApi = {
  run: () => http.post<ScrapeRun>('/api/scrape/run'),
  status: (id: string) => http.get<ScrapeRun>(`/api/scrape/status/${id}`),
  history: () => http.get<ScrapeRun[]>('/api/scrape/history')
};

