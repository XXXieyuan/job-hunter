import { http } from './http';

export interface Resume {
  id: number;
  name: string;
  created_at: string;
  skills?: string[];
  domains?: string[];
  seniority?: string;
  raw_text_preview?: string;
}

export interface ResumeUploadResponse extends Resume {}

export const resumesApi = {
  list: () => http.get<Resume[]>('/api/resumes'),
  upload: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/resumes/upload', {
      method: 'POST',
      body: formData
    });
    if (!res.ok) {
      throw new Error(`Upload failed: ${res.status}`);
    }
    return (await res.json()) as ResumeUploadResponse;
  },
  delete: (id: number) => http.delete<void>(`/api/resumes/${id}`)
};

