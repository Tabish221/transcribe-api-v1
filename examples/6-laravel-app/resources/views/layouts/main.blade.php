@php
    // Adds ?v=<file time> so the browser loads new CSS/JS after an edit.
    $asset = fn (string $path) => asset($path) . '?v=' . (@filemtime(public_path($path)) ?: '1');
    $apiHost = parse_url((string) config('services.transcribe.url'), PHP_URL_HOST) ?: 'not set';
@endphp
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>@yield('title') · Transcribe Demo</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%236d28d9'/%3E%3Cpath d='M7 18v-4M11 22V10M15 25V7M19 21v-10M23 18v-4' stroke='white' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E">
    <link rel="stylesheet" href="{{ $asset('css/app.css') }}">
    <script>
        try { var t = localStorage.getItem('td-theme'); if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t); } catch (e) {}
    </script>
</head>
<body>
<header class="topbar">
    <a class="brand" href="{{ route('app') }}">
        <span class="logo" aria-hidden="true">&#9835;</span>
        <span>Transcribe <small>Laravel demo</small></span>
    </a>
    <nav aria-label="Main">
        <a href="{{ route('app') }}" class="{{ request()->routeIs('app') ? 'active' : '' }}">App</a>
        @if (config('services.transcribe.tester'))
            <a href="{{ route('tester') }}" class="{{ request()->routeIs('tester') ? 'active' : '' }}">Backend tester</a>
        @endif
    </nav>
    <button type="button" id="theme-toggle" class="icon-btn" aria-label="Change theme">&#9790;</button>
</header>

<main class="container">
    @yield('content')
</main>

<footer class="footer">
    Transcribe API: {{ $apiHost }} · The API key stays on the server.
</footer>

<script src="{{ $asset('js/common.js') }}"></script>
@stack('scripts')
</body>
</html>
