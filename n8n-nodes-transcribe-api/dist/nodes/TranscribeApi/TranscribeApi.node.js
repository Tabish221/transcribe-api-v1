'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.TranscribeApi = void 0;

const crypto = require('crypto');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');

/** Statuses that mean "not finished yet" (SPEC §5). */
const PENDING_STATUSES = ['queued', 'processing'];

/** Fallback file extensions when the binary has no usable file name (the API checks the extension). */
const MIME_EXTENSIONS = {
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/mp4': 'm4a',
	'audio/m4a': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/aac': 'aac',
	'audio/wav': 'wav',
	'audio/wave': 'wav',
	'audio/x-wav': 'wav',
	'audio/ogg': 'ogg',
	'audio/webm': 'webm',
	'audio/flac': 'flac',
	'audio/x-flac': 'flac',
};

/**
 * n8n fills binary.fileExtension from the MIME type with the mime-types package, which gives the IANA names
 * ("mpga" for audio/mpeg, "oga" for audio/ogg). The API checks the usual extensions, so map them.
 */
const EXTENSION_ALIASES = {
	mpga: 'mp3',
	mp2a: 'mp3',
	m2a: 'mp3',
	oga: 'ogg',
	weba: 'webm',
	mp4a: 'm4a',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toNumber = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** Response bodies are requested as raw bytes; normalise whatever the n8n version hands back to text. */
function bodyToText(body) {
	if (body === undefined || body === null) return '';
	if (Buffer.isBuffer(body)) return body.toString('utf8');
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body).toString('utf8');
	if (typeof body === 'string') return body;
	return JSON.stringify(body);
}

/** Parsed JSON object/array, or undefined when the body is not JSON. */
function bodyToJson(body) {
	if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body) && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer)) {
		return body;
	}
	try {
		const parsed = JSON.parse(bodyToText(body));
		return parsed && typeof parsed === 'object' ? parsed : undefined;
	} catch (error) {
		return undefined;
	}
}

/** Builds a multipart/form-data body by hand so it works on every n8n version (no form-data dependency). */
function buildMultipart(fields, file) {
	const boundary = `----TranscribeApiN8n${crypto.randomBytes(12).toString('hex')}`;
	const quote = (value) => String(value).replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
	const chunks = [];
	for (const [name, value] of Object.entries(fields)) {
		if (value === undefined || value === null || value === '') continue;
		chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
	}
	chunks.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quote(file.fileName)}"\r\n` +
				`Content-Type: ${file.mimeType}\r\n\r\n`,
			'utf8',
		),
	);
	chunks.push(file.data);
	chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
	return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * File name sent to the API: optional override, else the binary's name, else "<name>.<ext>" with the extension
 * from the MIME type (preferred over n8n's fileExtension, which is "mpga" for audio/mpeg).
 */
function uploadFileName(binary, override) {
	if (override) return override;
	const named = /^(.*)\.([a-z0-9]{2,5})$/i.exec(binary.fileName || '');
	if (named) {
		const alias = EXTENSION_ALIASES[named[2].toLowerCase()];
		return alias ? `${named[1]}.${alias}` : binary.fileName;
	}
	const mime = String(binary.mimeType || '').split(';')[0].trim().toLowerCase();
	const fromBinary = String(binary.fileExtension || '').toLowerCase();
	const ext = MIME_EXTENSIONS[mime] || EXTENSION_ALIASES[fromBinary] || fromBinary || 'mp3';
	return `${binary.fileName || 'audio'}.${ext}`;
}

/** Accepts the "Metadata" parameter as a JSON string or object; returns a JSON string or undefined. */
function metadataField(value, node, itemIndex) {
	if (value === undefined || value === null || value === '') return undefined;
	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch (error) {
			throw new NodeOperationError(node, 'Metadata must be valid JSON', { itemIndex });
		}
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NodeOperationError(node, 'Metadata must be a JSON object, e.g. {"order_id": 123}', { itemIndex });
	}
	return Object.keys(parsed).length ? JSON.stringify(parsed) : undefined;
}

/**
 * One authenticated API call (`this` = IExecuteFunctions). Returns the parsed JSON body, or the body text
 * when `extra.raw` is set. API errors ({"error":{"code","message"}}) become NodeApiError.
 */
async function apiRequest(baseUrl, itemIndex, method, path, extra = {}) {
	const options = {
		method,
		url: `${baseUrl}${path}`,
		headers: { Accept: 'application/json', ...extra.headers },
		encoding: 'arraybuffer',
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (extra.qs) options.qs = extra.qs;
	if (extra.body !== undefined) options.body = extra.body;
	if (extra.timeout) options.timeout = extra.timeout;

	const response = await this.helpers.httpRequestWithAuthentication.call(this, 'transcribeApi', options);
	const statusCode = Number(response.statusCode);
	const json = bodyToJson(response.body);

	if (statusCode < 200 || statusCode >= 300) {
		const apiError = json && json.error && typeof json.error === 'object' ? json.error : {};
		const text = bodyToText(response.body).slice(0, 300);
		throw new NodeApiError(this.getNode(), json || { message: text }, {
			message: apiError.message || `Transcribe API request failed with HTTP ${statusCode}`,
			description: apiError.code
				? `${apiError.code}${apiError.field ? ` (field: ${apiError.field})` : ''} - HTTP ${statusCode}`
				: `HTTP ${statusCode}${text ? `: ${text}` : ''}`,
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	if (extra.raw) return bodyToText(response.body);
	if (!json) {
		// A 200 HTML page usually means the Base URL points at the wrong place.
		throw new NodeOperationError(this.getNode(), 'Unexpected non-JSON response from the Transcribe API - check the Base URL', {
			itemIndex,
			description: bodyToText(response.body).slice(0, 200),
		});
	}
	return json;
}

const transcriptionPath = (id) => `/api/v1/transcriptions/${encodeURIComponent(id)}`;

/** Error that carries the last known transcription so continueOnFail can output it. */
function transcriptionError(node, itemIndex, message, transcription, description) {
	const error = new NodeOperationError(node, message, { itemIndex, description });
	error.transcription = transcription;
	return error;
}

/**
 * Worth polling again: no HTTP status at all (network error, timeout, unreadable body) or 408/429/5xx,
 * which shared hosts return briefly under load (503/508 entry-process limits).
 */
function isRetryable(error) {
	const status = Number(error && error.httpCode);
	if (Number.isInteger(status) && status >= 100) return status === 408 || status === 429 || status >= 500;
	return true;
}

/**
 * Polls GET /transcriptions/{id} until the job leaves queued/processing or the deadline passes.
 * Transient poll errors are retried until the deadline; any error thrown keeps the transcription (id) so
 * the workflow can still find the job, which keeps running on the server.
 */
async function waitForTranscription(request, itemIndex, transcription, pollMs, deadline) {
	const node = this.getNode();
	let current = transcription;
	let lastError = null;
	while (PENDING_STATUSES.includes(current.status)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			const reason = lastError ? `; last poll error: ${lastError.message}` : '';
			throw transcriptionError(node, itemIndex,
				`Timed out waiting for transcription ${current.id} (last status: ${current.status}${reason})`, current);
		}
		await sleep(Math.min(pollMs, remaining));
		try {
			current = await request(itemIndex, 'GET', transcriptionPath(current.id), { timeout: Math.max(1000, deadline - Date.now()) });
			lastError = null;
		} catch (error) {
			if (!isRetryable(error)) {
				throw transcriptionError(node, itemIndex, `Polling transcription ${current.id} failed: ${error.message}`, current, error.description);
			}
			lastError = error; // try again on the next poll
		}
	}
	return current;
}

function requiredId(i) {
	const id = String(this.getNodeParameter('transcriptionId', i) || '').trim();
	if (!id) throw new NodeOperationError(this.getNode(), 'Transcription ID is required', { itemIndex: i });
	return id;
}

/* ------------------------------------------------------------------ operations */

async function transcribe(request, i) {
	const node = this.getNode();
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i);
	const engine = this.getNodeParameter('engine', i, 'default');
	const language = String(this.getNodeParameter('language', i, '') || '').trim();
	const waitForCompletion = this.getNodeParameter('waitForCompletion', i, true);
	const extra = this.getNodeParameter('additionalFields', i, {});

	const binary = this.helpers.assertBinaryData(i, binaryPropertyName);
	const data = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
	const multipart = buildMultipart(
		{
			language,
			engine: engine === 'default' ? undefined : engine,
			task: extra.task,
			prompt: extra.prompt,
			webhook_url: extra.webhookUrl,
			metadata: metadataField(extra.metadata, node, i),
			// Cloud jobs can finish inside the upload request; the server ignores "wait" for worker jobs.
			wait: waitForCompletion && engine !== 'worker' ? 'true' : undefined,
		},
		{
			fileName: uploadFileName(binary, extra.fileName),
			mimeType: binary.mimeType || 'application/octet-stream',
			data,
		},
	);

	// The timeout covers the whole call: upload, in-request cloud processing and polling.
	const pollMs = Math.max(1, toNumber(this.getNodeParameter('pollInterval', i, 10), 10)) * 1000;
	const timeoutMs = Math.max(10, toNumber(this.getNodeParameter('timeout', i, 1800), 1800)) * 1000;
	const deadline = Date.now() + timeoutMs;

	let transcription = await request(i, 'POST', '/api/v1/transcriptions', {
		body: multipart.body,
		headers: { 'Content-Type': multipart.contentType },
		timeout: waitForCompletion ? timeoutMs : undefined,
	});
	if (!transcription.id) {
		throw new NodeOperationError(node, 'Unexpected response from the Transcribe API (no transcription id)', { itemIndex: i });
	}
	if (!waitForCompletion) return transcription;

	transcription = await waitForTranscription.call(this, request, i, transcription, pollMs, deadline);
	if (transcription.status === 'failed') {
		throw transcriptionError(node, i, `Transcription ${transcription.id} failed: ${transcription.error || 'unknown error'}`, transcription);
	}
	return transcription;
}

async function get(request, i) {
	const id = requiredId.call(this, i);
	const format = this.getNodeParameter('format', i, 'json');
	if (format === 'json') return request(i, 'GET', transcriptionPath(id));

	const content = await request(i, 'GET', transcriptionPath(id), { qs: { format }, headers: { Accept: '*/*' }, raw: true });
	return { id, format, content };
}

async function list(request, i) {
	const returnAll = this.getNodeParameter('returnAll', i, false);
	const limit = returnAll ? Infinity : Math.max(1, toNumber(this.getNodeParameter('limit', i, 20), 20));
	const status = this.getNodeParameter('status', i, '');
	const results = [];

	// Page through the newest-first list until we have enough (or everything).
	let offset = 0;
	while (results.length < limit) {
		const size = Math.min(100, limit - results.length);
		const qs = { limit: size, offset };
		if (status) qs.status = status;
		const page = await request(i, 'GET', '/api/v1/transcriptions', { qs });
		const data = Array.isArray(page.data) ? page.data : [];
		results.push(...data);
		offset += data.length;
		const done = typeof page.total === 'number' ? offset >= page.total : data.length < size;
		if (data.length === 0 || done) break;
	}
	return results.slice(0, limit);
}

async function remove(request, i) {
	return request(i, 'DELETE', transcriptionPath(requiredId.call(this, i)));
}

const OPERATIONS = { transcribe, get, list, delete: remove };

/* ------------------------------------------------------------------ node */

const showFor = (operation) => ({ show: { resource: ['transcription'], operation: [operation] } });

class TranscribeApi {
	constructor() {
		this.description = {
			displayName: 'Transcribe API',
			name: 'transcribeApi',
			icon: 'file:transcribeApi.svg',
			group: ['transform'],
			version: 1,
			subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
			description: 'Speech-to-text with your self-hosted Transcribe API (cloud Whisper or your PC worker)',
			defaults: { name: 'Transcribe API' },
			inputs: ['main'],
			outputs: ['main'],
			credentials: [{ name: 'transcribeApi', required: true }],
			properties: [
				{
					displayName: 'Resource',
					name: 'resource',
					type: 'options',
					noDataExpression: true,
					options: [{ name: 'Transcription', value: 'transcription' }],
					default: 'transcription',
				},
				{
					displayName: 'Operation',
					name: 'operation',
					type: 'options',
					noDataExpression: true,
					displayOptions: { show: { resource: ['transcription'] } },
					options: [
						{ name: 'Delete', value: 'delete', description: 'Delete a transcription and its audio', action: 'Delete a transcription' },
						{ name: 'Get', value: 'get', description: 'Get a transcription as JSON, TXT, SRT or VTT', action: 'Get a transcription' },
						{ name: 'List', value: 'list', description: 'List transcriptions of the project, newest first', action: 'List transcriptions' },
						{ name: 'Transcribe', value: 'transcribe', description: 'Upload an audio file and (optionally) wait for the transcript', action: 'Transcribe an audio file' },
					],
					default: 'transcribe',
				},

				// ---- Transcribe
				{
					displayName: 'Input Binary Field',
					name: 'binaryPropertyName',
					type: 'string',
					default: 'data',
					required: true,
					displayOptions: showFor('transcribe'),
					hint: 'The name of the input binary field containing the audio file',
				},
				{
					displayName: 'Engine',
					name: 'engine',
					type: 'options',
					displayOptions: showFor('transcribe'),
					options: [
						{ name: 'Cloud', value: 'cloud', description: 'OpenAI-compatible Whisper API called by the server (fast, file size limited)' },
						{ name: 'Project Default', value: 'default', description: 'Use the engine configured for the project' },
						{ name: 'Worker (PC)', value: 'worker', description: 'Local Whisper on the PC worker (any length, slower)' },
					],
					default: 'default',
				},
				{
					displayName: 'Language',
					name: 'language',
					type: 'string',
					default: '',
					placeholder: 'en',
					displayOptions: showFor('transcribe'),
					description: 'ISO-639-1 code of the spoken language. Leave empty to use the project default or auto-detect.',
				},
				{
					displayName: 'Wait for Completion',
					name: 'waitForCompletion',
					type: 'boolean',
					default: true,
					displayOptions: showFor('transcribe'),
					description: 'Whether to return the finished transcript. Off: return the queued job right away (use a webhook or the Get operation later).',
				},
				{
					displayName: 'Poll Interval (Seconds)',
					name: 'pollInterval',
					type: 'number',
					typeOptions: { minValue: 1 },
					default: 10,
					displayOptions: { show: { resource: ['transcription'], operation: ['transcribe'], waitForCompletion: [true] } },
					description: 'How often to check the job status while it is queued or processing',
				},
				{
					displayName: 'Timeout (Seconds)',
					name: 'timeout',
					type: 'number',
					typeOptions: { minValue: 10 },
					default: 1800,
					displayOptions: { show: { resource: ['transcription'], operation: ['transcribe'], waitForCompletion: [true] } },
					description: 'Maximum total time to wait (upload included) before the node fails',
				},
				{
					displayName: 'Additional Fields',
					name: 'additionalFields',
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					displayOptions: showFor('transcribe'),
					options: [
						{
							displayName: 'File Name',
							name: 'fileName',
							type: 'string',
							default: '',
							placeholder: 'call.mp3',
							description: 'File name sent to the API. Its extension must be an allowed type (mp3 by default). Defaults to the binary file name.',
						},
						{
							displayName: 'Metadata',
							name: 'metadata',
							type: 'json',
							default: '{}',
							description: 'JSON object (max 4 KB) stored with the transcription and echoed back in results and webhooks',
						},
						{
							displayName: 'Prompt',
							name: 'prompt',
							type: 'string',
							typeOptions: { rows: 3 },
							default: '',
							description: 'Vocabulary hints such as names or product terms (cloud engine only, max 1000 characters)',
						},
						{
							displayName: 'Task',
							name: 'task',
							type: 'options',
							options: [
								{ name: 'Transcribe', value: 'transcribe', description: 'Text in the spoken language' },
								{ name: 'Translate to English', value: 'translate', description: 'English translation of the speech' },
							],
							default: 'transcribe',
						},
						{
							displayName: 'Webhook URL',
							name: 'webhookUrl',
							type: 'string',
							default: '',
							placeholder: 'https://example.com/webhook/transcribe-api',
							description: 'Called when the job completes or fails. Defaults to the project webhook URL.',
						},
					],
				},

				// ---- Get / Delete
				{
					displayName: 'Transcription ID',
					name: 'transcriptionId',
					type: 'string',
					default: '',
					required: true,
					placeholder: 'tr_...',
					displayOptions: { show: { resource: ['transcription'], operation: ['get', 'delete'] } },
				},
				{
					displayName: 'Output Format',
					name: 'format',
					type: 'options',
					displayOptions: showFor('get'),
					options: [
						{ name: 'JSON (Transcription Object)', value: 'json' },
						{ name: 'Plain Text', value: 'txt' },
						{ name: 'SubRip Subtitles (SRT)', value: 'srt' },
						{ name: 'WebVTT Subtitles (VTT)', value: 'vtt' },
					],
					default: 'json',
					description: 'TXT, SRT and VTT return {id, format, content} and require a completed transcription',
				},

				// ---- List
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					default: false,
					displayOptions: showFor('list'),
					description: 'Whether to return all results or only up to a given limit',
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					typeOptions: { minValue: 1, maxValue: 100 },
					default: 20,
					displayOptions: { show: { resource: ['transcription'], operation: ['list'], returnAll: [false] } },
					description: 'Max number of results to return',
				},
				{
					displayName: 'Status',
					name: 'status',
					type: 'options',
					displayOptions: showFor('list'),
					options: [
						{ name: 'Any', value: '' },
						{ name: 'Completed', value: 'completed' },
						{ name: 'Failed', value: 'failed' },
						{ name: 'Processing', value: 'processing' },
						{ name: 'Queued', value: 'queued' },
					],
					default: '',
					description: 'Only return transcriptions with this status',
				},
			],
		};
	}

	async execute() {
		const items = this.getInputData();
		const returnData = [];
		const credentials = await this.getCredentials('transcribeApi');
		const baseUrl = String(credentials.baseUrl || '').trim().replace(/\/+$/, '');
		if (!baseUrl) {
			throw new NodeOperationError(this.getNode(), 'The Transcribe API credential has no Base URL');
		}
		const request = (itemIndex, method, path, extra) => apiRequest.call(this, baseUrl, itemIndex, method, path, extra);

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i);
				const handler = OPERATIONS[operation];
				if (!handler) throw new NodeOperationError(this.getNode(), `Unsupported operation "${operation}"`, { itemIndex: i });

				const result = await handler.call(this, request, i);
				for (const json of Array.isArray(result) ? result : [result]) {
					returnData.push({ json, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					// Failed/timed-out jobs keep their transcription fields so the id can be used later.
					const json = error.transcription ? { ...error.transcription, error: error.message } : { error: error.message };
					returnData.push({ json, pairedItem: { item: i } });
					continue;
				}
				if (error.context) {
					error.context.itemIndex = i;
					throw error;
				}
				throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
			}
		}
		return [returnData];
	}
}
exports.TranscribeApi = TranscribeApi;
