// RunAllChecks.jsx - one button that tests the whole API through the backend:
//   health -> list -> upload -> poll get until done -> format srt -> delete -> get again (must be 404)
// Every call is added to the history. While waiting, only the LAST poll is added (not 40 of them).
import { useEffect, useRef, useState } from 'react';
import { callTester } from '../api.js';
import { formatTime } from '../format.js';
import { LANGUAGES } from '../languages.js';
import FilePicker from './FilePicker.jsx';
import { AlertIcon, CheckIcon, CloseIcon, MinusIcon, PlayIcon, StopIcon } from '../components/Icons.jsx';

const STEPS = [
  ['health', 'Health', 'GET /api/v1/health answers ok'],
  ['list', 'List', 'GET /api/v1/transcriptions answers a list'],
  ['upload', 'Upload', 'POST /api/v1/transcriptions accepts the MP3'],
  ['wait', 'Wait for the result', 'GET /api/v1/transcriptions/{id} until completed'],
  ['srt', 'SRT file', 'GET /api/v1/transcriptions/{id}?format=srt'],
  ['delete', 'Delete', 'DELETE /api/v1/transcriptions/{id}'],
  ['gone', 'Really deleted', 'GET /api/v1/transcriptions/{id} now answers 404'],
];
const POLL_MS = 3000;
const MAX_WAIT_MS = 15 * 60_000;
const FINAL = new Set(['completed', 'failed']);

const freshResults = () => Object.fromEntries(STEPS.map(([key]) => [key, { state: 'pending', detail: '' }]));

/** A failed check. Thrown inside run() and caught at the end. */
class CheckFailed extends Error {}

/** "HTTP 404 not_found – Transcription not found" */
function describe(ex) {
  const { status, body } = ex.response;
  const err = body?.error;
  return err ? `HTTP ${status} ${err.code} – ${err.message}` : `HTTP ${status}`;
}

const STATE_ICON = { pass: CheckIcon, fail: CloseIcon, skip: MinusIcon };

export default function RunAllChecks({ config, file, onFile, onExchange, onId }) {
  const [engine, setEngine] = useState('worker');
  const [language, setLanguage] = useState('auto');
  const [results, setResults] = useState(freshResults);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState(null); // { passed, failed, skipped, seconds, note }
  const [pickError, setPickError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!config) return;
    setEngine(config.defaultEngine === 'cloud' ? 'cloud' : 'worker');
    if (LANGUAGES.some(([code]) => code === config.defaultLanguage)) setLanguage(config.defaultLanguage);
  }, [config]);

  // Stop polling when the page is closed.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function run() {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const startedAt = Date.now();
    const local = freshResults(); // the same results as the state, so we can count them at the end
    const set = (key, state, detail = '') => {
      local[key] = { state, detail };
      setResults({ ...local });
    };
    const fail = (key, detail) => {
      set(key, 'fail', detail);
      throw new CheckFailed(detail);
    };
    const call = async (action, input, { record = true } = {}) => {
      const ex = await callTester(action, input, ctrl.signal);
      if (record) onExchange(ex);
      return ex;
    };
    const sleep = (ms) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        ctrl.signal.addEventListener('abort', () => (clearTimeout(timer), reject(new DOMException('Stopped', 'AbortError'))), { once: true });
      });

    setRunning(true);
    setSummary(null);
    setResults({ ...local });
    let id = null;
    let deleted = false;
    let note = '';

    async function deleteJob() {
      set('delete', 'running');
      const ex = await call('delete', { id });
      if (ex.response.status !== 200 || ex.response.body?.deleted !== true) fail('delete', describe(ex));
      deleted = true;
      set('delete', 'pass', `${id} deleted`);
    }

    try {
      // 1. Health (no key needed)
      set('health', 'running');
      let ex = await call('health');
      const health = ex.response.body;
      if (ex.response.status !== 200 || health?.ok !== true) fail('health', describe(ex));
      const engines = Object.entries(health.engines || {}).map(([name, on]) => `${name} ${on ? 'on' : 'off'}`);
      set('health', 'pass', `ok · version ${health.version} · ${engines.join(', ')}`);

      // 2. List (checks the API key)
      set('list', 'running');
      ex = await call('list', { limit: '5' });
      if (ex.response.status !== 200 || ex.response.body?.object !== 'list') fail('list', describe(ex));
      set('list', 'pass', `${ex.response.body.total} transcriptions in this project`);

      // 3. Upload
      set('upload', 'running', `${file.name} · engine=${engine}`);
      const form = new FormData();
      form.append('file', file);
      form.append('engine', engine);
      form.append('language', language);
      if (engine === 'cloud') form.append('wait', 'true'); // cloud: the answer already has the text
      ex = await call('upload', form);
      const created = ex.response.body;
      if (![200, 202].includes(ex.response.status) || !created?.id) fail('upload', describe(ex));
      id = created.id;
      onId(id);
      set('upload', 'pass', `HTTP ${ex.response.status} · ${id} · ${created.status}`);

      // 4. Poll until completed or failed. The first GET runs at once, then every 3 seconds.
      set('wait', 'running', created.status);
      const waitStart = Date.now();
      let job = created;
      let polls = 0;
      let problems = 0;
      let lastPoll = null;
      do {
        if (polls > 0) await sleep(POLL_MS);
        if (Date.now() - waitStart > MAX_WAIT_MS) fail('wait', `Still "${job.status}" after 15 minutes. Is the worker running?`);
        const poll = await call('get', { id }, { record: false });
        polls++;
        lastPoll = poll;
        if (poll.response.status !== 200) {
          const permanent = poll.response.status >= 400 && poll.response.status < 500;
          if (permanent || ++problems >= 5) {
            onExchange(poll);
            fail('wait', describe(poll));
          }
          continue;
        }
        problems = 0;
        job = poll.response.body;
        const progress = job.status === 'processing' && job.progress != null ? ` ${job.progress}%` : '';
        set('wait', 'running', `${job.status}${progress} · ${formatTime((Date.now() - waitStart) / 1000)} · ${polls} ${polls === 1 ? 'poll' : 'polls'}`);
      } while (!FINAL.has(job.status));
      onExchange(lastPoll); // only the final poll goes to the history
      if (job.status !== 'completed') fail('wait', `The job failed: ${job.error || 'no reason given'}`);
      const words = job.text ? job.text.trim().split(/\s+/).length : 0;
      set('wait', 'pass', `completed in ${formatTime((Date.now() - waitStart) / 1000)} · ${polls} polls · ${job.segments?.length ?? 0} segments · ${words} words`);

      // 5. SRT download
      set('srt', 'running');
      ex = await call('format', { id, format: 'srt' });
      const srt = ex.response.body;
      if (ex.response.status !== 200 || typeof srt !== 'string' || !srt.includes('-->')) fail('srt', describe(ex));
      set('srt', 'pass', `${srt.split('-->').length - 1} subtitle cues · ${ex.response.headers['content-type'] || ''}`);

      // 6. Delete
      await deleteJob();

      // 7. Get again: must be 404 now
      set('gone', 'running');
      ex = await call('get', { id });
      if (ex.response.status !== 404) fail('gone', `Expected 404, got ${describe(ex)}`);
      set('gone', 'pass', '404 not_found, as expected');
    } catch (err) {
      const stopped = err.name === 'AbortError';
      for (const [key] of STEPS) {
        const s = local[key].state;
        if (s === 'running') set(key, stopped ? 'skip' : 'fail', stopped ? 'Stopped' : local[key].detail);
        else if (s === 'pending') set(key, 'skip', '');
      }
      if (!stopped && !(err instanceof CheckFailed)) console.error(err); // a bug in this page, not an API problem
      // Clean up: a failed run should not leave a test job behind (unless you pressed Stop).
      if (id && !deleted && !stopped) {
        try {
          await deleteJob();
        } catch {
          /* the delete step shows the problem */
        }
      }
      if (id && !deleted) note = `${id} was not deleted. Use the Delete card if you do not need it.`;
    } finally {
      const count = (state) => Object.values(local).filter((r) => r.state === state).length;
      setSummary({ passed: count('pass'), failed: count('fail'), skipped: count('skip'), seconds: (Date.now() - startedAt) / 1000, note });
      setRunning(false);
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }

  const allPassed = summary && summary.failed === 0 && summary.skipped === 0;

  return (
    <section className="card run-all" aria-labelledby="run-all-title">
      <div className="card-head">
        <div>
          <h2 id="run-all-title" className="card-title">
            Run all checks
          </h2>
          <p className="muted small">Uploads the file, waits for the worker, downloads the SRT, then deletes the test job again.</p>
        </div>
        {running ? (
          <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
            <StopIcon />
            Stop
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={run} disabled={!file}>
            <PlayIcon />
            Run all checks
          </button>
        )}
      </div>

      <div className="run-inputs">
        <div className="field grow-2">
          <span>MP3 file</span>
          <FilePicker file={file} onFile={(f) => (setPickError(null), onFile(f))} disabled={running} onError={setPickError} />
        </div>
        <label className="field">
          <span>Engine</span>
          <select value={engine} onChange={(e) => setEngine(e.target.value)} disabled={running}>
            <option value="worker">worker – polls until done</option>
            <option value="cloud">cloud + wait – needs cloud key on server</option>
          </select>
        </label>
        <label className="field">
          <span>Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={running}>
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {pickError && (
        <p className="inline-error" role="alert">
          <AlertIcon /> {pickError}
        </p>
      )}
      {!file && <p className="hint">Choose an MP3 or click “Use sample” to enable the button.</p>}

      <ol className="checklist">
        {STEPS.map(([key, label, what], i) => {
          const { state, detail } = results[key];
          const Icon = STATE_ICON[state];
          return (
            <li key={key} className={`check is-${state}`}>
              <span className="check-mark" aria-hidden="true">
                {Icon ? <Icon /> : state === 'running' ? <span className="spinner" /> : i + 1}
              </span>
              <span className="check-text">
                <strong>{label}</strong>
                <code>{what}</code>
                {detail && <span className="check-detail">{detail}</span>}
              </span>
              <span className={`check-state is-${state}`}>
                {{ pending: '', running: 'running', pass: 'PASS', fail: 'FAIL', skip: 'skipped' }[state]}
              </span>
            </li>
          );
        })}
      </ol>

      {summary && (
        <div className={`run-summary ${allPassed ? 'is-ok' : summary.failed ? 'is-err' : 'is-warn'}`} role="status">
          <strong>
            {allPassed
              ? `All ${summary.passed} checks passed`
              : `${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped`}
          </strong>
          <span> in {formatTime(summary.seconds)}</span>
          {summary.note && <p>{summary.note}</p>}
        </div>
      )}
    </section>
  );
}
