# n8n-nodes-transcribe-api

n8n community node for your self-hosted **Transcribe API**: upload audio, wait for the transcript, download it as TXT/SRT/VTT, list and delete transcriptions.

Plain CommonJS in `dist/`, no build step and no runtime dependencies (n8n provides `n8n-workflow`).

## Contents

```
dist/credentials/TranscribeApi.credentials.js   credential "Transcribe API" (Base URL + API key)
dist/nodes/TranscribeApi/TranscribeApi.node.js  node "Transcribe API"
dist/nodes/TranscribeApi/TranscribeApi.node.json codex (category, search aliases)
dist/nodes/TranscribeApi/transcribeApi.svg      icon
```

## Install

n8n loads community nodes when it starts, so **restart n8n after every install or update**. Community packages must not be disabled (`N8N_COMMUNITY_PACKAGES_ENABLED` unset or `true`). In queue mode, install on the main instance and on every worker.

### Option A: self-hosted, from a local `.tgz` (recommended)

Build the package file (run inside this folder):

```bash
npm pack                     # creates n8n-nodes-transcribe-api-1.0.0.tgz
```

Install it into n8n's nodes folder (`~/.n8n/nodes`, on Windows `%USERPROFILE%\.n8n\nodes`):

```bash
mkdir -p ~/.n8n/nodes
cp n8n-nodes-transcribe-api-1.0.0.tgz ~/.n8n/nodes/
cd ~/.n8n/nodes
npm install --omit=peer --ignore-scripts ./n8n-nodes-transcribe-api-1.0.0.tgz
# restart n8n
```

- Keep the `.tgz` in `~/.n8n/nodes`: its `package.json` now references it, and n8n runs `npm install` there when you add other community packages.
- `--omit=peer` skips a second copy of `n8n-workflow` (n8n supplies its own). A plain `npm install` also works but downloads `n8n-workflow`, whose native dependency may fail to build in images without compilers (such as the Alpine Docker image).
- To update: build the new `.tgz`, copy it over, run the same `npm install` again, restart n8n.

### Option B: self-hosted, custom extensions folder

n8n also loads every `*.node.js` / `*.credentials.js` it finds in `~/.n8n/custom` or in the folders listed in `N8N_CUSTOM_EXTENSIONS`. Copy just the `dist` folder:

```bash
mkdir -p ~/.n8n/custom/transcribe-api
cp -r dist/* ~/.n8n/custom/transcribe-api/
# or: export N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom   (and copy dist/* to /opt/n8n-custom/transcribe-api)
# restart n8n
```

Copy `dist` only, not the whole folder: `node_modules` (a development copy of `n8n-workflow`) must not be loaded by n8n.

### Option C: Docker

The official image runs as user `node` with `~/.n8n` = `/home/node/.n8n`, normally a volume, so installs survive container updates.

Install the `.tgz` into the volume:

```bash
docker cp n8n-nodes-transcribe-api-1.0.0.tgz n8n:/home/node/.n8n/
docker exec -u node n8n sh -c "mkdir -p ~/.n8n/nodes && mv ~/.n8n/n8n-nodes-transcribe-api-1.0.0.tgz ~/.n8n/nodes/ && cd ~/.n8n/nodes && npm install --omit=peer --ignore-scripts ./n8n-nodes-transcribe-api-1.0.0.tgz"
docker restart n8n
```

Or mount `dist` as a custom extension (docker compose):

```yaml
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n
    environment:
      - N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom
    volumes:
      - n8n_data:/home/node/.n8n
      - ./n8n-nodes-transcribe-api/dist:/opt/n8n-custom/transcribe-api:ro
```

### Option D: Settings → Community Nodes

Only possible after publishing the package to npm (`npm publish`). Then enter `n8n-nodes-transcribe-api` in **Settings → Community Nodes → Install**.

### n8n Cloud

n8n Cloud installs only community nodes verified by n8n, so this package cannot be installed there. Use the importable workflows in [`../n8n-examples`](../n8n-examples), which use the built-in HTTP Request node with a Header Auth credential (`Authorization: Bearer tk_...`) and work on Cloud and self-hosted alike.

## Credential: Transcribe API

| Field | Value |
|---|---|
| Base URL | Where the server is installed, without `/api/v1`, e.g. `https://example.com/transcribe`. Without mod_rewrite on the host, use `https://example.com/transcribe/index.php`. |
| API Key | A project key `tk_...` from the dashboard (API keys tab). Sent as `Authorization: Bearer tk_...`. |

**Test** calls `GET {Base URL}/api/v1/transcriptions?limit=1`.

## Node: Transcribe API

Resource **Transcription**:

| Operation | Parameters | Output |
|---|---|---|
| **Transcribe** | Input Binary Field (default `data`), Engine (Project Default / Cloud / Worker), Language, Wait for Completion (default on), Poll Interval (10 s), Timeout (1800 s); Additional Fields: Task (transcribe/translate), Prompt, Metadata (JSON object), Webhook URL, File Name | The transcription object |
| **Get** | Transcription ID, Output Format: JSON / TXT / SRT / VTT | JSON: the transcription object. TXT/SRT/VTT: `{ "id", "format", "content" }` |
| **List** | Return All, Limit (default 20), Status | One item per transcription (newest first, without `segments`) |
| **Delete** | Transcription ID | `{ "id", "deleted": true }` |

How **Wait for Completion** works:

- Cloud (or Project Default): the upload is sent with `wait=true`, so the server transcribes inside the request and returns the finished object.
- Worker, or any response still `queued`/`processing`: the node polls `GET /api/v1/transcriptions/{id}` every *Poll Interval* seconds.
- The node fails when the job ends as `failed` or the *Timeout* (upload included) runs out.
- A poll that fails with a network error or HTTP 408/429/5xx (shared hosts return 503/508 briefly under load) is retried on the next poll until the *Timeout*; other poll errors stop the wait. Either way the error keeps the transcription `id`.
- With **On Error → Continue**, the item is output instead, containing the transcription fields plus `error`, so you keep the `id` and can fetch the result later.
- For long worker jobs, consider turning waiting off and using a webhook (see `../n8n-examples/2-webhook-receiver.json`).

File type: the API checks the file **extension** (mp3 by default). The node sends the binary's file name. When that name has no extension, the node appends one based on the MIME type (`audio/mpeg` gives `.mp3`, also for binaries from an HTTP Request download of an extensionless URL, where n8n itself sets the extension `mpga`). IANA-style extensions in file names are mapped too (`.mpga` → `.mp3`, `.oga` → `.ogg`). Use **Additional Fields → File Name** to override it.

Every output item has `pairedItem` set, and the node supports **Continue On Fail**. API errors (`{"error":{"code","message"}}`) are reported as n8n API errors with the server's message and code.

## Development

```bash
npm install                                  # dev copy of n8n-workflow for local tests only
node ../tests/n8n-harness.cjs --validate     # package.json, descriptions, example workflows
node ../tests/n8n-harness.cjs --base http://127.0.0.1:8091 --key tk_... --op transcribe --file ../tests/fixtures/clip.mp3 --engine cloud
```

`tests/n8n-harness.cjs` runs the node outside n8n with a fake execution context. See `node ../tests/n8n-harness.cjs --help`.
