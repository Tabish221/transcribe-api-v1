// History.jsx - every call made on the tester page, newest first. Click a row to see the details.
import Exchange from './Exchange.jsx';
import { MethodBadge, StatusBadge } from './Badges.jsx';

/** "http://127.0.0.1:8088/api/v1/transcriptions?limit=5" -> "/api/v1/transcriptions?limit=5" */
function shortPath(url) {
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export default function History({ items, onClear, onPickId }) {
  return (
    <section className="card history" aria-labelledby="history-title">
      <div className="card-head">
        <h2 id="history-title" className="card-title">
          History <span className="count">{items.length}</span>
        </h2>
        {items.length > 0 && (
          <button type="button" className="btn ghost small" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="muted small">Your calls appear here, newest first. Click one to see the request and the response.</p>
      ) : (
        <ol className="history-list">
          {items.map((item) => (
            <li key={item.n}>
              <details>
                <summary>
                  <MethodBadge method={item.request.method} />
                  <span className="h-path" title={item.request.url}>
                    {shortPath(item.request.url)}
                  </span>
                  <StatusBadge status={item.response.status} compact />
                  <span className="h-meta">
                    {item.duration_ms} ms · {item.at.toLocaleTimeString()}
                  </span>
                </summary>
                <Exchange exchange={item} onPickId={onPickId} />
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
