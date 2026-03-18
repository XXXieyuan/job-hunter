import React from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { AppRouter } from './router';

export const App: React.FC = () => {
  return (
    <AppLayout>
      <AppRouter />
    </AppLayout>
  );
};

