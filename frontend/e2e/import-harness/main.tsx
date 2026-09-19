import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ProjectImportPanel } from '@/pages/ProjectImport';
createRoot(document.getElementById('root')!).render(<BrowserRouter><ProjectImportPanel embedded /></BrowserRouter>);
