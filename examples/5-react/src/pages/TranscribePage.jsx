// TranscribePage.jsx - the whole flow:
//   1. choose an MP3 + engine + language
//   2. upload it to OUR backend (POST /api/transcribe)
//   3. poll GET /api/transcriptions/:id every 2 s until "completed" or "failed"
//   4. show the transcript next to an audio player of the local file
import { useEffect, useRef, useState } from 'react';
import { getSampleFile, getTranscription, uploadAudio } from '../api.js';
import { LANGUAGES } from '../languages.js';
import DropZone from '../components/DropZone.jsx';
import JobStatus from '../components/JobStatus.jsx';
import Transcript from '../components/Transcript.jsx';
import { AlertIcon, CloseIcon, MusicIcon, UploadIcon, WaveIcon } from '../components/Icons.jsx';

const POLL_MS = 2000;
const FINAL = new Set(['completed', 'failed']);
const MAX_POLL_FAILURES = 5; // network hiccups we accept before giving up

// Extra help for the most common error codes.
const HINTS = {
  network_error: 'Start the demo with start.bat or "npm run dev".',
  api_unreachable: 'Start the Transcribe API server, then try again.',
  invalid_api_key: 'Check TRANSCRIBE_API_KEY in the .env file in the demo folder.',
  unauthorized: 'Check TRANSCRIBE_API_KEY in the .env file in the demo folder.',
  engine_unavailable: 'Choose "Worker", or add a cloud API key in the server config.',
  file_too_large: 'Use a smaller file. For big files use the worker engine.',
  unsupported_file_type: 'Only MP3 files are allowed.',
  rate_limited: 'Too many requests. Wait a moment, then try again.',
};

export default function TranscribePage({ config }) {
  const [file, setFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null); // object URL of the LOCAL file, for the player
  const [duration, setDuration] = useState(null);
  const [engine, setEngine] = useState('worker');
  const [language, setLanguage] = useState('auto');
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [startedAt, setStartedAt] = useState(null);
  const [job, setJob] = useState(null); // the transcription object from the API
  const [error, setError] = useState(null); // { message, code?, status? }
  const [loadingSample, setLoadingSample] = useState(false);
  const uploadAbort = useRef(null);

  const phase = uploading ? 'uploading' : job?.status ?? 'idle';
  const busy = phase === 'uploading' || phase === 'queued' || phase === 'processing';

  // 1. Use the defaults (engine, language) that the backend reads from .env.
  useEffect(() => {
    if (!config) return;
    setEngine(config.defaultEngine === 'cloud' ? 'cloud' : 'worker');
    setLanguage(config.defaultLanguage || 'auto');
  }, [config]);

  // 2. Make a local URL for the chosen file (for the <audio> player) and read its duration.
  useEffect(() => {
    if (!file) {
      setAudioUrl(null);
      setDuration(null);
      return undefined;
    }
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => setDuration(probe.duration);
    probe.src = url;
    setAudioUrl(url);
    return () => {
      probe.onloadedmetadata = null;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // 3. Poll the job until it is completed or failed.
  const jobId = job?.id;
  const jobFinished = job ? FINAL.has(job.status) : false;
  useEffect(() => {
    if (!jobId || jobFinished) return undefined;
    const ctrl = new AbortController();
    let timer;
    let failures = 0;

    async function poll() {
      try {
        const latest = await getTranscription(jobId, ctrl.signal);
        if (ctrl.signal.aborted) return;
        failures = 0;
        setJob(latest);
        if (FINAL.has(latest.status)) return; // done - stop polling
      } catch (err) {
        if (err.name === 'AbortError') return;
        // A 4xx answer (e.g. the job was deleted) will not fix itself. Network problems might.
        const permanent = err.status >= 400 && err.status < 500 && err.status !== 429;
        if (permanent || ++failures >= MAX_POLL_FAILURES) {
          setError(err);
          return;
        }
      }
      timer = setTimeout(poll, POLL_MS);
    }

    timer = setTimeout(poll, POLL_MS);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [jobId, jobFinished]);

  function chooseFile(newFile) {
    setFile(newFile);
    setJob(null);
    setError(null);
  }

  async function loadSample() {
    setLoadingSample(true);
    try {
      chooseFile(await getSampleFile());
    } catch (err) {
      setError(err);
    } finally {
      setLoadingSample(false);
    }
  }

  async function startUpload() {
    if (!file || busy) return;
    const ctrl = new AbortController();
    uploadAbort.current = ctrl;
    setError(null);
    setJob(null);
    setUploadPct(0);
    setStartedAt(Date.now());
    setUploading(true);
    try {
      const created = await uploadAudio(file, { engine, language }, { onProgress: setUploadPct, signal: ctrl.signal });
      setJob(created); // "queued" (worker) or already "completed" (cloud + wait)
    } catch (err) {
      if (err.name !== 'AbortError') setError(err);
    } finally {
      if (uploadAbort.current === ctrl) {
        uploadAbort.current = null;
        setUploading(false);
      }
    }
  }

  function startOver() {
    uploadAbort.current?.abort();
    uploadAbort.current = null;
    setUploading(false);
    setJob(null);
    setError(null);
    setFile(null);
  }

  // Show the .env default language even if it is not in our short list.
  const languages = LANGUAGES.some(([code]) => code === language) ? LANGUAGES : [...LANGUAGES, [language, language.toUpperCase()]];
  const cloudOff = config?.engines?.cloud === false;
  const workerOff = config?.engines?.worker === false;

  return (
    <main className="layout">
      <div className="col">
        <section className="card" aria-labelledby="choose-title">
          <h2 id="choose-title" className="card-title">
            <span className="num">1</span>Choose audio
          </h2>

          <DropZone
            file={file}
            duration={duration}
            disabled={busy}
            maxMb={config?.maxUploadMb ?? 100}
            onFile={chooseFile}
            onReject={(message, code) => setError({ message, code })}
          />
          {!file && (
            <button type="button" className={`btn ghost sample-btn${loadingSample ? ' busy' : ''}`} onClick={loadSample} disabled={loadingSample}>
              <MusicIcon />
              No MP3 at hand? Use the sample clip
            </button>
          )}

          <div className="fields">
            <label className="field">
              <span>Engine</span>
              <select value={engine} onChange={(e) => setEngine(e.target.value)} disabled={busy}>
                <option value="worker">Worker – Whisper on your PC{workerOff ? ' (off)' : ''}</option>
                <option value="cloud">Cloud – needs cloud key on server</option>
              </select>
            </label>
            <label className="field">
              <span>Language</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy}>
                {languages.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="hint">
            {engine === 'worker'
              ? 'The job waits in a queue. This page checks the status every 2 seconds.'
              : cloudOff
                ? 'The cloud engine is not set up on this server. The upload will fail with "engine_unavailable".'
                : 'The server answers when the text is ready (wait=true).'}
          </p>

          <div className="actions">
            <button type="button" className={`btn primary${busy ? ' busy' : ''}`} onClick={startUpload} disabled={!file || busy}>
              <UploadIcon />
              {busy ? 'Working…' : job ? 'Transcribe again' : 'Upload & transcribe'}
            </button>
            {(file || job) && (
              <button type="button" className="btn ghost" onClick={startOver}>
                {phase === 'uploading' ? 'Cancel' : 'Start over'}
              </button>
            )}
          </div>
        </section>

        {error && (
          <div className="alert" role="alert">
            <AlertIcon />
            <div className="grow">
              <strong>{error.message}</strong>
              {(HINTS[error.code] || error.status) && (
                <p>
                  {HINTS[error.code]}
                  {error.status ? <span className="muted mono"> (HTTP {error.status} · {error.code})</span> : null}
                </p>
              )}
            </div>
            <button type="button" className="icon-btn" onClick={() => setError(null)} aria-label="Close message">
              <CloseIcon />
            </button>
          </div>
        )}

        {phase !== 'idle' && (
          <section className="card" aria-labelledby="status-title">
            <h2 id="status-title" className="card-title">
              <span className="num">2</span>Status
            </h2>
            <JobStatus phase={phase} engine={job?.engine ?? engine} uploadPct={uploadPct} job={job} startedAt={startedAt} />
          </section>
        )}
      </div>

      <div className="col col-wide">
        {job?.status === 'completed' ? (
          <Transcript key={job.id} job={job} audioUrl={audioUrl} />
        ) : (
          <section className={`card placeholder${busy ? ' is-busy' : ''}`} aria-live="polite">
            {busy ? (
              <>
                <div className="skeleton" aria-hidden="true">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <span key={n} className="skel-line" />
                  ))}
                </div>
                <p className="muted">The transcript appears here when the job is done.</p>
              </>
            ) : (
              <>
                <span className="placeholder-icon">
                  <WaveIcon />
                </span>
                <h2>Your transcript appears here</h2>
                <ol className="how">
                  <li>Choose an MP3 file.</li>
                  <li>Click “Upload &amp; transcribe”.</li>
                  <li>Click a timestamp to listen from there.</li>
                </ol>
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
