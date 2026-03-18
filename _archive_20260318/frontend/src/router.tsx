import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { JobsPage } from './pages/JobsPage/JobsPage';
import { ScraperPage } from './pages/ScraperPage/ScraperPage';
import { ResumesPage } from './pages/ResumesPage/ResumesPage';
import { MatchPage } from './pages/MatchPage/MatchPage';

export const AppRouter: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/jobs" replace />} />
      <Route path="/jobs" element={<JobsPage />} />
      <Route path="/scraper" element={<ScraperPage />} />
      <Route path="/resumes" element={<ResumesPage />} />
      <Route path="/match" element={<MatchPage />} />
    </Routes>
  );
};

