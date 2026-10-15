@extends('layouts.main')

@section('title', 'Backend tester')

@section('content')
<div id="tester-root" data-max-bytes="{{ $maxBytes }}" data-max-human="{{ $maxHuman }}">
    <section class="card">
        <h1>Backend tester</h1>
        <p class="muted">Each <b>Send</b> button asks Laravel to call the Transcribe API. You see the request
            (the key is masked) and the answer side by side. The key never goes to the browser.</p>
        <dl class="facts">
            <dt>API URL</dt><dd>{{ $baseUrl ?: 'not set (TRANSCRIBE_API_URL)' }}</dd>
            <dt>API key</dt><dd>{{ $maskedKey }}</dd>
            <dt>Webhook URL</dt><dd>{{ $webhookUrl }}</dd>
            <dt>Webhook secret</dt><dd>{{ $maskedSecret }}</dd>
        </dl>
    </section>

    <section class="card" aria-labelledby="ra-title">
        <div class="card-head">
            <h2 id="ra-title">Run all checks</h2>
            <button type="button" id="ra-run" class="btn primary">Run all checks</button>
        </div>
        <p class="muted small">health → list → upload → wait until done → SRT → webhook → delete.
            The worker needs about 1 minute for a 40 second clip.</p>
        <div class="row">
            <label class="field">MP3 file for the test
                <input type="file" id="ra-file" accept=".mp3,audio/mpeg">
            </label>
            <label class="field">Engine
                <select id="ra-engine">
                    <option value="worker" @selected($engine === 'worker')>worker</option>
                    <option value="cloud" @selected($engine === 'cloud')>cloud</option>
                </select>
            </label>
            <label class="check"><input type="checkbox" id="ra-delete" checked> Delete the test job at the end</label>
        </div>
        <ol id="ra-list" class="checklist" hidden></ol>
        <p id="ra-summary" class="summary" role="status" aria-live="polite"></p>
    </section>

    <div class="tester-grid">
        <div>
            {{-- One card per action. The form fields are sent to POST /tester-api/{action}. --}}
            <form class="card action-card" data-action="health">
                <div class="card-head">
                    <h3 class="endpoint"><span class="method get">GET</span>/api/v1/health</h3>
                    <button type="submit" class="btn primary">Send</button>
                </div>
                <p class="muted small">Is the API up? Which engines are on? (No key needed.)</p>
                <div class="result" hidden></div>
            </form>

            <form class="card action-card" data-action="list">
                <div class="card-head">
                    <h3 class="endpoint"><span class="method get">GET</span>/api/v1/transcriptions</h3>
                    <button type="submit" class="btn primary">Send</button>
                </div>
                <p class="muted small">The newest jobs of this API key's project.</p>
                <div class="fields">
                    <label class="field">Status
                        <select name="status">
                            <option value="">any</option>
                            <option>queued</option><option>processing</option><option>completed</option><option>failed</option>
                        </select>
                    </label>
                    <label class="field">Limit
                        <input type="number" name="limit" value="10" min="1" max="100">
                    </label>
                </div>
                <div class="result" hidden></div>
            </form>

            <form class="card action-card" data-action="upload">
                <div class="card-head">
                    <h3 class="endpoint"><span class="method post">POST</span>/api/v1/transcriptions</h3>
                    <button type="submit" class="btn primary">Send</button>
                </div>
                <p class="muted small">Upload a file (multipart). The answer is the new job with status "queued".</p>
                <div class="fields">
                    <label class="field wide">File (max {{ $maxHuman }})
                        <input type="file" name="file" accept=".mp3,audio/mpeg" required>
                    </label>
                    <label class="field">Engine
                        <select name="engine">
                            <option value="worker" @selected($engine === 'worker')>worker</option>
                            <option value="cloud" @selected($engine === 'cloud')>cloud</option>
                            <option value="">(project default)</option>
                        </select>
                    </label>
                    <label class="field">Language
                        <input type="text" name="language" value="{{ $language }}" placeholder="en, auto or empty" maxlength="16">
                    </label>
                    <label class="field">Task
                        <select name="task">
                            <option value="transcribe">transcribe</option>
                            <option value="translate">translate (to English)</option>
                        </select>
                    </label>
                    <label class="field wide">Prompt (cloud only, optional)
                        <input type="text" name="prompt" maxlength="1000" placeholder="Names or words to spell right">
                    </label>
                    <label class="field wide">Metadata (JSON object, optional)
                        <input type="text" name="metadata" maxlength="4096" placeholder='{"order_id": 123}'>
                    </label>
                    <label class="check"><input type="checkbox" name="webhook" value="1" checked> Send webhook to this app</label>
                    <label class="check"><input type="checkbox" name="wait" value="1"> wait=true (cloud only)</label>
                </div>
                <div class="result" hidden></div>
            </form>

            <form class="card action-card" data-action="get">
                <div class="card-head">
                    <h3 class="endpoint"><span class="method get">GET</span>/api/v1/transcriptions/{id}</h3>
                    <button type="submit" class="btn primary">Send</button>
                </div>
                <p class="muted small">Status, progress, text and segments of one job.</p>
                <div class="fields">
                    <label class="field wide">ID <input type="text" name="id" class="id-input" placeholder="tr_..." required maxlength="64"></label>
                </div>
                <div class="result" hidden></div>
            </form>

            <form class="card action-card" data-action="format">
                <div class="card-head">
                    <h3 class="endpoint"><span class="method get">GET</span>/api/v1/transcriptions/{id}?format=</h3>
                    <button type="submit" class="btn primary">Send</button>
                </div>
                <p class="muted small">The transcript as a file. Answer 409 "not_ready" until the job is completed.</p>
                <div class="fields">
                    <label class="field">ID <input type="text" name="id" class="id-input" placeholder="tr_..." required maxlength="64"></label>
                    <label class="field">Format
                        <select name="format">
                            <option>srt</option><option>vtt</option><option>txt</option><option>json</option>
                        </select>
                    </label>
                </div>
                <div class="result" hidden></div>
            </form>

            <form class="card action-card" data-action="delete">
                <div class="card-head">
                    <h3 class="endpoint"><span class="method delete">DELETE</span>/api/v1/transcriptions/{id}</h3>
                    <button type="submit" class="btn primary">Send</button>
                </div>
                <p class="muted small">Deletes the job and its audio on the API. This cannot be undone.</p>
                <div class="fields">
                    <label class="field wide">ID <input type="text" name="id" class="id-input" placeholder="tr_..." required maxlength="64"></label>
                </div>
                <div class="result" hidden></div>
            </form>

            <form class="card action-card" data-action="webhook-simulate">
                <div class="card-head">
                    <h3 class="endpoint"><span class="method post">POST</span>/webhooks/transcribe (this app)</h3>
                </div>
                <p class="muted small">A fake "transcription.completed" webhook. Valid = signed with your webhook secret
                    (answer 200). Forged = signed with a wrong secret (answer 401). Sent via: {{ $simulateVia }}.</p>
                <div class="toolbar">
                    <button type="submit" name="mode" value="valid" class="btn primary">Simulate valid webhook</button>
                    <button type="submit" name="mode" value="forged" class="btn danger">Simulate forged webhook</button>
                </div>
                <div class="result" hidden></div>
            </form>
        </div>

        <aside class="tester-side">
            <section class="card" aria-labelledby="wh-title">
                <div class="card-head">
                    <h2 id="wh-title">Webhooks received</h2>
                    <span class="muted small" id="wh-updated"></span>
                </div>
                <div class="toolbar">
                    <button type="button" class="btn sm" data-simulate="valid">Simulate valid webhook</button>
                    <button type="button" class="btn sm danger" data-simulate="forged">Simulate forged webhook</button>
                </div>
                <div class="table-wrap">
                    <table class="log">
                        <thead><tr><th>Time</th><th>Event</th><th>Remote id</th><th>Sig.</th><th>Status</th></tr></thead>
                        <tbody id="wh-body"></tbody>
                    </table>
                </div>
                <p id="wh-empty" class="empty small">No webhooks yet. They appear here every 3 seconds.</p>
            </section>

            <section class="card" aria-labelledby="hist-title">
                <div class="card-head">
                    <h2 id="hist-title">History</h2>
                    <button type="button" id="hist-clear" class="btn sm">Clear</button>
                </div>
                <p class="muted small">Last calls in this browser tab. Click one to see it again.</p>
                <ul id="hist" class="history"></ul>
                <p id="hist-empty" class="empty small">No calls yet.</p>
            </section>
        </aside>
    </div>
</div>
@endsection

@push('scripts')
    <script src="{{ asset('js/tester.js') . '?v=' . (@filemtime(public_path('js/tester.js')) ?: '1') }}"></script>
@endpush
