import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartPage } from './ChartPage';
import { Landing } from './Landing';
import './styles.css';

const isChart = window.location.pathname.startsWith('/chart');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isChart ? <ChartPage /> : <Landing />}</StrictMode>,
);
