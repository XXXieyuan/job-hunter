import { http } from './http';

export interface MatchExplanation {
  matched_skills: string[];
  missing_skills: string[];
  highlights: string[];
}

export interface MatchJobSummary {
  title: string;
  company_name?: string;
  location?: string;
  source?: string;
}

export interface MatchResult {
  job_id: number;
  overall_score: number;
  similarity_score: number;
  skill_score: number;
  job: MatchJobSummary;
  explanation: MatchExplanation;
}

export interface MatchResponse {
  resume_id: number;
  matches: MatchResult[];
}

export const matchApi = {
  run: (resumeId: number, limit = 50) =>
    http.post<MatchResponse>('/api/match', { resume_id: resumeId, limit }),
  history: () => http.get<MatchResponse[]>('/api/match/history')
};

