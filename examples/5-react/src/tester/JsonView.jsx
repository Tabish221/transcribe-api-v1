// JsonView.jsx - pretty JSON with simple colors. Plain text (e.g. an SRT file) is shown as it is.
// Transcription ids ("tr_...") become buttons: click one to use it in the Get / Format / Delete cards.
import { useMemo } from 'react';

// Matches JSON strings (with an optional ":" after keys), true/false/null and numbers.
const TOKEN = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const ID = /^"(tr_[0-9a-f]{24})"$/;

function highlight(text, onPickId) {
  const parts = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    let cls = 'j-num';
    if (token[0] === '"') cls = token.endsWith(':') ? 'j-key' : 'j-str';
    else if (token === 'true' || token === 'false') cls = 'j-bool';
    else if (token === 'null') cls = 'j-null';

    const id = cls === 'j-str' && onPickId ? token.match(ID)?.[1] : null;
    parts.push(
      id ? (
        // A <span role="button"> (not a <button>) so it wraps like normal text inside the JSON.
        <span
          key={n++}
          role="button"
          tabIndex={0}
          className="j-str j-id"
          title="Use this id in Get, Format and Delete"
          onClick={() => onPickId(id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onPickId(id);
            }
          }}
        >
          {token}
        </span>
      ) : (
        <span key={n++} className={cls}>
          {token}
        </span>
      ),
    );
    last = match.index + token.length;
  }
  parts.push(text.slice(last));
  return parts;
}

export default function JsonView({ value, onPickId }) {
  const content = useMemo(() => {
    if (typeof value === 'string') return value === '' ? '(empty body)' : value;
    return highlight(JSON.stringify(value, null, 2) ?? 'undefined', onPickId);
  }, [value, onPickId]);
  return <pre className={`code${typeof value === 'string' ? ' is-text' : ''}`}>{content}</pre>;
}
