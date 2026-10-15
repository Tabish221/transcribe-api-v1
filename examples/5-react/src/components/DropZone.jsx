// DropZone.jsx - drag & drop an MP3, or click to choose one.
import { useState } from 'react';
import { formatBytes, formatTime } from '../format.js';
import { MusicIcon, UploadIcon } from './Icons.jsx';

export default function DropZone({ file, duration, disabled, maxMb, onFile, onReject }) {
  const [dragging, setDragging] = useState(false);

  function pick(files) {
    const chosen = files?.[0];
    if (!chosen) return;
    // The API accepts MP3 only (server setting "allowed_extensions"), so check early for a friendly message.
    if (!/\.mp3$/i.test(chosen.name)) return onReject(`"${chosen.name}" is not an MP3 file. Please choose an .mp3 file.`, 'unsupported_file_type');
    if (chosen.size > maxMb * 1024 * 1024) return onReject(`This file is ${formatBytes(chosen.size)}. The limit is ${maxMb} MB.`, 'file_too_large');
    onFile(chosen);
  }

  const className = ['drop', dragging && 'is-dragging', file && 'has-file', disabled && 'is-disabled'].filter(Boolean).join(' ');

  return (
    <label
      className={className}
      onDragEnter={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled) pick(e.dataTransfer.files);
      }}
    >
      <input
        type="file"
        accept=".mp3,audio/mpeg"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = ''; // so choosing the same file again still works
        }}
      />

      {file ? (
        <span className="file-row">
          <span className="file-icon">
            <MusicIcon />
          </span>
          <span className="file-info">
            <strong title={file.name}>{file.name}</strong>
            <small>
              {formatBytes(file.size)}
              {duration ? ` · ${formatTime(duration)}` : ''}
            </small>
          </span>
          {!disabled && <span className="link">Change</span>}
        </span>
      ) : (
        <span className="drop-empty">
          <span className="drop-icon">
            <UploadIcon />
          </span>
          <strong>{dragging ? 'Drop it!' : 'Drop an MP3 here'}</strong>
          <span>
            or <span className="link">choose a file</span>
          </span>
          <small>MP3 · up to {maxMb} MB</small>
        </span>
      )}
    </label>
  );
}
