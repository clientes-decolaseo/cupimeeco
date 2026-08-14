/**
 * Detecta loops e cadeias longas no grafo de redirects.
 *
 * Fontes:
 *   - vercel.json (redirects atuais)
 *   - gsc-404-policy.json, duplicates-policy.json,
 *     hub-thin-policy.json, offtopic-policy.json (proveniência)
 *
 * Uso:
 *   node scripts/detect-redirect-loops.mjs
 *
 * Saída: redirect-loops-report.csv — somente leitura (não altera policies).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
	formatRedirectSource,
	normalizePathKey,
	normalizeRedirectDestination,
} from './lib/redirect-map.mjs';

const ROOT = path.resolve('.');
const OUT_CSV = path.join(ROOT, 'redirect-loops-report.csv');
const MAX_HOPS = 25;

const POLICY_SOURCES = [
	{ file: 'gsc-404-policy.json', label: 'gsc-404-policy' },
	{ file: 'duplicates-policy.json', label: 'duplicates-policy' },
	{ file: 'hub-thin-policy.json', label: 'hub-thin-policy' },
	{ file: 'offtopic-policy.json', label: 'offtopic-policy' },
];

function csvEscape(value) {
	const str = String(value ?? '');
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

function displayPath(key) {
	if (!key) return '/';
	return formatRedirectSource(key);
}

function isWildcardKey(key) {
	return key.includes(':') || key.includes('*') || key.includes('(');
}

/**
 * Grafo: key → { toKey, destinationDisplay, policies: Set<string> }
 */
async function buildGraph() {
	/** @type {Map<string, { toKey: string, destination: string, policies: Set<string> }>} */
	const graph = new Map();

	function upsert(fromRaw, toRaw, policyLabel) {
		const fromKey = normalizePathKey(fromRaw);
		if (!fromKey || isWildcardKey(fromKey)) return;

		const destination = normalizeRedirectDestination(toRaw);
		const toKey = normalizePathKey(destination);
		if (!toKey) return;
		// Self-redirect trivial — ignora
		if (fromKey === toKey) return;

		const existing = graph.get(fromKey);
		if (existing) {
			existing.policies.add(policyLabel);
			// Destino do vercel.json prevalece se já houver aresta
			if (policyLabel === 'vercel.json') {
				existing.toKey = toKey;
				existing.destination = destination;
			}
			return;
		}

		graph.set(fromKey, {
			toKey,
			destination,
			policies: new Set([policyLabel]),
		});
	}

	const vercel = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
	for (const r of vercel.redirects ?? []) {
		upsert(r.source, r.destination, 'vercel.json');
	}

	for (const { file, label } of POLICY_SOURCES) {
		const policyPath = path.join(ROOT, 'src', 'data', 'seo', file);
		const policy = JSON.parse(await readFile(policyPath, 'utf8'));
		for (const [from, to] of Object.entries(policy.redirects ?? {})) {
			upsert(from, to, label);
		}
	}

	return graph;
}

function policyLabel(graph, key) {
	const edge = graph.get(key);
	if (!edge || edge.policies.size === 0) return '';
	// Preferir label de policy nomeada sobre vercel.json quando ambos existem
	const named = [...edge.policies].filter((p) => p !== 'vercel.json');
	if (named.length) return named.sort().join('+');
	return 'vercel.json';
}

/**
 * @returns {object[]}
 */
function detectIssues(graph) {
	/** @type {object[]} */
	const rows = [];
	/** @type {Set<string>} */
	const seenDirect = new Set();
	/** @type {Set<string>} */
	const seenIndirect = new Set();
	/** @type {Set<string>} */
	const seenChain = new Set();

	// 1) Loops diretos A ↔ B
	for (const [a, edgeA] of graph) {
		const b = edgeA.toKey;
		const edgeB = graph.get(b);
		if (!edgeB || edgeB.toKey !== a) continue;

		const pairKey = [a, b].sort().join('\t');
		if (seenDirect.has(pairKey)) continue;
		seenDirect.add(pairKey);

		const [urlA, urlB] = a < b ? [a, b] : [b, a];
		rows.push({
			url_a: displayPath(urlA),
			url_b: displayPath(urlB),
			tipo: 'loop_direto',
			policy_a: policyLabel(graph, urlA),
			policy_b: policyLabel(graph, urlB),
			caminho: `${displayPath(urlA)} → ${displayPath(urlB)} → ${displayPath(urlA)}`,
		});
	}

	// 2) Walk a partir de cada nó: loops indiretos + cadeias longas
	for (const start of graph.keys()) {
		const pathKeys = [start];
		const seenInPath = new Map([[start, 0]]);
		let current = start;
		let hops = 0;
		let closedLoop = false;
		let cycleStartIdx = -1;

		while (hops < MAX_HOPS) {
			const edge = graph.get(current);
			if (!edge) break;

			const next = edge.toKey;
			hops += 1;

			if (seenInPath.has(next)) {
				closedLoop = true;
				cycleStartIdx = seenInPath.get(next);
				pathKeys.push(next);
				break;
			}

			seenInPath.set(next, pathKeys.length);
			pathKeys.push(next);
			current = next;
		}

		if (closedLoop) {
			const cycle = pathKeys.slice(cycleStartIdx);
			// length 2 edges = A→B→A → já coberto como loop_direto
			if (cycle.length <= 3) continue;

			// Normalizar ciclo pela menor rotação lexicográfica
			const body = cycle.slice(0, -1);
			let minIdx = 0;
			for (let i = 1; i < body.length; i++) {
				if (body[i] < body[minIdx]) minIdx = i;
			}
			const rotated = [...body.slice(minIdx), ...body.slice(0, minIdx)];
			const cycleKey = rotated.join('\t');
			if (seenIndirect.has(cycleKey)) continue;
			seenIndirect.add(cycleKey);

			const urlA = rotated[0];
			const urlB = rotated[1];
			rows.push({
				url_a: displayPath(urlA),
				url_b: displayPath(urlB),
				tipo: 'loop_indireto',
				policy_a: policyLabel(graph, urlA),
				policy_b: policyLabel(graph, urlB),
				caminho: [...rotated, rotated[0]].map(displayPath).join(' → '),
			});
			continue;
		}

		// Cadeia com mais de 1 hop: A → B → C (pathKeys.length >= 3)
		if (pathKeys.length >= 3) {
			const chainKey = pathKeys.join('\t');
			if (seenChain.has(chainKey)) continue;
			// Evitar subcadeias já reportadas como prefixo de outra? Reporta cada início.
			seenChain.add(chainKey);

			const urlA = pathKeys[0];
			const urlB = pathKeys[pathKeys.length - 1];
			const lastHopFrom = pathKeys[pathKeys.length - 2];
			rows.push({
				url_a: displayPath(urlA),
				url_b: displayPath(urlB),
				tipo: 'cadeia_longa',
				policy_a: policyLabel(graph, urlA),
				policy_b: policyLabel(graph, lastHopFrom) || policyLabel(graph, urlB),
				caminho: pathKeys.map(displayPath).join(' → '),
			});
		}
	}

	const order = { loop_direto: 0, loop_indireto: 1, cadeia_longa: 2 };
	rows.sort((a, b) => {
		const t = (order[a.tipo] ?? 9) - (order[b.tipo] ?? 9);
		if (t !== 0) return t;
		return a.url_a.localeCompare(b.url_a) || a.url_b.localeCompare(b.url_b);
	});

	return rows;
}

function parseCsv(text) {
	const rows = [];
	let row = [];
	let cell = '';
	let inQ = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const n = text[i + 1];
		if (inQ) {
			if (c === '"' && n === '"') {
				cell += '"';
				i++;
				continue;
			}
			if (c === '"') {
				inQ = false;
				continue;
			}
			cell += c;
			continue;
		}
		if (c === '"') {
			inQ = true;
			continue;
		}
		if (c === ',') {
			row.push(cell);
			cell = '';
			continue;
		}
		if (c === '\n' || (c === '\r' && n === '\n')) {
			if (c === '\r') i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
			continue;
		}
		if (c === '\r') {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
			continue;
		}
		cell += c;
	}
	if (cell.length > 0 || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

/** Preserva direcao_correta já preenchida (chave url_a|url_b|tipo). */
async function loadPriorDirecao() {
	/** @type {Map<string, string>} */
	const map = new Map();
	try {
		const matrix = parseCsv(await readFile(OUT_CSV, 'utf8'));
		if (matrix.length < 2) return map;
		const headers = matrix[0].map((h) => String(h).trim());
		const idxA = headers.indexOf('url_a');
		const idxB = headers.indexOf('url_b');
		const idxTipo = headers.indexOf('tipo');
		const idxDir = headers.indexOf('direcao_correta');
		if (idxA < 0 || idxB < 0 || idxDir < 0) return map;
		for (const cells of matrix.slice(1)) {
			const dir = String(cells[idxDir] ?? '').trim();
			if (!dir) continue;
			const key = [
				String(cells[idxA] ?? '').trim(),
				String(cells[idxB] ?? '').trim(),
				String(cells[idxTipo] ?? '').trim(),
			].join('\t');
			map.set(key, dir);
		}
	} catch {
		/* arquivo ainda não existe */
	}
	return map;
}

async function main() {
	console.log('detect-redirect-loops — somente relatório\n');

	const graph = await buildGraph();
	const rows = detectIssues(graph);
	const priorDirecao = await loadPriorDirecao();

	const counts = {
		loop_direto: 0,
		loop_indireto: 0,
		cadeia_longa: 0,
	};
	for (const r of rows) counts[r.tipo] = (counts[r.tipo] ?? 0) + 1;

	const headers = ['url_a', 'url_b', 'tipo', 'policy_a', 'policy_b', 'caminho', 'direcao_correta'];
	const csv = [
		headers.join(','),
		...rows.map((row) => {
			const priorKey = `${row.url_a}\t${row.url_b}\t${row.tipo}`;
			const full = {
				...row,
				direcao_correta: priorDirecao.get(priorKey) ?? '',
			};
			return headers.map((h) => csvEscape(full[h])).join(',');
		}),
	].join('\n');

	await writeFile(OUT_CSV, `${csv}\n`, 'utf8');

	console.log(`Nós no grafo (redirects exatos): ${graph.size}`);
	console.log(`loop_direto:    ${counts.loop_direto}`);
	console.log(`loop_indireto:  ${counts.loop_indireto}`);
	console.log(`cadeia_longa:   ${counts.cadeia_longa}`);
	console.log(`total linhas:   ${rows.length}`);
	console.log(`\n→ ${path.relative(ROOT, OUT_CSV)}`);
	console.log('Policies não alteradas.');

	if (counts.loop_direto > 0) {
		console.log('\nLoops diretos:');
		for (const r of rows.filter((x) => x.tipo === 'loop_direto')) {
			console.log(`  ${r.caminho}  [${r.policy_a} | ${r.policy_b}]`);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
