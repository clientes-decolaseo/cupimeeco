/**
 * Regenera a seção redirects do vercel.json a partir das policies SEO.
 *
 * Uso:
 *   node scripts/sync-vercel-redirects.mjs           # dry-run (diff, não grava)
 *   node scripts/sync-vercel-redirects.mjs --dry-run
 *   node scripts/sync-vercel-redirects.mjs --write   # grava após mostrar diff
 *   node scripts/sync-vercel-redirects.mjs --apply   # alias de --write
 *
 * No build: `node scripts/sync-vercel-redirects.mjs --write && astro build`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	buildRedirectMap,
	formatRedirectSource,
	normalizeRedirectDestination,
} from './lib/redirect-map.mjs';

const ROOT = path.resolve('.');
const vercelPath = path.join(ROOT, 'vercel.json');

/** Wildcards — devem vir antes das regras exatas no Vercel. */
const WILDCARD_REDIRECTS = [
	{ source: '/d/:path*', destination: '/:path*', permanent: true },
	{ source: '/glossario/:path*', destination: '/blog/', permanent: true },
];

/**
 * URLs com variação de maiúsculas/minúsculas (Vercel é case-sensitive).
 * Source com barra final — ver formatRedirectSource / trailingSlash always.
 */
const CASE_ALIASES = [
	{
		source: '/dedetizadora-em-Cotia/',
		destination: '/dedetizadora-em-cotia/',
		permanent: true,
	},
];

function parseArgs(argv) {
	const args = { write: false, dryRun: true, help: false };
	for (const a of argv) {
		if (a === '--write' || a === '--apply') {
			args.write = true;
			args.dryRun = false;
		} else if (a === '--dry-run') {
			args.dryRun = true;
			args.write = false;
		} else if (a === '--help' || a === '-h') {
			args.help = true;
		}
	}
	return args;
}

function redirectKey(r) {
	return `${r.source}\t${r.destination}\t${r.permanent ? '1' : '0'}`;
}

function summarizeDiff(beforeList, afterList) {
	const beforeBySource = new Map((beforeList || []).map((r) => [r.source, r]));
	const afterBySource = new Map((afterList || []).map((r) => [r.source, r]));

	const added = [];
	const removed = [];
	const changed = [];

	for (const [source, after] of afterBySource) {
		const before = beforeBySource.get(source);
		if (!before) {
			added.push(after);
			continue;
		}
		if (redirectKey(before) !== redirectKey(after)) {
			changed.push({ before, after });
		}
	}

	for (const [source, before] of beforeBySource) {
		if (!afterBySource.has(source)) removed.push(before);
	}

	// Fontes que só mudaram a forma (ex.: /foo → /foo/) — já entram em removed+added;
	// agrupar por path normalizado para o resumo ficar legível.
	const slashOnly = [];
	const removedRest = [];
	const addedRest = [...added];

	for (const rem of removed) {
		const withSlash =
			rem.source.endsWith('/') || !/\.[a-z0-9]{1,10}$/i.test(rem.source.split('/').pop() || '')
				? rem.source.endsWith('/')
					? rem.source
					: `${rem.source}/`
				: rem.source;
		const withoutSlash = rem.source.replace(/\/+$/, '') || '/';
		const matchIdx = addedRest.findIndex(
			(a) =>
				a.source === withSlash ||
				a.source === withoutSlash ||
				a.source.replace(/\/+$/, '') === rem.source.replace(/\/+$/, ''),
		);
		if (matchIdx >= 0) {
			const add = addedRest[matchIdx];
			addedRest.splice(matchIdx, 1);
			if (rem.source !== add.source || rem.destination !== add.destination) {
				slashOnly.push({ before: rem, after: add });
			}
		} else {
			removedRest.push(rem);
		}
	}

	return { added: addedRest, removed: removedRest, changed, slashOnly };
}

function printDiff(diff) {
	const { added, removed, changed, slashOnly } = diff;

	console.log('\n=== Diff vercel.json → redirects ===\n');

	if (slashOnly.length) {
		console.log(`Trailing-slash normalizado (source): ${slashOnly.length}`);
		for (const { before, after } of slashOnly.slice(0, 40)) {
			console.log(`  ~ ${before.source}  →  ${after.source}`);
			if (before.destination !== after.destination) {
				console.log(`      dest: ${before.destination} → ${after.destination}`);
			}
		}
		if (slashOnly.length > 40) console.log(`  … +${slashOnly.length - 40} omitidos`);
		console.log('');
	}

	if (changed.length) {
		console.log(`Destino/permanent alterado (mesmo source): ${changed.length}`);
		for (const { before, after } of changed.slice(0, 20)) {
			console.log(`  * ${after.source}`);
			console.log(`      ${before.destination} → ${after.destination}`);
		}
		if (changed.length > 20) console.log(`  … +${changed.length - 20} omitidos`);
		console.log('');
	}

	if (added.length) {
		console.log(`Adicionados: ${added.length}`);
		for (const r of added.slice(0, 20)) {
			console.log(`  + ${r.source} → ${r.destination}`);
		}
		if (added.length > 20) console.log(`  … +${added.length - 20} omitidos`);
		console.log('');
	}

	if (removed.length) {
		console.log(`Removidos: ${removed.length}`);
		for (const r of removed.slice(0, 20)) {
			console.log(`  - ${r.source} → ${r.destination}`);
		}
		if (removed.length > 20) console.log(`  … +${removed.length - 20} omitidos`);
		console.log('');
	}

	if (!slashOnly.length && !changed.length && !added.length && !removed.length) {
		console.log('(sem diferenças)\n');
	}
}

function buildRedirects() {
	const redirectMap = buildRedirectMap();

	const exactRedirects = [...redirectMap.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([from, to]) => ({
			source: formatRedirectSource(from),
			destination: normalizeRedirectDestination(to),
			permanent: true,
		}));

	return [...WILDCARD_REDIRECTS, ...CASE_ALIASES, ...exactRedirects];
}

function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(
			'Uso: node scripts/sync-vercel-redirects.mjs [--dry-run|--write|--apply]\n\n' +
				'  (padrão)  Mostra diff e NÃO grava\n' +
				'  --write   Grava vercel.json após o diff\n' +
				'  --apply   Alias de --write\n',
		);
		return;
	}

	const vercel = JSON.parse(readFileSync(vercelPath, 'utf8'));
	const before = Array.isArray(vercel.redirects) ? vercel.redirects : [];
	const after = buildRedirects();

	const withSlash = after.filter((r) => r.source.endsWith('/') && !r.source.includes(':')).length;
	const withExt = after.filter((r) => /\.[a-z0-9]{1,10}$/i.test(r.source)).length;

	console.log('sync-vercel-redirects');
	console.log(
		`  wildcards: ${WILDCARD_REDIRECTS.length} | case aliases: ${CASE_ALIASES.length} | exact: ${after.length - WILDCARD_REDIRECTS.length - CASE_ALIASES.length}`,
	);
	console.log(`  sources com "/": ${withSlash} | sources com extensão: ${withExt}`);
	console.log(`  total proposto: ${after.length} (atual: ${before.length})`);

	const diff = summarizeDiff(before, after);
	printDiff(diff);

	const sampleExt = after.find((r) => /\.shtml$/i.test(r.source));
	const sampleSlash = after.find(
		(r) => r.source.endsWith('/') && !r.source.includes(':') && r.source !== '/',
	);
	console.log('Amostras:');
	if (sampleSlash) console.log(`  path:  ${sampleSlash.source} → ${sampleSlash.destination}`);
	if (sampleExt) console.log(`  file:  ${sampleExt.source} → ${sampleExt.destination}`);
	console.log('');

	if (!args.write) {
		console.log('Dry-run: vercel.json NÃO foi gravado. Use --write para aplicar.');
		return;
	}

	vercel.redirects = after;
	writeFileSync(vercelPath, `${JSON.stringify(vercel, null, '\t')}\n`);
	console.log(
		`✓ Gravado ${path.relative(ROOT, vercelPath)}: ${after.length} redirects.`,
	);
}

main();
