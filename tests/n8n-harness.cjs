#!/usr/bin/env node
'use strict';
/**
 * Test harness for the n8n community node (n8n-nodes-transcribe-api) without running n8n.
 *
 * It instantiates the node with a fake IExecuteFunctions context (input items, parameters with n8n-style
 * defaults, credentials, binary helpers, httpRequestWithAuthentication implemented with fetch + Bearer)
 * and runs one operation against a real or mock Transcribe API server.
 *
 *   node tests/n8n-harness.cjs --validate
 *   node tests/n8n-harness.cjs --base http://127.0.0.1:8091 --key tk_... --op transcribe --file tests/fixtures/clip.mp3 --engine cloud
 *   node tests/n8n-harness.cjs --help
 *
 * Also usable as a module: const { runNode, validatePackage } = require('./n8n-harness.cjs');
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG_DIR = path.join(ROOT, 'n8n-nodes-transcribe-api');
const EXAMPLES_DIR = path.join(ROOT, 'n8n-examples');
const NODE_FILE = path.join(PKG_DIR, 'dist', 'nodes', 'TranscribeApi', 'TranscribeApi.node.js');

// Use the same n8n-workflow copy the node resolves (installed as a devDependency of the package).
const loadWorkflow = () => require(require.resolve('n8n-workflow', { paths: [PKG_DIR] }));

const USAGE = `n8n node harness for n8n-nodes-transcribe-api

Usage:
  node tests/n8n-harness.cjs --validate
  node tests/n8n-harness.cjs --base <url> --key <tk_...> --op <operation> [options]

Connection (env fallbacks: TRANSCRIBE_BASE_URL, TRANSCRIBE_API_KEY):
  --base <url>             server base URL, e.g. http://127.0.0.1:8091 (no /api/v1)
  --key <tk_...>           project API key (never printed)

Operations:
  --op transcribe --file <path> [--file <path2> ...]   one input item per file
       [--engine default|cloud|worker] [--language en] [--task transcribe|translate]
       [--prompt "..."] [--metadata '{"k":"v"}'] [--webhook <url>] [--file-name call.mp3]
       [--mime audio/mpeg] [--no-wait] [--poll <seconds>] [--timeout <seconds>]
  --op get --id <tr_...> [--id ...] [--format json|txt|srt|vtt]
  --op list [--status queued|processing|completed|failed] [--limit 20] [--all]
  --op delete --id <tr_...> [--id ...]

Other:
  --param name=value       set any node parameter (dot paths allowed, JSON values parsed)
  --continue-on-fail       emulate the node setting "On Error: Continue"
  --out <file>             also write the output items as JSON to a file
  --summary                print a compact summary instead of the full JSON
  --quiet                  do not log HTTP requests to stderr
  --validate               validate package.json, node/credential descriptions and n8n-examples/*.json

Exit codes: 0 ok, 1 node error, 2 usage/validation error.`;

const MIME_BY_EXT = {
	mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
	webm: 'audio/webm', flac: 'audio/flac', aac: 'audio/aac', txt: 'text/plain',
};

/* ------------------------------------------------------------------ parameters */

function getPath(obj, dotted) {
	return dotted.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

function setPath(obj, dotted, value) {
	const keys = dotted.split('.');
	let target = obj;
	for (const key of keys.slice(0, -1)) target = target[key] = target[key] && typeof target[key] === 'object' ? target[key] : {};
	target[keys[keys.length - 1]] = value;
}

/** displayOptions check against already-resolved top-level values (same semantics as n8n for simple cases). */
function isVisible(property, values) {
	const { show, hide } = property.displayOptions || {};
	for (const [key, allowed] of Object.entries(show || {})) {
		if (!allowed.includes(values[key.replace(/^\//, '')])) return false;
	}
	for (const [key, blocked] of Object.entries(hide || {})) {
		if (blocked.includes(values[key.replace(/^\//, '')])) return false;
	}
	return true;
}

/**
 * Like n8n: visible top-level parameters get their default when unset, hidden ones are dropped.
 * Function values are per-item "expressions": (itemIndex, item) => value.
 */
function resolveParameters(properties, raw, itemIndex, item) {
	const values = {};
	for (let pass = 0; pass < 2; pass++) {
		for (const property of properties) {
			if (!isVisible(property, values)) {
				delete values[property.name];
				continue;
			}
			let value = raw[property.name];
			if (typeof value === 'function') value = value(itemIndex, item);
			values[property.name] = value !== undefined ? value : JSON.parse(JSON.stringify(property.default ?? null));
		}
	}
	return values;
}

/* ------------------------------------------------------------------ fake IExecuteFunctions */

function createContext({ description, parameters, items, credentials, continueOnFail = false, log = () => {} }) {
	const { NodeApiError, NodeOperationError } = loadWorkflow();
	const node = {
		id: 'harness-node',
		name: 'Transcribe API',
		type: 'n8n-nodes-transcribe-api.transcribeApi',
		typeVersion: 1,
		position: [0, 0],
		parameters,
	};

	const context = {
		getInputData: () => items,
		getNode: () => node,
		continueOnFail: () => continueOnFail,
		getNodeParameter(name, itemIndex, fallback) {
			const values = resolveParameters(description.properties, parameters, itemIndex, items[itemIndex]);
			const value = getPath(values, name);
			if (value !== undefined) return value;
			if (fallback !== undefined) return fallback;
			throw new NodeOperationError(node, `Could not get parameter "${name}"`, { itemIndex });
		},
		async getCredentials(type) {
			if (type !== 'transcribeApi') throw new NodeOperationError(node, `Node does not have credentials of type "${type}"`);
			return { ...credentials };
		},
		helpers: {
			assertBinaryData(itemIndex, propertyName) {
				const binary = items[itemIndex] && items[itemIndex].binary && items[itemIndex].binary[propertyName];
				if (!binary) {
					throw new NodeOperationError(node, `No binary data property "${propertyName}" exists on item!`, { itemIndex });
				}
				return binary;
			},
			async getBinaryDataBuffer(itemIndex, propertyName) {
				return Buffer.from(context.helpers.assertBinaryData(itemIndex, propertyName).data, 'base64');
			},
			/** Mirrors n8n's axios-based helper: qs, Buffer/JSON bodies, encoding, returnFullResponse, ignoreHttpStatusErrors, timeout. */
			async httpRequestWithAuthentication(credentialsType, options) {
				const creds = await this.getCredentials(credentialsType);
				const url = new URL(options.baseURL ? `${options.baseURL.replace(/\/+$/, '')}/${options.url.replace(/^\/+/, '')}` : options.url);
				for (const [key, value] of Object.entries(options.qs || {})) {
					if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
				}
				const headers = { 'User-Agent': 'n8n', ...options.headers, Authorization: `Bearer ${creds.apiKey}` };
				let body = options.body;
				if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
					body = JSON.stringify(body);
					if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
				}
				const method = (options.method || 'GET').toUpperCase();
				const started = Date.now();
				let response;
				try {
					response = await fetch(url, {
						method,
						headers,
						body: method === 'GET' ? undefined : body,
						signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
					});
				} catch (error) {
					log(`-> ${method} ${url.href} failed: ${(error.cause && error.cause.code) || error.message}`);
					// n8n wraps transport errors in NodeApiError as well.
					throw new NodeApiError(node, { message: (error.cause && error.cause.message) || error.message, code: error.cause && error.cause.code });
				}
				const buffer = Buffer.from(await response.arrayBuffer());
				const size = body && body.length ? ` (${formatBytes(body.length)} sent)` : '';
				log(`-> ${method} ${url.pathname}${url.search}${size} <- ${response.status} ${formatBytes(buffer.length)} in ${Date.now() - started} ms`);

				let data;
				if (options.encoding === 'arraybuffer') data = buffer;
				else if (options.encoding === 'text') data = buffer.toString('utf8');
				else {
					const text = buffer.toString('utf8');
					try {
						data = JSON.parse(text);
					} catch (error) {
						data = text;
					}
				}
				if (!options.ignoreHttpStatusErrors && (response.status < 200 || response.status >= 300)) {
					throw new NodeApiError(node, { message: `Request failed with status code ${response.status}`, response: { status: response.status, data } }, { httpCode: String(response.status) });
				}
				if (!options.returnFullResponse) return data;
				return { body: data, headers: Object.fromEntries(response.headers), statusCode: response.status, statusMessage: response.statusText };
			},
		},
	};
	return context;
}

/**
 * Runs the node once. Returns { output, error, ms } where output is the node's first output array.
 * `parameters` values may be functions (itemIndex, item) => value to emulate per-item expressions.
 */
async function runNode({ baseUrl, apiKey, parameters, items, continueOnFail = false, log = () => {} }) {
	const { TranscribeApi } = require(NODE_FILE);
	const nodeType = new TranscribeApi();
	const context = createContext({
		description: nodeType.description,
		parameters,
		items,
		credentials: { baseUrl, apiKey },
		continueOnFail,
		log,
	});
	const started = Date.now();
	try {
		const result = await nodeType.execute.call(context);
		return { output: result[0], error: null, ms: Date.now() - started };
	} catch (error) {
		return { output: null, error, ms: Date.now() - started };
	}
}

/** Builds an n8n input item with binary data from a local file. */
function fileItem(filePath, { propertyName = 'data', mimeType } = {}) {
	const data = fs.readFileSync(filePath);
	const fileName = path.basename(filePath);
	const fileExtension = path.extname(fileName).slice(1).toLowerCase();
	return {
		json: { file: fileName },
		binary: {
			[propertyName]: {
				data: data.toString('base64'),
				mimeType: mimeType || MIME_BY_EXT[fileExtension] || 'application/octet-stream',
				fileName,
				fileExtension,
				fileSize: formatBytes(data.length),
			},
		},
	};
}

function formatBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ validation */

function validatePackage() {
	const problems = [];
	const passed = [];
	const check = (ok, message) => (ok ? passed : problems).push(message);

	const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
	check(pkg.name === 'n8n-nodes-transcribe-api', `package name is ${pkg.name}`);
	check(pkg.version === '1.0.0', `package version is ${pkg.version}`);
	check((pkg.keywords || []).includes('n8n-community-node-package'), 'keyword n8n-community-node-package');
	check(JSON.stringify(pkg.files) === '["dist"]', 'files is ["dist"]');
	check(pkg.peerDependencies && pkg.peerDependencies['n8n-workflow'] === '*', 'peerDependencies n8n-workflow "*"');
	check(pkg.n8n && pkg.n8n.n8nNodesApiVersion === 1, 'n8n.n8nNodesApiVersion is 1');

	const credentialNames = [];
	for (const file of (pkg.n8n && pkg.n8n.credentials) || []) {
		const full = path.join(PKG_DIR, file);
		const className = path.basename(file).split('.')[0];
		const Cls = require(full)[className];
		check(typeof Cls === 'function', `${file} exports class ${className}`);
		if (typeof Cls !== 'function') continue;
		const cred = new Cls();
		credentialNames.push(cred.name);
		checkUniqueNames(cred.properties, `credential ${cred.name}`, check);
		const apiKey = cred.properties.find((p) => p.name === 'apiKey');
		check(!!cred.properties.find((p) => p.name === 'baseUrl'), 'credential has baseUrl');
		check(!!apiKey && apiKey.typeOptions && apiKey.typeOptions.password === true, 'credential apiKey is a password field');
		check(cred.authenticate && cred.authenticate.type === 'generic', 'credential uses generic auth');
		check(cred.test && cred.test.request && cred.test.request.url === '/api/v1/transcriptions', 'credential test request');
	}

	for (const file of (pkg.n8n && pkg.n8n.nodes) || []) {
		const full = path.join(PKG_DIR, file);
		const className = path.basename(file).split('.')[0];
		const Cls = require(full)[className];
		check(typeof Cls === 'function', `${file} exports class ${className}`);
		if (typeof Cls !== 'function') continue;
		const d = new Cls().description;
		for (const key of ['displayName', 'name', 'icon', 'group', 'version', 'subtitle', 'description', 'defaults', 'inputs', 'outputs', 'credentials', 'properties']) {
			check(d[key] !== undefined, `node description has ${key}`);
		}
		check(typeof new Cls().execute === 'function', 'node has execute()');
		const icon = String(d.icon || '').replace(/^file:/, '');
		check(fs.existsSync(path.join(path.dirname(full), icon)), `icon ${icon} exists`);
		for (const c of d.credentials || []) check(credentialNames.includes(c.name), `node credential ${c.name} is defined`);
		const codexFile = `${full}on`;
		const codex = fs.existsSync(codexFile) ? JSON.parse(fs.readFileSync(codexFile, 'utf8')) : null;
		check(codex && codex.node === `${pkg.name}.${d.name}`, `codex ${path.basename(codexFile)} node id`);
		checkProperties(d.properties, check);
	}

	checkExamples(check);
	return { passed, problems };
}

function checkUniqueNames(properties, label, check) {
	const names = properties.map((p) => p.name);
	const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
	check(duplicates.length === 0, `${label}: unique parameter names${duplicates.length ? ` (duplicates: ${duplicates.join(', ')})` : ''}`);
}

function checkProperties(properties, check) {
	checkUniqueNames(properties, 'node', check);
	const byName = Object.fromEntries(properties.map((p) => [p.name, p]));
	const validValues = (p) => (p.type === 'boolean' ? [true, false] : p.type === 'options' ? p.options.map((o) => o.value) : null);

	const walk = (list, label) => {
		for (const p of list) {
			const where = `${label}${p.name}`;
			check(p.displayName && p.name && p.type && p.default !== undefined, `${where}: has displayName, name, type, default`);
			if (p.type === 'options') {
				const values = p.options.map((o) => o.value);
				check(values.length > 0 && new Set(values).size === values.length, `${where}: unique option values`);
				check(values.includes(p.default), `${where}: default "${p.default}" is an option`);
			}
			if (p.type === 'collection') {
				checkUniqueNames(p.options, where, check);
				walk(p.options, `${where}.`);
			}
			for (const kind of ['show', 'hide']) {
				for (const [key, expected] of Object.entries((p.displayOptions || {})[kind] || {})) {
					const ref = byName[key.replace(/^\//, '')];
					check(!!ref, `${where}: displayOptions.${kind} references existing parameter "${key}"`);
					const allowed = ref && validValues(ref);
					if (allowed) {
						const bad = expected.filter((v) => !allowed.includes(v));
						check(bad.length === 0, `${where}: displayOptions.${kind}.${key} values are valid${bad.length ? ` (invalid: ${bad.join(', ')})` : ''}`);
					}
				}
			}
		}
	};
	walk(properties, '');

	const operation = byName.operation;
	check(operation && operation.options.every((o) => o.action), 'every operation has an action label');
}

function checkExamples(check) {
	if (!fs.existsSync(EXAMPLES_DIR)) return check(false, 'n8n-examples/ exists');
	const KNOWN_TYPES = {
		'n8n-nodes-base.manualTrigger': [1],
		'n8n-nodes-base.readWriteFile': [1],
		'n8n-nodes-base.httpRequest': [4.2],
		'n8n-nodes-base.set': [3.4],
		'n8n-nodes-base.webhook': [2],
		'n8n-nodes-base.code': [2],
		'n8n-nodes-base.if': [2],
		'n8n-nodes-base.noOp': [1],
		'n8n-nodes-base.stickyNote': [1],
	};
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

	for (const file of fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json'))) {
		let workflow;
		try {
			workflow = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8'));
		} catch (error) {
			check(false, `${file}: valid JSON (${error.message})`);
			continue;
		}
		check(true, `${file}: valid JSON`);
		const nodes = workflow.nodes || [];
		const names = nodes.map((n) => n.name);
		const ids = nodes.map((n) => n.id);
		check(nodes.length > 0 && new Set(names).size === names.length, `${file}: node names unique`);
		check(new Set(ids).size === ids.length && ids.every((id) => /^[0-9a-f-]{36}$/.test(id)), `${file}: node ids are unique UUIDs`);
		for (const n of nodes) {
			const versions = KNOWN_TYPES[n.type];
			check(!!versions && versions.includes(n.typeVersion), `${file}: ${n.name} uses ${n.type} v${n.typeVersion}`);
			check(Array.isArray(n.position) && n.position.length === 2 && n.parameters && typeof n.parameters === 'object', `${file}: ${n.name} has position + parameters`);
			if (n.type === 'n8n-nodes-base.code') {
				try {
					new AsyncFunction('$input', '$', '$json', 'require', n.parameters.jsCode); // syntax check only
					check(true, `${file}: ${n.name} jsCode compiles`);
				} catch (error) {
					check(false, `${file}: ${n.name} jsCode compiles (${error.message})`);
				}
			}
		}
		for (const [source, outputs] of Object.entries(workflow.connections || {})) {
			check(names.includes(source), `${file}: connection source "${source}" exists`);
			for (const branch of outputs.main || []) {
				for (const target of branch || []) check(names.includes(target.node), `${file}: connection target "${target.node}" exists`);
			}
		}
	}
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
	const args = { files: [], ids: [], params: [] };
	const flags = new Set(['validate', 'all', 'no-wait', 'continue-on-fail', 'summary', 'quiet', 'help']);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
		const [rawKey, inline] = arg.slice(2).split(/=(.*)/s);
		if (flags.has(rawKey)) {
			args[rawKey] = true;
			continue;
		}
		const value = inline !== undefined ? inline : argv[++i];
		if (value === undefined) throw new Error(`Missing value for --${rawKey}`);
		if (rawKey === 'file') args.files.push(value);
		else if (rawKey === 'id') args.ids.push(value);
		else if (rawKey === 'param') args.params.push(value);
		else args[rawKey] = value;
	}
	return args;
}

function parameterValue(text) {
	try {
		return JSON.parse(text);
	} catch (error) {
		return text;
	}
}

/** Maps CLI options to node parameters + input items. */
function buildRun(args) {
	const operation = args.op;
	if (!['transcribe', 'get', 'list', 'delete'].includes(operation)) throw new Error('--op must be transcribe, get, list or delete');
	const parameters = { resource: 'transcription', operation };
	let items = [{ json: {} }];

	if (operation === 'transcribe') {
		if (!args.files.length) throw new Error('--file is required for --op transcribe');
		const propertyName = args['binary-prop'] || 'data';
		items = args.files.map((f) => fileItem(path.resolve(f), { propertyName, mimeType: args.mime }));
		parameters.binaryPropertyName = propertyName;
		if (args.engine) parameters.engine = args.engine;
		if (args.language !== undefined) parameters.language = args.language;
		if (args['no-wait'] || args.wait === 'false') parameters.waitForCompletion = false;
		if (args.poll) parameters.pollInterval = Number(args.poll);
		if (args.timeout) parameters.timeout = Number(args.timeout);
		const extra = {};
		if (args.task) extra.task = args.task;
		if (args.prompt) extra.prompt = args.prompt;
		if (args.metadata) extra.metadata = args.metadata;
		if (args.webhook) extra.webhookUrl = args.webhook;
		if (args['file-name']) extra.fileName = args['file-name'];
		parameters.additionalFields = extra;
	}
	if (operation === 'get' || operation === 'delete') {
		if (!args.ids.length) throw new Error(`--id is required for --op ${operation}`);
		items = args.ids.map((id) => ({ json: { id } }));
		parameters.transcriptionId = (itemIndex, item) => item.json.id; // like ={{ $json.id }}
		if (args.format) parameters.format = args.format;
	}
	if (operation === 'list') {
		if (args.all) parameters.returnAll = true;
		if (args.limit) parameters.limit = Number(args.limit);
		if (args.status) parameters.status = args.status;
	}
	for (const assignment of args.params) {
		const eq = assignment.indexOf('=');
		if (eq < 1) throw new Error(`--param expects name=value, got "${assignment}"`);
		setPath(parameters, assignment.slice(0, eq), parameterValue(assignment.slice(eq + 1)));
	}
	return { parameters, items };
}

function summarize(output) {
	return output.map(({ json, pairedItem }) => {
		const line = { item: pairedItem && pairedItem.item };
		for (const key of ['id', 'status', 'engine', 'filename', 'duration', 'format', 'deleted', 'error', 'webhook_status']) {
			if (json[key] !== undefined && json[key] !== null) line[key] = json[key];
		}
		if (typeof json.text === 'string') line.text = json.text.length > 160 ? `${json.text.slice(0, 160)}...` : json.text;
		if (Array.isArray(json.segments)) line.segments = json.segments.length;
		if (typeof json.content === 'string') line.content = json.content.slice(0, 160);
		return line;
	});
}

async function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`${error.message}\n\n${USAGE}`);
		return 2;
	}
	if (args.help || process.argv.length <= 2) {
		console.log(USAGE);
		return 0;
	}
	try {
		require.resolve('n8n-workflow', { paths: [PKG_DIR] });
	} catch (error) {
		console.error('n8n-workflow not found: run "npm install" inside n8n-nodes-transcribe-api first (dev dependency).');
		return 2;
	}

	if (args.validate) {
		const { passed, problems } = validatePackage();
		console.log(`validate: ${passed.length} checks passed, ${problems.length} failed`);
		for (const p of problems) console.log(`  FAIL ${p}`);
		return problems.length ? 2 : 0;
	}

	const baseUrl = args.base || process.env.TRANSCRIBE_BASE_URL;
	const apiKey = args.key || process.env.TRANSCRIBE_API_KEY;
	if (!baseUrl || !apiKey) {
		console.error(`--base and --key (or TRANSCRIBE_BASE_URL / TRANSCRIBE_API_KEY) are required\n\n${USAGE}`);
		return 2;
	}
	let run;
	try {
		run = buildRun(args);
	} catch (error) {
		console.error(`${error.message}\n\n${USAGE}`);
		return 2;
	}

	const log = args.quiet ? () => {} : (line) => console.error(`[harness] ${line}`);
	log(`op=${args.op} items=${run.items.length} base=${baseUrl}`);
	const { output, error, ms } = await runNode({
		baseUrl,
		apiKey,
		parameters: run.parameters,
		items: run.items,
		continueOnFail: !!args['continue-on-fail'],
		log,
	});

	if (error) {
		const details = { name: error.name, message: error.message };
		if (error.description) details.description = error.description;
		if (error.httpCode) details.httpCode = error.httpCode;
		if (error.context && error.context.itemIndex !== undefined) details.itemIndex = error.context.itemIndex;
		console.error(`[harness] node threw after ${ms} ms: ${JSON.stringify(details)}`);
		return 1;
	}
	log(`node returned ${output.length} item(s) in ${ms} ms`);
	const printable = args.summary ? summarize(output) : output;
	console.log(JSON.stringify(printable, null, 2));
	if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(output, null, 2));
	return 0;
}

module.exports = { runNode, createContext, fileItem, validatePackage, resolveParameters };

if (require.main === module) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(error);
			process.exitCode = 1;
		},
	);
}
