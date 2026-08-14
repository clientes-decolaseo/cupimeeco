/**
 * Auditoria de redirects com mismatch de tipo de praga
 * (ex.: origem "cupim" → destino "rato").
 *
 * Fontes:
 *   - vercel.json (redirects atuais)
 *   - src/data/seo/gsc-404-policy.json
 *   - src/data/seo/duplicates-policy.json
 *
 * Uso:
 *   node scripts/audit-pest-type-mismatch.mjs
 *
 * Saída: pest-type-mismatch-report.csv — somente leitura.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import vercel from '../vercel.json' with { type: 'json' };
import gsc404Policy from '../src/data/seo/gsc-404-policy.json' with { type: 'json' };
import duplicatesPolicy from '../src/data/seo/duplicates-policy.json' with { type: 'json' };
import { normalizePathKey, normalizeRedirectDestination } from './lib/redirect-map.mjs';
import { matchPestCategories, primaryCategory } from './lib/pest-categories.mjs';

const ROOT = path.resolve('.');
const OUT_CSV = path.join(ROOT, 'pest-type-mismatch-report.csv');

function csvEscape(value) {
	const str = String(value ?? '');
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

/**
 * Coleta redirects únicos: origem → { destination, sources[] }
 */
function collectRedirects() {
	/** @type {Map<string, { destination: string, sources: Set<string> }>} */
	const map = new Map();

	function add(originRaw, destRaw, sourceLabel) {
		const origin = normalizePathKey(originRaw);
		if (!origin) return;
		if (origin.includes(':') || origin.includes('*') || origin.includes('(')) return;

		const destination = normalizeRedirectDestination(destRaw);
		const existing = map.get(origin);
		if (existing) {
			existing.sources.add(sourceLabel);
			return;
		}
		map.set(origin, {
			destination,
			sources: new Set([sourceLabel]),
		});
	}

	for (const r of vercel.redirects ?? []) {
		add(r.source, r.destination, 'vercel.json');
	}
	for (const [from, to] of Object.entries(gsc404Policy.redirects ?? {})) {
		add(from, to, 'gsc-404-policy');
	}
	for (const [from, to] of Object.entries(duplicatesPolicy.redirects ?? {})) {
		add(from, to, 'duplicates-policy');
	}

	return map;
}

async function main() {
	const redirects = collectRedirects();
	/** @type {object[]} */
	const mismatches = [];
	let vercelMismatchCount = 0;
	let bothIdentified = 0;
	let skippedUnclear = 0;

	for (const [origin, meta] of redirects) {
		const catsOrigin = matchPestCategories(origin);
		const catsDest = matchPestCategories(meta.destination);

		if (!catsOrigin.size || !catsDest.size) {
			skippedUnclear++;
			continue;
		}
		bothIdentified++;

		let overlap = false;
		for (const c of catsOrigin) {
			if (catsDest.has(c)) {
				overlap = true;
				break;
			}
		}
		if (overlap) continue;

		const catOrigin = primaryCategory(catsOrigin);
		const catDest = primaryCategory(catsDest);

		const fromVercel = meta.sources.has('vercel.json');
		if (fromVercel) vercelMismatchCount++;

		mismatches.push({
			url_origem: `/${origin}/`.replace(/\/{2,}/g, '/'),
			categoria_origem: catOrigin,
			url_destino: meta.destination,
			categoria_destino: catDest,
			flag: 'MISMATCH_TIPO_PRAGA',
			fontes: [...meta.sources].sort().join('|'),
		});
	}

	mismatches.sort((a, b) => {
		const c = a.categoria_origem.localeCompare(b.categoria_origem);
		if (c !== 0) return c;
		return a.url_origem.localeCompare(b.url_origem);
	});

	const headers = [
		'url_origem',
		'categoria_origem',
		'url_destino',
		'categoria_destino',
		'flag',
		'fontes',
	];

	const lines = [
		headers.join(','),
		...mismatches.map((row) => headers.map((h) => csvEscape(row[h])).join(',')),
	];
	await writeFile(OUT_CSV, `${lines.join('\n')}\n`, 'utf8');

	console.log('audit-pest-type-mismatch\n');
	console.log(`Redirects únicos analisados:     ${redirects.size}`);
	console.log(`Ambas categorias identificáveis: ${bothIdentified}`);
	console.log(`Ignorados (praga não clara):     ${skippedUnclear}`);
	console.log(`MISMATCH_TIPO_PRAGA (total):     ${mismatches.length}`);
	console.log(`  → presentes no vercel.json:    ${vercelMismatchCount}`);
	console.log(`\n→ ${path.relative(ROOT, OUT_CSV)}`);

	if (mismatches.length) {
		console.log('\nAmostra (até 15):');
		for (const row of mismatches.slice(0, 15)) {
			console.log(
				`  ${row.categoria_origem} → ${row.categoria_destino}  ${row.url_origem} → ${row.url_destino}`,
			);
		}
		if (mismatches.length > 15) console.log(`  … +${mismatches.length - 15}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
