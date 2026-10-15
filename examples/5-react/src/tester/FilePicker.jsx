// FilePicker.jsx - compact "choose an MP3" control with a "Use sample" shortcut.
import { useState } from 'react';
import { getSampleFile } from '../api.js';
import { formatBytes } from '../format.js';
import { MusicIcon } from '../components/Icons.jsx';

export default function FilePicker({ file, onFile, disabled, onError }) {
  const [loading, setLoading] = useState(false);

  async function loadSample() {
    setLoading(true);
    try {
      onFile(await getSampleFile());
    } catch (err) {
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`file-picker${disabled ? ' is-disabled' : ''}`}>
      <span className="fp-icon">
        <MusicIcon />
      </span>
      <span className="fp-name" title={file?.name}>
        {file ? (
          <>
            <strong>{file.name}</strong> <small>{formatBytes(file.size)}</small>
          </>
        ) : (
          <span className="muted">No file chosen</span>
        )}
      </span>
      <label className={`btn small${disabled ? ' is-disabled' : ''}`}>
        Choose…
        <input
          type="file"
          accept=".mp3,audio/mpeg"
          className="sr-only"
          disabled={disabled}
          onChange={(e) => {
            if (e.target.files?.[0]) onFile(e.target.files[0]);
            e.target.value = '';
          }}
        />
      </label>
      <button type="button" className={`btn small${loading ? ' busy' : ''}`} onClick={loadSample} disabled={disabled || loading}>
        Use sample
      </button>
    </div>
  );
}
