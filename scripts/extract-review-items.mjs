/**
 * Extrai CSVs menores para revisão manual rápida.
 *
 * Entradas (somente leitura):
 *   - city-pages-audit.csv
 *   - 404-matching-report.csv
 *
 * Saídas:
 *   - city-pages-review-manual.csv
 *       linhas com recomendacao = "revisar_manual"
 *   - 404-matching-review-risky.csv
 *       linhas com acao_sugerida = "redirect_301" cujo segmento geográfico
 *       (após -em- / -na- / -no-) difere entre url_404 e melhor_candidato_atual
 *
 * Uso:
 *   node scripts/extract-review-items.mjs
 *
 * Não altera os CSVs originais.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');

const CITY_IN = path.join(ROOT, 'city-pages-audit.csv');
const CITY_OUT = path.join(ROOT, 'city-pages-review-manual.csv');

const MATCH_IN = path.join(ROOT, '404-matching-report.csv');
const MATCH_OUT = path.join(ROOT, '404-matching-review-risky.csv');

/** CSV com aspas e vírgulas. */
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

	return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

function csvEscape(value) {
	const str = String(value ?? '');
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

function rowsToObjects(matrix) {
	if (matrix.length === 0) return { headers: [], objects: [] };
	const headers = matrix[0].map((h) => String(h).trim());
	const objects = matrix.slice(1).map((cells) => {
		const obj = {};
		for (let i = 0; i < headers.length; i++) {
			obj[headers[i]] = cells[i] ?? '';
		}
		return obj;
	});
	return { headers, objects };
}

function writeCsv(filePath, headers, objects) {
	const lines = [
		headers.join(','),
		...objects.map((row) => headers.map((h) => csvEscape(row[h])).join(',')),
	];
	return writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

/** Path/slug sem host, barras e query. */
function pathKey(raw) {
	let s = String(raw ?? '').trim();
	if (!s) return '';
	try {
		if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
		else if (s.startsWith('//')) s = new URL(`https:${s}`).pathname;
	} catch {
		/* keep */
	}
	return s
		.split(/[?#]/)[0]
		.replace(/^\/+|\/+$/g, '')
		.toLowerCase();
}

/**
 * Segmento geográfico após o último -em- / -na- / -no- no slug (folha).
 * Ex.: "dedetizadora-em-cotia" → "cotia"
 *      "dedetizadora-de-cupins-na-zona-leste" → "zona-leste"
 * @returns {string|null}
 */
function extractGeoSegment(raw) {
	const key = pathKey(raw);
	if (!key) return null;
	const leaf = key.split('/').filter(Boolean).pop() || key;
	const match = leaf.match(/-(?:em|na|no)-(.+)$/i);
	if (!match?.[1]) return null;
	return match[1].toLowerCase();
}

/** True se ambos têm geo e os segmentos diferem. */
function isRiskyGeoMismatch(url404, candidate) {
	const geo404 = extractGeoSegment(url404);
	const geoCand = extractGeoSegment(candidate);
	if (!geo404 || !geoCand) return false;
	return geo404 !== geoCand;
}

async function extractCityManual() {
	const text = await readFile(CITY_IN, 'utf8');
	const { headers, objects } = rowsToObjects(parseCsv(text));

	if (!headers.includes('recomendacao')) {
		throw new Error(`${path.basename(CITY_IN)} sem coluna "recomendacao"`);
	}

	const filtered = objects.filter(
		(row) => String(row.recomendacao).trim() === 'revisar_manual',
	);

	await writeCsv(CITY_OUT, headers, filtered);
	return filtered.length;
}

async function extract404Risky() {
	const text = await readFile(MATCH_IN, 'utf8');
	const { headers, objects } = rowsToObjects(parseCsv(text));

	for (const col of ['url_404', 'melhor_candidato_atual', 'acao_sugerida']) {
		if (!headers.includes(col)) {
			throw new Error(`${path.basename(MATCH_IN)} sem coluna "${col}"`);
		}
	}

	const filtered = objects.filter((row) => {
		if (String(row.acao_sugerida).trim() !== 'redirect_301') return false;
		return isRiskyGeoMismatch(row.url_404, row.melhor_candidato_atual);
	});

	await writeCsv(MATCH_OUT, headers, filtered);
	return { count: filtered.length, rows: filtered };
}

async function main() {
	console.log('extract-review-items — somente leitura dos CSVs originais\n');

	const cityCount = await extractCityManual();
	console.log(
		`city-pages-review-manual.csv: ${cityCount} linha(s) (recomendacao=revisar_manual)`,
	);
	console.log(`  → ${path.relative(ROOT, CITY_OUT)}`);

	const { count: riskyCount, rows } = await extract404Risky();
	console.log(
		`\n404-matching-review-risky.csv: ${riskyCount} linha(s) (redirect_301 + geo divergente)`,
	);
	console.log(`  → ${path.relative(ROOT, MATCH_OUT)}`);

	for (const row of rows) {
		const g404 = extractGeoSegment(row.url_404);
		const gCand = extractGeoSegment(row.melhor_candidato_atual);
		console.log(
			`  · ${g404} ≠ ${gCand} | ${row.url_404} → ${row.melhor_candidato_atual}`,
		);
	}

	console.log('\nOriginais intactos (não modificados).');
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
