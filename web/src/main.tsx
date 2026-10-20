import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartPage } from './ChartPage';
import { Landing } from './Landing';
import { AdminPage } from './admin/AdminPage';
import './styles.css';

const path = window.location.pathname;
const Page = path.startsWith('/chart') ? ChartPage : path.startsWith('/admin') ? AdminPage : Landing;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
