@extends('layouts.main')

@section('title', 'App')

@section('content')
<div id="app-root" data-max-bytes="{{ $maxBytes }}" data-max-human="{{ $maxHuman }}">
    <div class="page-head">
        <h1>Speech to text</h1>
        <p>Upload an MP3. Laravel sends it to your Transcribe API. The result comes back by webhook, and this page shows it.</p>
    </div>

    <div class="app-grid">
        <div>
            <section class="card" aria-labelledby="upload-title">
                <h2 id="upload-title">1. Upload an MP3</h2>
                <label class="dropzone" id="dropzone" style="margin-top:.6rem">
                    <input type="file" id="file-input" class="visually-hidden" accept=".mp3,audio/mpeg">
                    <span class="big" aria-hidden="true">&#8682;</span>
                    <strong>Drop an MP3 file here</strong>
                    <span class="muted small">or click to choose · max {{ $maxHuman }}</span>
                    <span id="picked" class="picked"></span>
                </label>

                <div class="row" style="margin-top:.75rem">
                    <label class="field">Engine
                        <select id="engine">
                            <option value="worker" @selected($engine === 'worker')>Worker (my PC)</option>
                            <option value="cloud" @selected($engine === 'cloud')>Cloud</option>
                        </select>
                    </label>
                    <label class="field">Language
                        <select id="language">
                            @foreach ($languages as $code => $name)
                                <option value="{{ $code }}" @selected($language === $code)>{{ $name }}{{ $code !== 'auto' ? ' (' . $code . ')' : '' }}</option>
                            @endforeach
                        </select>
                    </label>
                </div>

                <button type="button" id="upload-btn" class="btn primary" style="margin-top:.75rem;width:100%" disabled>Upload and transcribe</button>
                <div id="upload-progress" class="progress" hidden><div class="bar"></div><span class="label"></span></div>
                <p id="upload-msg" class="msg" role="status" aria-live="polite"></p>
            </section>

            <section class="card" aria-labelledby="list-title">
                <div class="card-head">
                    <h2 id="list-title">2. My transcriptions</h2>
                    <button type="button" id="refresh-list" class="btn sm">Refresh</button>
                </div>
                <ul id="list" class="t-list"></ul>
                <p id="list-empty" class="empty">Nothing yet. Upload a file above.</p>
                <p id="list-msg" class="msg error" role="status"></p>
            </section>
        </div>

        <section class="card viewer" aria-labelledby="v-title" aria-live="polite">
            <p id="viewer-empty" class="empty">Choose a transcription from the list.</p>
            <div id="viewer-body" hidden>
                <div class="viewer-head">
                    <h2 id="v-title"></h2>
                    <span id="v-badge" class="badge"></span>
                </div>
                <p id="v-meta" class="muted small"></p>
                <div id="v-progress" class="progress" hidden><div class="bar"></div><span class="label"></span></div>
                <p id="v-error" class="msg error" hidden></p>
                <audio id="v-audio" controls preload="metadata" hidden></audio>
                <div class="toolbar">
                    <button type="button" id="v-copy" class="btn sm">Copy text</button>
                    <button type="button" id="v-srt" class="btn sm">Download SRT</button>
                    <button type="button" id="v-delete" class="btn sm danger">Delete</button>
                </div>
                <p id="v-msg" class="msg" role="status"></p>
                <p id="v-hint" class="muted small" hidden>Click a line to play the audio from there.</p>
                <ol id="v-lines" class="lines"></ol>
                <p id="v-text" class="plain-text" hidden></p>
            </div>
        </section>
    </div>
</div>
@endsection

@push('scripts')
    <script src="{{ asset('js/app.js') . '?v=' . (@filemtime(public_path('js/app.js')) ?: '1') }}"></script>
@endpush
