import React, { useEffect, useState } from 'react';
import { resumesApi, Resume } from '../../api/resumes';
import './ResumesPage.css';

export const ResumesPage: React.FC = () => {
  const [items, setItems] = useState<Resume[]>([]);
  const [uploading, setUploading] = useState(false);

  const load = () => {
    resumesApi
      .list()
      .then((res) => setItems(res))
      .catch(() => setItems([]));
  };

  useEffect(() => {
    load();
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      alert('File too large (max 5MB)');
      return;
    }
    if (
      file.type !==
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
      !file.name.toLowerCase().endsWith('.docx')
    ) {
      alert('Only .docx files are allowed');
      return;
    }

    setUploading(true);
    resumesApi
      .upload(file)
      .then(() => {
        load();
      })
      .finally(() => setUploading(false));
  };

  const onDelete = (id: number) => {
    if (!window.confirm('Delete this resume?')) return;
    resumesApi
      .delete(id)
      .then(() => load())
      .catch(() => {});
  };

  return (
    <div className="resumes-page">
      <h1>Resumes</h1>

      <label className="resume-uploader">
        <input
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={onFileChange}
          disabled={uploading}
        />
        <span>{uploading ? 'Uploading...' : 'Upload .docx (max 5MB)'}</span>
      </label>

      <div className="resumes-list">
        {items.map((resume) => (
          <div key={resume.id} className="resume-card">
            <div className="resume-header">
              <div>
                <div className="resume-name">{resume.name}</div>
                <div className="resume-meta">{resume.created_at}</div>
                <div className="resume-skills">
                  {resume.skills?.map((s) => (
                    <span key={s} className="chip">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => onDelete(resume.id)}>Delete</button>
            </div>
            {resume.raw_text_preview && (
              <p className="resume-preview">{resume.raw_text_preview}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

