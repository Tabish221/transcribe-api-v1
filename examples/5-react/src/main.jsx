import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { applyTheme, readTheme } from './components/ThemeToggle.jsx';
import './styles.css';

applyTheme(readTheme()); // before the first paint, so there is no light/dark flash

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
