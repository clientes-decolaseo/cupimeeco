/**
 * Aplica decisões do 404-matching-report.csv:
 *   - redirect_301 → policy SEO + regenera vercel.json redirects
 *   - sem_equivalente_410 → lista urls-410.txt (sem handler ainda)
 *
 * Uso:
 *   node scripts/apply-404-fixes.mjs           # dry-run (padrão)
 *   node scripts/apply-404-fixes.mjs --apply
 *
 * Nunca deleta páginas de conteúdo. Não implementa resposta 410.
 */
import { spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildRedirectMap, normalizePathKey, normalizeRedirectDestination, formatRedirectSource } from './lib/redirect-map.mjs';

const ROOT = path.resolve('.');
const CSV_PATH = path.join(ROOT, '404-matching-report.csv');
const VERCEL_PATH = path.join(ROOT, 'vercel.json');
const POLICY_PATH = path.join(ROOT, 'src', 'data', 'seo', 'gsc-404-policy.json');
const OUT_410 = path.join(ROOT, 'urls-410.txt');

/** Wildcards — espelha scripts/sync-vercel-redirects.mjs */
const WILDCARD_REDIRECTS = [
	{ source: '/d/:path*', destination: '/:path*', permanent: true },
	{ source: '/glossario/:path*', destination: '/blog/', permanent: true },
];

const CASE_ALIASES = [
	{
		source: '/dedetizadora-em-Cotia/',
		destination: '/dedetizadora-em-cotia/',
		permanent: true,
	},
];

function parseArgs(argv) {
	return {
		apply: argv.includes('--apply'),
		help: argv.includes('--help') || argv.includes('-h'),
	};
}

async function pathExists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

function assertCleanGit() {
	if (process.env.NORMALIZE_ALLOW_DIRTY === '1') {
		console.log('⚠ NORMALIZE_ALLOW_DIRTY=1 — pulando checagem de working tree limpo\n');
		return;
	}
	const result = spawnSync('git', ['status', '--porcelain'], {
		cwd: ROOT,
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		console.error('❌ Falha ao rodar `git status --porcelain`.');
		process.exit(1);
	}
	const dirty = String(result.stdout || '').trim();
	if (dirty) {
		const lines = dirty.split(/\r?\n/).slice(0, 20);
		console.error(
			'\n❌ Repositório com mudanças não commitadas. Abortando.\n\n' +
				lines.map((l) => `     ${l}`).join('\n') +
				'\n',
		);
		process.exit(1);
	}
	console.log('✓ git working tree limpo\n');
}

function gitAdd(relPath) {
	const result = spawnSync('git', ['add', '--', relPath], {
		cwd: ROOT,
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		throw new Error(`git add falhou para ${relPath}: ${result.stderr || result.stdout || ''}`);
	}
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
	if (cell.length || row.length) {
		row.push(cell);
		rows.push(row);
	}
	if (!rows.length) return [];
	const headers = rows[0].map((h) => String(h).trim());
	return rows
		.slice(1)
		.filter((r) => r.some((x) => String(x ?? '').trim()))
		.map((cols) => {
			/** @type {Record<string, string>} */
			const o = {};
			headers.forEach((h, i) => {
				o[h] = cols[i] ?? '';
			});
			return o;
		});
}

function urlToSourceKey(url) {
	let s = String(url ?? '').trim();
	try {
		if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
	} catch {
		/* keep */
	}
	return normalizePathKey(s);
}

function buildPolicyFromCsv(rows) {
	/** @type {Record<string, string>} */
	const redirects = {};
	/** @type {string[]} */
	const urls410 = [];
	/** @type {{ from: string, to: string, url: string }[]} */
	const planned301 = [];
	/** @type {string[]} */
	const skipped301 = [];

	for (const row of rows) {
		const acao = String(row.acao_sugerida ?? '').trim().toLowerCase();
		const url = String(row.url_404 ?? '').trim();
		if (!url) continue;

		if (acao === 'sem_equivalente_410') {
			urls410.push(url);
			continue;
		}

		if (acao !== 'redirect_301') continue;

		const from = urlToSourceKey(url);
		const to = normalizeRedirectDestination(String(row.melhor_candidato_atual ?? '').trim());
		if (!from) {
			skipped301.push(`${url} (origem inválida)`);
			continue;
		}
		if (!to || to === '/') {
			// destino vazio ou só "/" — ainda pode ser válido, mas exige candidato
			if (!String(row.melhor_candidato_atual ?? '').trim()) {
				skipped301.push(`${url} (sem melhor_candidato_atual)`);
				continue;
			}
		}
		redirects[from] = to;
		planned301.push({ from, to, url });
	}

	urls410.sort((a, b) => a.localeCompare(b));

	const policy = {
		generatedAt: new Date().toISOString(),
		cluster: 'gsc-404',
		stats: { redirects: Object.keys(redirects).length },
		redirects: Object.fromEntries(
			Object.entries(redirects).sort(([a], [b]) => a.localeCompare(b)),
		),
		noindex: [],
	};

	return { policy, planned301, urls410, skipped301 };
}

/**
 * Simula vercel.redirects após incluir a policy gsc-404 no mapa.
 * (buildRedirectMap ainda não importa gsc-404 até o --apply atualizar o código;
 *  aqui mesclamos manualmente por cima.)
 */
function buildProposedVercelRedirects(vercel, gscRedirects) {
	const map = buildRedirectMap();
	for (const [from, to] of Object.entries(gscRedirects)) {
		map.set(normalizePathKey(from), normalizeRedirectDestination(to));
	}

	const exactRedirects = [...map.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([from, to]) => ({
			source: formatRedirectSource(from),
			destination: normalizeRedirectDestination(to),
			permanent: true,
		}));

	return [...WILDCARD_REDIRECTS, ...CASE_ALIASES, ...exactRedirects];
}

function redirectKey(r) {
	return `${r.source}\t${r.destination}\t${r.permanent ? '1' : '0'}`;
}

function diffRedirects(beforeList, afterList) {
	const before = new Map(beforeList.map((r) => [r.source, r]));
	const after = new Map(afterList.map((r) => [r.source, r]));

	/** @type {string[]} */
	const lines = [];
	let added = 0;
	let changed = 0;
	let removed = 0;

	for (const [source, r] of after) {
		const prev = before.get(source);
		if (!prev) {
			lines.push(`+ ${r.source} → ${r.destination}`);
			added += 1;
		} else if (redirectKey(prev) !== redirectKey(r)) {
			lines.push(`~ ${r.source}\n    - ${prev.destination}\n    + ${r.destination}`);
			changed += 1;
		}
	}
	for (const [source, r] of before) {
		if (!after.has(source)) {
			// sync rebuilds entire list from policies — don't treat missing wildcards oddly
			if (source.startsWith('/d/') || source.startsWith('/glossario/')) continue;
			lines.push(`- ${r.source} → ${r.destination}`);
			removed += 1;
		}
	}

	return { lines, added, changed, removed };
}

function formatUrls410(urls) {
	const header = [
		'# URLs 404 sem equivalente — candidatas a resposta HTTP 410 Gone',
		`# Gerado por scripts/apply-404-fixes.mjs em ${new Date().toISOString()}`,
		'# NÃO implementa o handler — apenas lista para revisão manual.',
		'#',
		'',
	];
	return `${header.join('\n')}${urls.join('\n')}\n`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(
			'Uso:\n' +
				'  node scripts/apply-404-fixes.mjs [--dry-run|--apply]\n\n' +
				'Dry-run padrão. --apply grava gsc-404-policy.json, regenera vercel.json e urls-410.txt.\n',
		);
		return;
	}

	console.log('🔧 apply-404-fixes\n');
	console.log(`Modo: ${args.apply ? '--apply' : '--dry-run (padrão)'}\n`);
	assertCleanGit();

	if (!(await pathExists(CSV_PATH))) {
		console.error(`❌ Não encontrei ${path.relative(ROOT, CSV_PATH)}`);
		process.exit(1);
	}

	const rows = parseCsv(await readFile(CSV_PATH, 'utf8'));
	const { policy, planned301, urls410, skipped301 } = buildPolicyFromCsv(rows);

	console.log(`CSV: ${path.relative(ROOT, CSV_PATH)} (${rows.length} linhas)`);
	console.log(`redirect_301 a aplicar:     ${planned301.length}`);
	console.log(`sem_equivalente_410 (lista): ${urls410.length}`);
	if (skipped301.length) {
		console.log(`redirect_301 ignorados:    ${skipped301.length}`);
		for (const s of skipped301.slice(0, 10)) console.log(`  · ${s}`);
	}

	const vercelRaw = await readFile(VERCEL_PATH, 'utf8');
	const vercel = JSON.parse(vercelRaw);
	const beforeRedirects = Array.isArray(vercel.redirects) ? vercel.redirects : [];
	const afterRedirects = buildProposedVercelRedirects(vercel, policy.redirects);
	const diff = diffRedirects(beforeRedirects, afterRedirects);

	console.log('\n=== Diff vercel.json → redirects ===\n');
	console.log(`Antes: ${beforeRedirects.length} regras | Depois: ${afterRedirects.length} regras`);
	console.log(`+ adicionadas: ${diff.added} | ~ alteradas: ${diff.changed} | - removidas: ${diff.removed}`);
	if (diff.lines.length) {
		console.log('');
		for (const line of diff.lines.slice(0, 80)) console.log(line);
		if (diff.lines.length > 80) console.log(`… +${diff.lines.length - 80} linhas`);
	} else {
		console.log('(sem mudanças nas regras de redirect)');
	}

	console.log('\n=== urls-410.txt (prévia) ===\n');
	for (const u of urls410.slice(0, 15)) console.log(`  ${u}`);
	if (urls410.length > 15) console.log(`  … +${urls410.length - 15}`);

	const policyJson = `${JSON.stringify(policy, null, '\t')}\n`;
	const urls410Text = formatUrls410(urls410);
	const nextVercel = {
		...vercel,
		redirects: afterRedirects,
	};
	const vercelOut = `${JSON.stringify(nextVercel, null, '\t')}\n`;

	if (!args.apply) {
		console.log('\nDry-run: nenhum arquivo escrito.');
		console.log(
			'Com --apply serão gravados:\n' +
				`  · ${path.relative(ROOT, POLICY_PATH)}\n` +
				`  · ${path.relative(ROOT, VERCEL_PATH)} (redirects regenerados)\n` +
				`  · ${path.relative(ROOT, OUT_410)}\n`,
		);
		return;
	}

	// --apply
	await writeFile(POLICY_PATH, policyJson, 'utf8');
	await writeFile(VERCEL_PATH, vercelOut, 'utf8');
	await writeFile(OUT_410, urls410Text, 'utf8');

	gitAdd(path.relative(ROOT, POLICY_PATH).replace(/\\/g, '/'));
	gitAdd(path.relative(ROOT, VERCEL_PATH).replace(/\\/g, '/'));
	gitAdd(path.relative(ROOT, OUT_410).replace(/\\/g, '/'));

	console.log('\n✓ Arquivos gravados e staged (git add). Sem commit.');
	console.log(`  Policy: ${path.relative(ROOT, POLICY_PATH)} (${Object.keys(policy.redirects).length} redirects)`);
	console.log(`  Vercel: ${path.relative(ROOT, VERCEL_PATH)} (${afterRedirects.length} redirects)`);
	console.log(`  410:    ${path.relative(ROOT, OUT_410)} (${urls410.length} URLs)`);
	console.log('\nHandler 410 NÃO foi implementado — só a lista.\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
