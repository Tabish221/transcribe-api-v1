// TesterPage.jsx - "API Tester": one card per backend action. Each card calls
//   POST /api/tester/<action>  (our backend)  ->  the Transcribe API endpoint (with the secret key)
// and shows the real request (key masked) next to the real response.
import { useCallback, useEffect, useRef, useState } from 'react';
import { callTester } from '../api.js';
import { LANGUAGES } from '../languages.js';
import Exchange from '../tester/Exchange.jsx';
import FilePicker from '../tester/FilePicker.jsx';
import History from '../tester/History.jsx';
import RunAllChecks from '../tester/RunAllChecks.jsx';
import { MethodBadge } from '../tester/Badges.jsx';
import { AlertIcon, SendIcon, TrashIcon } from '../components/Icons.jsx';

const CARDS = [
  {
    action: 'health',
    method: 'GET',
    path: '/api/v1/health',
    title: 'Health',
    text: 'Is the API up? Which engines are on? This call needs no key.',
  },
  {
    action: 'list',
    method: 'GET',
    path: '/api/v1/transcriptions',
    title: 'List transcriptions',
    text: 'Newest first. Click an id in the answer to use it in the cards below.',
  },
  {
    action: 'upload',
    method: 'POST',
    path: '/api/v1/transcriptions',
    title: 'Upload',
    text: 'Sends the MP3 as multipart/form-data. Empty fields are not sent, so the API uses the project defaults.',
  },
  {
    action: 'get',
    method: 'GET',
    path: '/api/v1/transcriptions/{id}',
    title: 'Get one transcription',
    text: 'Status and progress %. When completed: text and segments.',
  },
  {
    action: 'format',
    method: 'GET',
    path: '/api/v1/transcriptions/{id}?format=…',
    title: 'Download as a file',
    text: 'txt, srt, vtt or json. Answers 409 not_ready until the job is completed.',
  },
  {
    action: 'delete',
    method: 'DELETE',
    path: '/api/v1/transcriptions/{id}',
    title: 'Delete',
    text: 'Removes the transcription and its audio file. This cannot be undone.',
  },
  {
    action: 'webhook-info',
    method: 'GET',
    path: '/api/v1/transcriptions?limit=10',
    title: 'Webhook info',
    text: 'The webhook_status of the latest jobs, plus the headers and the signature your receiver must check.',
  },
];
const ID_ACTIONS = new Set(['get', 'format', 'delete']);
const MAX_HISTORY = 50;

/** One action: title, inputs, Send button, and the last request/response. */
function ActionCard({ card, busy, canSend, result, onSend, onPickId, children }) {
  const danger = card.action === 'delete';
  const [confirming, setConfirming] = useState(false);

  // "Delete" needs a second click within 5 seconds.
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(timer);
  }, [confirming]);

  function click() {
    if (danger && !confirming) return setConfirming(true);
    setConfirming(false);
    onSend();
  }

  return (
    <section className="card action-card" aria-labelledby={`card-${card.action}`}>
      <div className="action-head">
        <div className="grow">
          <h3 id={`card-${card.action}`}>{card.title}</h3>
          <p className="endpoint">
            <MethodBadge method={card.method} />
            <code>{card.path}</code>
          </p>
          <p className="muted small">{card.text}</p>
        </div>
      </div>

      <div className="action-body">
        {children && <div className="inputs">{children}</div>}
        <button
          type="button"
          className={`btn ${danger ? 'danger' : 'primary'} send-btn${busy ? ' busy' : ''}`}
          onClick={click}
          disabled={busy || !canSend}
        >
          {danger ? <TrashIcon /> : <SendIcon />}
          {busy ? 'Sending…' : confirming ? 'Click again to delete' : 'Send'}
        </button>
      </div>

      {result && <Exchange exchange={result} onPickId={onPickId} />}
    </section>
  );
}

export default function TesterPage({ config }) {
  const [file, setFile] = useState(null); // shared by "Upload" and "Run all checks"
  const [id, setId] = useState(''); // shared by Get, Format and Delete
  const [list, setList] = useState({ status: '', limit: '5' });
  const [upload, setUpload] = useState({ engine: 'worker', language: '', task: '', prompt: '', wait: false });
  const [format, setFormat] = useState('srt');
  const [results, setResults] = useState({}); // last exchange per action
  const [busy, setBusy] = useState({});
  const [history, setHistory] = useState([]);
  const [pickError, setPickError] = useState(null);
  const counter = useRef(0);

  const addToHistory = useCallback((exchange) => {
    counter.current += 1;
    const item = { ...exchange, n: counter.current };
    setHistory((h) => [item, ...h].slice(0, MAX_HISTORY));
  }, []);

  // Clicking a "tr_..." id in any JSON answer puts it into the shared id field.
  const pickId = useCallback((value) => setId(value), []);

  async function send(action) {
    let input = {};
    if (action === 'list') input = list;
    if (ID_ACTIONS.has(action)) input = { id: id.trim(), ...(action === 'format' && { format }) };
    if (action === 'upload') {
      input = new FormData();
      input.append('file', file);
      for (const name of ['engine', 'language', 'task', 'prompt']) if (upload[name].trim()) input.append(name, upload[name].trim());
      if (upload.wait) input.append('wait', 'true');
    }

    setBusy((b) => ({ ...b, [action]: true }));
    try {
      const exchange = await callTester(action, input);
      setResults((r) => ({ ...r, [action]: exchange }));
      addToHistory(exchange);
      if (action === 'upload' && exchange.response.body?.id) setId(exchange.response.body.id);
    } finally {
      setBusy((b) => ({ ...b, [action]: false }));
    }
  }

  const idField = (
    <label className="field">
      <span>Transcription ID (shared by Get, Format and Delete)</span>
      <input
        className="mono"
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder="tr_ + 24 hex characters"
        spellCheck={false}
        autoComplete="off"
      />
    </label>
  );

  function inputsFor(action) {
    switch (action) {
      case 'list':
        return (
          <>
            <label className="field">
              <span>status</span>
              <select value={list.status} onChange={(e) => setList({ ...list, status: e.target.value })}>
                <option value="">(any)</option>
                {['queued', 'processing', 'completed', 'failed'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>limit (1–100)</span>
              <input type="number" min="1" max="100" value={list.limit} onChange={(e) => setList({ ...list, limit: e.target.value })} />
            </label>
          </>
        );
      case 'upload':
        return (
          <>
            <div className="field span-all">
              <span>file</span>
              <FilePicker file={file} onFile={(f) => (setPickError(null), setFile(f))} onError={setPickError} />
              {pickError && (
                <p className="inline-error" role="alert">
                  <AlertIcon /> {pickError}
                </p>
              )}
            </div>
            <label className="field">
              <span>engine</span>
              <select value={upload.engine} onChange={(e) => setUpload({ ...upload, engine: e.target.value })}>
                <option value="">(not sent)</option>
                <option value="worker">worker</option>
                <option value="cloud">cloud – needs cloud key on server</option>
              </select>
            </label>
            <label className="field">
              <span>language</span>
              <select value={upload.language} onChange={(e) => setUpload({ ...upload, language: e.target.value })}>
                <option value="">(not sent)</option>
                {LANGUAGES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {code} – {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>task</span>
              <select value={upload.task} onChange={(e) => setUpload({ ...upload, task: e.target.value })}>
                <option value="">(not sent)</option>
                <option value="transcribe">transcribe</option>
                <option value="translate">translate (to English)</option>
              </select>
            </label>
            <label className="field span-all">
              <span>prompt (cloud only, vocabulary hints)</span>
              <input
                value={upload.prompt}
                maxLength={1000}
                onChange={(e) => setUpload({ ...upload, prompt: e.target.value })}
                placeholder="Names or words to spell right"
              />
            </label>
            <label className="check-field span-all">
              <input type="checkbox" checked={upload.wait} onChange={(e) => setUpload({ ...upload, wait: e.target.checked })} />
              <span>
                <code>wait=true</code> – cloud only: the answer already contains the text. The worker ignores it.
              </span>
            </label>
          </>
        );
      case 'get':
      case 'delete':
        return idField;
      case 'format':
        return (
          <>
            {idField}
            <label className="field">
              <span>format</span>
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                {['txt', 'srt', 'vtt', 'json'].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
          </>
        );
      default:
        return null;
    }
  }

  function canSend(action) {
    if (action === 'upload') return Boolean(file);
    if (ID_ACTIONS.has(action)) return id.trim() !== '';
    return true;
  }

  return (
    <main className="tester">
      <section className="tester-intro">
        <h2>API Tester</h2>
        <p className="muted">
          Every button calls <strong>your backend</strong> (<code>server.mjs</code>). The backend adds the API key and calls the Transcribe API.
          You see the real request (key hidden) and the real answer.
        </p>
        <ul className="chips">
          <li>
            API: <span className="mono">{config?.apiUrl ?? '…'}</span>
          </li>
          <li>
            Key: <span className="mono">{config ? `${config.keyPreview}…` : '…'}</span> (stays on the server)
          </li>
          <li>
            Engines:{' '}
            {config?.engines
              ? Object.entries(config.engines)
                  .map(([name, on]) => `${name} ${on ? 'on' : 'off'}`)
                  .join(', ')
              : 'unknown'}
          </li>
        </ul>
      </section>

      <RunAllChecks config={config} file={file} onFile={setFile} onExchange={addToHistory} onId={setId} />

      <div className="tester-grid">
        <div className="cards">
          {CARDS.map((card) => (
            <ActionCard
              key={card.action}
              card={card}
              busy={Boolean(busy[card.action])}
              canSend={canSend(card.action)}
              result={results[card.action]}
              onSend={() => send(card.action)}
              onPickId={pickId}
            >
              {inputsFor(card.action)}
            </ActionCard>
          ))}
        </div>
        <aside className="history-col">
          <History items={history} onClear={() => setHistory([])} onPickId={pickId} />
        </aside>
      </div>
    </main>
  );
}
