/**
 * Remove redirects com mismatch de tipo de praga (pest-type-mismatch-report.csv)
 * das policies SEO e regenera vercel.json.
 *
 * 1) Lê pest-type-mismatch-report.csv
 * 2) Remove url_origem das policies (gsc-404-policy.json e demais policies
 *    do redirect-map — senão o sync recoloca no vercel.json)
 * 3) Roda sync-vercel-redirects.mjs --write
 * 4) Diff de contagens + lista "requer nova decisão"
 *
 * Uso:
 *   node scripts/revert-mismatched-redirects.mjs           # dry-run
 *   node scripts/revert-mismatched-redirects.mjs --write   # grava + sync
 *   node scripts/revert-mismatched-redirects.mjs --apply   # alias de --write
 *
 * Nunca deleta arquivos de conteúdo — só remove chaves de redirects nas policies.
 */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizePathKey } from './lib/redirect-map.mjs';

const ROOT = path.resolve('.');
const CSV_PATH = path.join(ROOT, 'pest-type-mismatch-report.csv');
const VERCEL_PATH = path.join(ROOT, 'vercel.json');

/** Policies lidas por scripts/lib/redirect-map.mjs (exceto as só-noindex). */
const POLICY_FILES = [
	path.join(ROOT, 'src', 'data', 'seo', 'gsc-404-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'duplicates-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'cupim-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'dedetizacao-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'deratizacao-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'sanitizacao-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'mosquitos-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'fora-area-policy.json'),
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
	} catch {
		/* keep */
	}
	return normalizePathKey(s);
}

async function loadMismatchOrigins() {
	const matrix = parseCsv(await readFile(CSV_PATH, 'utf8'));
	if (matrix.length < 2) return [];

	const headers = matrix[0].map((h) => String(h).trim());
	const idxOrigem = headers.indexOf('url_origem');
	const idxDest = headers.indexOf('url_destino');
	const idxCatO = headers.indexOf('categoria_origem');
	const idxCatD = headers.indexOf('categoria_destino');

	/** @type {{ key: string, url_origem: string, url_destino: string, categoria_origem: string, categoria_destino: string }[]} */
	const items = [];
	const seen = new Set();

	for (const cells of matrix.slice(1)) {
		const urlOrigem = cells[idxOrigem] ?? '';
		const key = toOriginKey(urlOrigem);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		items.push({
			key,
			url_origem: urlOrigem,
			url_destino: cells[idxDest] ?? '',
			categoria_origem: cells[idxCatO] ?? '',
			categoria_destino: cells[idxCatD] ?? '',
		});
	}

	return items;
}

async function countVercelRedirects() {
	const vercel = JSON.parse(await readFile(VERCEL_PATH, 'utf8'));
	return Array.isArray(vercel.redirects) ? vercel.redirects.length : 0;
}

async function countGscRedirects() {
	const gsc = JSON.parse(
		await readFile(path.join(ROOT, 'src', 'data', 'seo', 'gsc-404-policy.json'), 'utf8'),
	);
	return Object.keys(gsc.redirects ?? {}).length;
}

/**
 * Remove keys das policies; retorna log por origem.
 */
async function removeFromPolicies(origins, { write }) {
	/** @type {Map<string, string[]>} origem → policies onde foi removido */
	const removedAt = new Map();
	/** @type {string[]} */
	const notFound = [];

	for (const item of origins) {
		removedAt.set(item.key, []);
	}

	for (const policyPath of POLICY_FILES) {
		const raw = await readFile(policyPath, 'utf8');
		const data = JSON.parse(raw);
		const redirects = { ...(data.redirects ?? {}) };
		let changed = false;
		const rel = path.relative(ROOT, policyPath);

		for (const item of origins) {
			if (Object.prototype.hasOwnProperty.call(redirects, item.key)) {
				delete redirects[item.key];
				changed = true;
				removedAt.get(item.key).push(rel);
			}
		}

		if (!changed) continue;

		if (write) {
			data.redirects = Object.fromEntries(
				Object.entries(redirects).sort(([a], [b]) => a.localeCompare(b)),
			);
			if (data.stats && typeof data.stats === 'object') {
				data.stats = {
					...data.stats,
					redirects: Object.keys(data.redirects).length,
				};
			}
			await writeFile(policyPath, `${JSON.stringify(data, null, '\t')}\n`, 'utf8');
		}
	}

	for (const item of origins) {
		if ((removedAt.get(item.key) ?? []).length === 0) {
			notFound.push(item.key);
		}
	}

	return { removedAt, notFound };
}

function runSyncWrite() {
	console.log('\nRodando sync-vercel-redirects.mjs --write…\n');
	const result = spawnSync(
		process.execPath,
		[path.join(ROOT, 'scripts', 'sync-vercel-redirects.mjs'), '--write'],
		{ cwd: ROOT, encoding: 'utf8', stdio: 'inherit' },
	);
	return result.status === 0;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(
			'Uso: node scripts/revert-mismatched-redirects.mjs [--dry-run|--write|--apply]\n\n' +
				'Remove origens de pest-type-mismatch-report.csv das policies e regenera vercel.json.\n',
		);
		return;
	}

	console.log('revert-mismatched-redirects');
	console.log(`Modo: ${args.write ? '--write' : '--dry-run'}\n`);

	const origins = await loadMismatchOrigins();
	if (!origins.length) {
		console.error('Nenhuma url_origem em pest-type-mismatch-report.csv.');
		process.exitCode = 1;
		return;
	}

	const vercelBefore = await countVercelRedirects();
	const gscBefore = await countGscRedirects();

	console.log(`Mismatch no CSV: ${origins.length}`);
	console.log(`gsc-404-policy redirects (antes): ${gscBefore}`);
	console.log(`vercel.json redirects (antes):   ${vercelBefore}\n`);

	const { removedAt, notFound } = await removeFromPolicies(origins, {
		write: args.write,
	});

	let removedFromGsc = 0;
	let removedFromOther = 0;

	console.log('=== Remoções por origem ===\n');
	for (const item of origins) {
		const policies = removedAt.get(item.key) ?? [];
		if (!policies.length) {
			console.log(`  ✗ ${item.key} — não encontrado em nenhuma policy`);
			continue;
		}
		const inGsc = policies.some((p) => p.includes('gsc-404-policy'));
		if (inGsc) removedFromGsc++;
		if (policies.some((p) => !p.includes('gsc-404-policy'))) removedFromOther++;
		console.log(
			`  ✓ ${item.key}  (${item.categoria_origem}→${item.categoria_destino})`,
		);
		console.log(`      policies: ${policies.join(', ')}`);
	}

	if (notFound.length) {
		console.log(`\nNão encontrados em policies: ${notFound.length}`);
	}

	console.log(`\nRemovidos de gsc-404-policy: ${removedFromGsc}`);
	console.log(`Removidos também de outras policies: ${removedFromOther}`);

	if (!args.write) {
		console.log(
			'\nDry-run: policies e vercel.json NÃO foram alterados.\n' +
				'Use --write para gravar e regenerar vercel.json.',
		);
		console.log('\n=== Requer nova decisão (após --write) ===\n');
		for (const item of origins) {
			console.log(
				`  requer nova decisão: redirect correto ou sem_equivalente_410 — ${item.url_origem} (era → ${item.url_destino})`,
			);
		}
		return;
	}

	const ok = runSyncWrite();
	if (!ok) {
		console.error('\n❌ sync-vercel-redirects falhou (policies já foram editadas).');
		process.exitCode = 1;
		return;
	}

	const vercelAfter = await countVercelRedirects();
	const gscAfter = await countGscRedirects();

	console.log('\n=== Diff contagens ===\n');
	console.log(`gsc-404-policy: ${gscBefore} → ${gscAfter}  (Δ ${gscAfter - gscBefore})`);
	console.log(`vercel.json:    ${vercelBefore} → ${vercelAfter}  (Δ ${vercelAfter - vercelBefore})`);

	console.log('\n=== Requer nova decisão ===\n');
	for (const item of origins) {
		console.log(
			`  requer nova decisão: redirect correto ou sem_equivalente_410 — ${item.url_origem} (era → ${item.url_destino})`,
		);
	}
	console.log('');
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
