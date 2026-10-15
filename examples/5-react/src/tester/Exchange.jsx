// Exchange.jsx - one call: the request (left) and the response (right).
// On narrow cards the two panes stack (CSS container query).
import JsonView from './JsonView.jsx';
import { MethodBadge, StatusBadge } from './Badges.jsx';

function KeyValues({ data }) {
  const entries = Object.entries(data || {}).filter(([, v]) => v != null);
  if (entries.length === 0) return null;
  return (
    <dl className="kv">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function Exchange({ exchange, onPickId }) {
  const { request, response, duration_ms: ms, source } = exchange;
  const hasFields = request.fields && Object.keys(request.fields).length > 0;

  return (
    <div className="exchange">
      <div className="exchange-grid">
        <section className="pane" aria-label="Request">
          <header className="pane-head">
            <span className="pane-title">Request</span>
            {source === 'backend' && <span className="tag">to the demo backend only</span>}
          </header>
          <p className="req-line">
            <MethodBadge method={request.method} />
            <code className="url">{request.url}</code>
          </p>
          <KeyValues data={request.headers} />
          {hasFields && (
            <>
              <h4 className="pane-sub">Fields</h4>
              <JsonView value={request.fields} />
            </>
          )}
        </section>

        <section className="pane" aria-label="Response">
          <header className="pane-head">
            <span className="pane-title">Response</span>
            <StatusBadge status={response.status} />
            <span className="ms">{ms} ms</span>
          </header>
          <KeyValues data={response.headers} />
          <h4 className="pane-sub">Body{response.truncated ? ' (cut for display)' : ''}</h4>
          <JsonView value={response.body} onPickId={onPickId} />
          {exchange.backend && (
            <>
              <h4 className="pane-sub">Added by the demo backend (not from the API)</h4>
              <JsonView value={exchange.backend} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
