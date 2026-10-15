// App.jsx - the page frame: top bar with two tabs, and the two pages.
//   #/        -> Transcribe  (upload an MP3, watch the status, read + play the transcript)
//   #/tester  -> API Tester  (call every API endpoint through the backend and see request + response)
// Both pages stay mounted (only hidden), so a running job keeps polling when you switch tabs.
import { useEffect, useState } from 'react';
import { getConfig } from './api.js';
import TranscribePage from './pages/TranscribePage.jsx';
import TesterPage from './pages/TesterPage.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import { WaveIcon } from './components/Icons.jsx';

const ROUTES = {
  transcribe: { hash: '#/', label: 'Transcribe', title: 'Transcribe – React demo' },
  tester: { hash: '#/tester', label: 'API Tester', title: 'API Tester – React demo' },
};

/** Tiny hash router: "#/tester" -> "tester", anything else -> "transcribe". */
function readRoute() {
  return window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] === 'tester' ? 'tester' : 'transcribe';
}

function useHashRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();
  const [config, setConfig] = useState(null); // defaults from the backend (.env) - never contains the key
  const [configError, setConfigError] = useState(null);

  // Load the defaults once; both pages use them.
  useEffect(() => {
    const ctrl = new AbortController();
    getConfig(ctrl.signal)
      .then(setConfig)
      .catch((err) => err.name !== 'AbortError' && setConfigError(err));
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    document.title = ROUTES[route].title;
  }, [route]);

  // Dropping a file outside a drop zone should not open it in the browser tab.
  useEffect(() => {
    const block = (e) => e.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            <WaveIcon />
          </span>
          <div>
            <h1>Transcribe</h1>
            <p>React demo · your API key stays on the backend</p>
          </div>
        </div>
        <nav className="tabs" aria-label="Pages">
          {Object.entries(ROUTES).map(([key, r]) => (
            <a key={key} href={r.hash} className="tab" aria-current={route === key ? 'page' : undefined}>
              {r.label}
            </a>
          ))}
        </nav>
        <ThemeToggle />
      </header>

      {configError && (
        <div className="banner" role="alert">
          <strong>The demo backend did not answer.</strong> {configError.message}
        </div>
      )}

      <div className="page" hidden={route !== 'transcribe'}>
        <TranscribePage config={config} />
      </div>
      <div className="page" hidden={route !== 'tester'}>
        <TesterPage config={config} />
      </div>

      <footer className="footer">
        Browser → <code>server.mjs</code> (adds the API key) → Transcribe API. The key never reaches this page.
      </footer>
    </div>
  );
}
