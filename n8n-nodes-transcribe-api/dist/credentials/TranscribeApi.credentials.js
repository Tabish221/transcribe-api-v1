'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.TranscribeApi = void 0;

/**
 * Credential for a self-hosted Transcribe API server.
 * The API key is sent as "Authorization: Bearer tk_..." on every request.
 */
class TranscribeApi {
	constructor() {
		this.name = 'transcribeApi';
		this.displayName = 'Transcribe API';
		this.properties = [
			{
				displayName: 'Base URL',
				name: 'baseUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://example.com/transcribe',
				description:
					'Where the Transcribe API server is installed, without "/api/v1". If mod_rewrite is unavailable on the host, append "/index.php".',
			},
			{
				displayName: 'API Key',
				name: 'apiKey',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				required: true,
				placeholder: 'tk_...',
				description: 'Project API key created in the dashboard (API keys tab)',
			},
		];
		this.authenticate = {
			type: 'generic',
			properties: {
				headers: {
					Authorization: '=Bearer {{$credentials.apiKey}}',
				},
			},
		};
		// "Test" button in the credential dialog: a cheap authenticated list call.
		this.test = {
			request: {
				baseURL: '={{$credentials.baseUrl}}',
				url: '/api/v1/transcriptions',
				qs: { limit: 1 },
			},
		};
	}
}
exports.TranscribeApi = TranscribeApi;
