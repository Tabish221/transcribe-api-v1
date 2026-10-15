// ThemeToggle.jsx - Auto (follows Windows) -> Light -> Dark. The choice is remembered in this browser.
import { useEffect, useState } from 'react';
import { AutoIcon, MoonIcon, SunIcon } from './Icons.jsx';

const ORDER = ['auto', 'light', 'dark'];
const ICONS = { auto: AutoIcon, light: SunIcon, dark: MoonIcon };
const LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };

export function readTheme() {
  try {
    const saved = localStorage.getItem('theme');
    return ORDER.includes(saved) ? saved : 'auto';
  } catch {
    return 'auto'; // storage blocked (private window etc.)
  }
}

/** Light/dark colors live in styles.css; this only sets <html data-theme="...">. */
export function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* not important */
    }
  }, [theme]);

  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  const Icon = ICONS[theme];
  return (
    <button
      type="button"
      className="btn ghost theme-btn"
      onClick={() => setTheme(next)}
      title={`Theme: ${LABELS[theme]}. Click for ${LABELS[next]}.`}
    >
      <Icon />
      <span>{LABELS[theme]}</span>
    </button>
  );
}
