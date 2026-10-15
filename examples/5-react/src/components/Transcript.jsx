// Transcript.jsx - audio player + timestamped lines.
// Click a timestamp to jump there. The line that is playing now is highlighted.
import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadSrt } from '../api.js';
import { countWords, formatTime } from '../format.js';
import { languageName } from '../languages.js';
import { AlertIcon, CheckIcon, CopyIcon, DownloadIcon } from './Icons.jsx';

/** Copies text; falls back to the old execCommand way when the Clipboard API is blocked. */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'sr-only';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

export default function Transcript({ job, audioUrl }) {
  const audioRef = useRef(null);
  const listRef = useRef(null);
  const [active, setActive] = useState(-1); // index of the line that is playing
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState(null);

  // Use the segments; if there are none, show the whole text as one line.
  const segments = useMemo(() => {
    if (job.segments?.length) return job.segments;
    return job.text ? [{ id: 0, start: 0, end: job.duration || 0, text: job.text }] : [];
  }, [job]);

  // Find the line for the current playback time (segments are sorted by start time).
  function syncActive() {
    const t = audioRef.current?.currentTime ?? 0;
    let index = -1;
    for (let i = 0; i < segments.length && segments[i].start <= t + 0.05; i++) index = i;
    setActive(index);
  }

  // Keep the playing line visible inside the list (only while playing, so we never fight the user's scrolling).
  useEffect(() => {
    const list = listRef.current;
    const line = list?.children[active];
    if (!line || audioRef.current?.paused) return;
    const above = line.offsetTop < list.scrollTop;
    const below = line.offsetTop + line.offsetHeight > list.scrollTop + list.clientHeight;
    if (above || below) {
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      list.scrollTo({ top: line.offsetTop - list.clientHeight / 3, behavior: smooth ? 'smooth' : 'auto' });
    }
  }, [active]);

  // "Copied" goes back to "Copy text" after 2 seconds.
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  function playFrom(segment, index) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = segment.start;
    setActive(index);
    audio.play().catch(() => {}); // play() can be refused (e.g. no user gesture) - seeking still worked
  }

  async function onCopy() {
    await copyToClipboard(job.text || '');
    setCopied(true);
  }

  async function onDownload() {
    setActionError(null);
    setDownloading(true);
    try {
      await downloadSrt(job.id);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setDownloading(false);
    }
  }

  const words = countWords(job.text);

  return (
    <section className="card transcript" aria-labelledby="transcript-title">
      <div className="card-head">
        <div>
          <h2 id="transcript-title" className="card-title">
            <span className="num">3</span>Transcript
          </h2>
          <p className="muted small file-name" title={job.filename}>
            {job.filename}
          </p>
        </div>
        <div className="tools">
          <button type="button" className="btn" onClick={onCopy} disabled={!job.text}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Copied' : 'Copy text'}
          </button>
          <button type="button" className={`btn${downloading ? ' busy' : ''}`} onClick={onDownload} disabled={downloading}>
            <DownloadIcon />
            Download SRT
          </button>
        </div>
      </div>

      <ul className="chips" aria-label="Details">
        {job.duration != null && <li>{formatTime(job.duration)}</li>}
        <li>{languageName(job.detected_language || job.language)}</li>
        <li>
          {words} {words === 1 ? 'word' : 'words'}
        </li>
        <li>
          {segments.length} {segments.length === 1 ? 'line' : 'lines'}
        </li>
      </ul>

      {actionError && (
        <p className="inline-error" role="alert">
          <AlertIcon /> {actionError}
        </p>
      )}

      {audioUrl ? (
        <audio
          ref={audioRef}
          className="player"
          controls
          preload="metadata"
          src={audioUrl}
          onTimeUpdate={syncActive}
          onSeeked={syncActive}
        />
      ) : (
        <p className="hint">The audio player needs the local file. Choose the file again to listen.</p>
      )}

      {segments.length === 0 ? (
        <p className="empty-text">No speech was found in this file.</p>
      ) : (
        <ol className="lines" ref={listRef}>
          {segments.map((segment, i) => (
            <li key={segment.id ?? i} className={i === active ? 'line is-active' : 'line'}>
              <button
                type="button"
                className="stamp"
                onClick={() => playFrom(segment, i)}
                disabled={!audioUrl}
                aria-label={`Play from ${formatTime(segment.start)}`}
              >
                {formatTime(segment.start)}
              </button>
              <p>{segment.text.trim()}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
