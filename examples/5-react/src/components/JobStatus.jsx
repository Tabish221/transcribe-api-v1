// JobStatus.jsx - the steps (Upload -> Queue -> Transcribe -> Done), a progress bar and a timer.
import { useEffect, useState } from 'react';
import { formatTime, secondsBetween } from '../format.js';
import { AlertIcon, CheckIcon } from './Icons.jsx';

const STEPS = [
  ['uploading', 'Upload'],
  ['queued', 'Queue'],
  ['processing', 'Transcribe'],
  ['completed', 'Done'],
];

/** Re-renders every second while `active` is true (for the timer). */
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Text + percent for the progress bar. percent = null means "we do not know yet" (moving stripes). */
function describe(phase, engine, uploadPct, job) {
  switch (phase) {
    case 'uploading':
      if (uploadPct < 100) return { label: `Uploading… ${uploadPct}%`, percent: uploadPct };
      return { label: engine === 'cloud' ? 'Transcribing in the cloud…' : 'Saving on the server…', percent: null };
    case 'queued':
      return { label: 'In the queue, waiting for the worker…', percent: null };
    case 'processing': {
      const p = job?.progress;
      return p == null ? { label: 'Transcribing…', percent: null } : { label: `Transcribing… ${p}%`, percent: p };
    }
    case 'completed':
      return { label: 'Done', percent: 100 };
    default:
      return { label: 'Failed', percent: null };
  }
}

export default function JobStatus({ phase, engine, uploadPct, job, startedAt }) {
  const active = phase === 'uploading' || phase === 'queued' || phase === 'processing';
  const now = useNow(active);
  const failed = phase === 'failed';

  // Which step are we on? A failed job stops at the step it reached.
  const current = failed ? (job?.started_at ? 2 : 1) : STEPS.findIndex(([key]) => key === phase);
  const { label, percent } = describe(phase, engine, uploadPct, job);
  const elapsed = active && startedAt ? formatTime((now - startedAt) / 1000) : null;
  const took = phase === 'completed' ? secondsBetween(job?.created_at, job?.completed_at) : null;

  return (
    <div className="status">
      <ol className="steps">
        {STEPS.map(([key, text], i) => {
          let state = '';
          if (failed && i === current) state = 'is-failed';
          else if (i < current || phase === 'completed') state = 'is-done';
          else if (i === current) state = 'is-current';
          return (
            <li key={key} className={`step ${state}`} aria-current={i === current ? 'step' : undefined}>
              <span className="dot">{state === 'is-done' ? <CheckIcon /> : state === 'is-failed' ? '!' : i + 1}</span>
              <span className="step-label">{text}</span>
            </li>
          );
        })}
      </ol>

      {failed ? (
        <div className="alert" role="alert">
          <AlertIcon />
          <div>
            <strong>The transcription failed</strong>
            <p>{job?.error || 'No reason was given.'}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="status-line" aria-live="polite">
            <strong>{label}</strong>
            {elapsed && <span className="muted mono">{elapsed}</span>}
            {took != null && <span className="muted">in {formatTime(took)}</span>}
          </div>
          <div
            className={`bar${percent == null ? ' is-indeterminate' : ''}${phase === 'completed' ? ' is-done' : ''}`}
            role="progressbar"
            aria-label="Progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <span className="bar-fill" style={percent == null ? undefined : { width: `${percent}%` }} />
          </div>
        </>
      )}

      {phase === 'queued' && engine === 'worker' && (
        <p className="hint">The worker on your PC does one job at a time. A 40 s clip takes about 1–3 minutes.</p>
      )}

      {job?.id && (
        <dl className="meta">
          <div>
            <dt>ID</dt>
            <dd className="mono">{job.id}</dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>{job.engine}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
