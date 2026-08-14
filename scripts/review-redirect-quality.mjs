/**
 * Relatório de qualidade das 36 entradas de gsc-404-policy.json.
 *
 * Cruza scores do 404-matching-report.csv e detecta destinos "MUITOS-PARA-UM"
 * considerando gsc-404-policy + duplicates-policy.
 *
 * Uso:
 *   node scripts/review-redirect-quality.mjs
 *
 * Saída: redirect-quality-review.md (somente leitura — não altera policies).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import gsc404Policy from '../src/data/seo/gsc-404-policy.json' with { type: 'json' };
import duplicatesPolicy from '../src/data/seo/duplicates-policy.json' with { type: 'json' };
import { normalizePathKey, normalizeRedirectDestination } from './lib/redirect-map.mjs';

const ROOT = path.resolve('.');
const CSV_PATH = path.join(ROOT, '404-matching-report.csv');
const OUT_MD = path.join(ROOT, 'redirect-quality-review.md');

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

function toOriginKey(raw) {
	let s = String(raw ?? '').trim();
	if (!s) return '';
	try {
		if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
		else if (s.startsWith('//')) s = new URL(`https:${s}`).pathname;
	} catch {
		/* keep */
	}
	return normalizePathKey(s);
}

function destKey(destination) {
	return normalizeRedirectDestination(destination);
}

/**
 * Contagem de origens por destino em gsc-404 + duplicates.
 * @returns {Map<string, string[]>} destino → lista de origens
 */
function buildDestinationCollisions() {
	/** @type {Map<string, string[]>} */
	const byDest = new Map();

	function add(origin, destination, sourceLabel) {
		const d = destKey(destination);
		const o = normalizePathKey(origin);
		if (!d || !o) return;
		const list = byDest.get(d) ?? [];
		list.push(`${o} (${sourceLabel})`);
		byDest.set(d, list);
	}

	for (const [from, to] of Object.entries(gsc404Policy.redirects ?? {})) {
		add(from, to, 'gsc-404');
	}
	for (const [from, to] of Object.entries(duplicatesPolicy.redirects ?? {})) {
		add(from, to, 'duplicates');
	}

	return byDest;
}

async function loadScoresFromCsv() {
	const matrix = parseCsv(await readFile(CSV_PATH, 'utf8'));
	if (matrix.length < 2) return new Map();

	const headers = matrix[0].map((h) => String(h).trim());
	const idxUrl = headers.indexOf('url_404');
	const idxScore = headers.indexOf('score_similaridade');
	const idxDest = headers.indexOf('melhor_candidato_atual');

	/** @type {Map<string, { score: number, destCsv: string, url404: string }>} */
	const byOrigin = new Map();

	for (const cells of matrix.slice(1)) {
		const url404 = cells[idxUrl] ?? '';
		const origin = toOriginKey(url404);
		if (!origin) continue;
		const score = Number.parseFloat(String(cells[idxScore] ?? '').trim());
		byOrigin.set(origin, {
			score: Number.isFinite(score) ? score : NaN,
			destCsv: String(cells[idxDest] ?? '').trim(),
			url404,
		});
	}

	return byOrigin;
}

async function main() {
	const scores = await loadScoresFromCsv();
	const collisions = buildDestinationCollisions();
	const gscEntries = Object.entries(gsc404Policy.redirects ?? {});

	const rows = gscEntries.map(([origin, destino]) => {
		const meta = scores.get(normalizePathKey(origin));
		const dest = destKey(destino);
		const originsAtDest = collisions.get(dest) ?? [];
		const muitosParaUm = originsAtDest.length > 1;

		return {
			origin: normalizePathKey(origin),
			destino: dest,
			score: meta?.score ?? NaN,
			url404: meta?.url404 || `https://cupins.eco.br/${normalizePathKey(origin)}/`,
			muitosParaUm,
			collisionOrigins: originsAtDest,
		};
	});

	rows.sort((a, b) => {
		const sa = Number.isFinite(a.score) ? a.score : 2;
		const sb = Number.isFinite(b.score) ? b.score : 2;
		if (sa !== sb) return sa - sb;
		return a.origin.localeCompare(b.origin);
	});

	const muitosCount = rows.filter((r) => r.muitosParaUm).length;
	const missingScore = rows.filter((r) => !Number.isFinite(r.score)).length;

	const md = [];
	md.push('# Revisão de qualidade — redirects GSC 404');
	md.push('');
	md.push(
		'Gerado por `scripts/review-redirect-quality.mjs`. Somente leitura — não altera policies.',
	);
	md.push('');
	md.push(`- Entradas em \`gsc-404-policy.json\`: **${rows.length}**`);
	md.push(`- Com alerta MUITOS-PARA-UM: **${muitosCount}**`);
	md.push(`- Sem score no CSV: **${missingScore}**`);
	md.push('- Ordenação: score de similaridade **crescente** (menor = maior risco).');
	md.push(
		'- Colisão de destino: `gsc-404-policy.json` **+** `duplicates-policy.json`.',
	);
	md.push('');
	md.push('---');
	md.push('');

	rows.forEach((row, i) => {
		const scoreLabel = Number.isFinite(row.score)
			? row.score.toFixed(3)
			: '_(ausente no CSV)_';
		md.push(`## ${i + 1}. \`${row.origin}\``);
		md.push('');
		md.push(`- **url_origem:** ${row.url404}`);
		md.push(`- **destino:** \`${row.destino}\``);
		md.push(`- **score:** ${scoreLabel}`);
		if (row.muitosParaUm) {
			md.push(
				`- **alerta:** MUITOS-PARA-UM — destino compartilhado por **${row.collisionOrigins.length}** origem(ns):`,
			);
			for (const o of row.collisionOrigins) {
				md.push(`  - \`${o}\``);
			}
		} else {
			md.push('- **alerta:** _(nenhum)_');
		}
		md.push('');
	});

	// Índice de destinos colidentes (visão rápida)
	const collisionDests = [...collisions.entries()]
		.filter(([, origins]) => origins.length > 1)
		.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

	md.push('---');
	md.push('');
	md.push('## Índice MUITOS-PARA-UM (todas as policies cruzadas)');
	md.push('');
	if (!collisionDests.length) {
		md.push('_Nenhum destino com mais de uma origem._');
	} else {
		md.push(`Destinos com ≥2 origens: **${collisionDests.length}**`);
		md.push('');
		for (const [dest, origins] of collisionDests) {
			md.push(`### \`${dest}\` (${origins.length})`);
			md.push('');
			for (const o of origins) md.push(`- \`${o}\``);
			md.push('');
		}
	}

	await writeFile(OUT_MD, `${md.join('\n')}\n`, 'utf8');

	console.log('review-redirect-quality');
	console.log(`  entradas gsc-404: ${rows.length}`);
	console.log(`  MUITOS-PARA-UM (nas 36): ${muitosCount}`);
	console.log(`  destinos colidentes (gsc+duplicates): ${collisionDests.length}`);
	console.log(`  → ${path.relative(ROOT, OUT_MD)}`);
	console.log('\nTop 5 menor score:');
	for (const row of rows.slice(0, 5)) {
		const s = Number.isFinite(row.score) ? row.score.toFixed(3) : '?';
		const flag = row.muitosParaUm ? ' MUITOS-PARA-UM' : '';
		console.log(`  ${s}  ${row.origin} → ${row.destino}${flag}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
