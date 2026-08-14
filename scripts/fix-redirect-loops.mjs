/**
 * Corrige loops/cadeias com base em redirect-loops-report.csv revisado.
 *
 * Coluna obrigatória: direcao_correta = URL destino final do par.
 * A outra URL do par passa a apontar para ela; a URL correta deixa de
 * apontar de volta para a errada (chave removida se era o reverse do loop).
 *
 * Uso:
 *   node scripts/fix-redirect-loops.mjs           # dry-run
 *   node scripts/fix-redirect-loops.mjs --apply  # grava + sync + re-detect
 *   node scripts/fix-redirect-loops.mjs --write  # alias de --apply
 *
 * Não altera conteúdo de páginas — só redirects nas policies.
 */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
	formatRedirectSource,
	normalizePathKey,
	normalizeRedirectDestination,
} from './lib/redirect-map.mjs';

const ROOT = path.resolve('.');
const CSV_PATH = path.join(ROOT, 'redirect-loops-report.csv');

/** Policies consumidas por redirect-map (podem conter as arestas). */
const POLICY_FILES = [
	path.join(ROOT, 'src', 'data', 'seo', 'gsc-404-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'duplicates-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'hub-thin-policy.json'),
	path.join(ROOT, 'src', 'data', 'seo', 'offtopic-policy.json'),
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

function toKey(raw) {
	let s = String(raw ?? '').trim();
	if (!s) return '';
	try {
		if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
	} catch {
		/* keep */
	}
	return normalizePathKey(s);
}

function displayPath(key) {
	if (!key) return '/';
	return formatRedirectSource(key);
}

/**
 * Encontra a chave literal no objeto redirects (match por normalizePathKey).
 * @returns {string|null}
 */
function findRedirectKey(redirects, wantKey) {
	if (Object.prototype.hasOwnProperty.call(redirects, wantKey)) return wantKey;
	for (const k of Object.keys(redirects)) {
		if (normalizePathKey(k) === wantKey) return k;
	}
	return null;
}

/**
 * @returns {Promise<{ rows: object[], skipped: object[], errors: string[] }>}
 */
async function loadReviewedRows() {
	const matrix = parseCsv(await readFile(CSV_PATH, 'utf8'));
	if (matrix.length < 2) {
		return { rows: [], skipped: [], errors: ['CSV vazio ou só cabeçalho.'] };
	}

	const headers = matrix[0].map((h) => String(h).trim());
	const idxA = headers.indexOf('url_a');
	const idxB = headers.indexOf('url_b');
	const idxTipo = headers.indexOf('tipo');
	const idxDir = headers.indexOf('direcao_correta');

	/** @type {string[]} */
	const errors = [];
	if (idxA < 0 || idxB < 0) errors.push('CSV precisa de colunas url_a e url_b.');
	if (idxDir < 0) {
		errors.push(
			'CSV precisa da coluna direcao_correta (preencha com o destino final de cada par).',
		);
	}
	if (errors.length) return { rows: [], skipped: [], errors };

	/** @type {object[]} */
	const rows = [];
	/** @type {object[]} */
	const skipped = [];

	for (const cells of matrix.slice(1)) {
		const urlA = String(cells[idxA] ?? '').trim();
		const urlB = String(cells[idxB] ?? '').trim();
		const tipo = String(cells[idxTipo] ?? '').trim();
		const direcao = String(cells[idxDir] ?? '').trim();
		const keyA = toKey(urlA);
		const keyB = toKey(urlB);
		const keyCorrect = toKey(direcao);

		if (!keyA || !keyB) {
			skipped.push({ urlA, urlB, reason: 'url_a/url_b inválida' });
			continue;
		}

		if (!keyCorrect) {
			skipped.push({ urlA, urlB, tipo, reason: 'direcao_correta vazia' });
			continue;
		}

		const pair = new Set([keyA, keyB]);
		// Se direcao_correta é um lado do par → o outro aponta para ela.
		// Se está fora do par (ex.: /dedetizacao/) → ambos os lados apontam para ela.
		const wrongKeys = pair.has(keyCorrect)
			? [...pair].filter((k) => k !== keyCorrect)
			: [...pair];

		rows.push({
			tipo: tipo || 'loop_direto',
			keyA,
			keyB,
			keyCorrect,
			wrongKeys,
			destination: normalizeRedirectDestination(direcao),
			direcaoForaDoPar: !pair.has(keyCorrect),
		});
	}

	return { rows, skipped, errors };
}

/**
 * Indexa em quais policies cada key aparece.
 * @returns {Promise<Map<string, { policyPath: string, literalKey: string, destination: string }[]>>}
 */
async function indexPolicies() {
	/** @type {Map<string, { policyPath: string, literalKey: string, destination: string }[]>} */
	const index = new Map();

	for (const policyPath of POLICY_FILES) {
		const data = JSON.parse(await readFile(policyPath, 'utf8'));
		const redirects = data.redirects ?? {};
		for (const [literalKey, destination] of Object.entries(redirects)) {
			const key = normalizePathKey(literalKey);
			if (!key) continue;
			const list = index.get(key) ?? [];
			list.push({ policyPath, literalKey, destination: String(destination) });
			index.set(key, list);
		}
	}

	return index;
}

/**
 * @typedef {{ policyPath: string, changes: { kind: 'set'|'delete', key: string, from?: string, to?: string }[] }} PolicyPlan
 */

/**
 * Planeja correções sem gravar.
 * @returns {{ plans: Map<string, PolicyPlan>, actions: object[], missing: string[] }}
 */
function planFixes(reviewedRows, index) {
	/** @type {Map<string, PolicyPlan>} */
	const plans = new Map();
	/** @type {object[]} */
	const actions = [];
	/** @type {string[]} */
	const missing = [];

	function ensurePlan(policyPath) {
		if (!plans.has(policyPath)) {
			plans.set(policyPath, { policyPath, changes: [] });
		}
		return plans.get(policyPath);
	}

	function locationsFor(key) {
		return index.get(key) ?? [];
	}

	for (const row of reviewedRows) {
		const correctDest = row.destination;

		for (const wrongKey of row.wrongKeys) {
			const locs = locationsFor(wrongKey);
			if (!locs.length) {
				missing.push(`${displayPath(wrongKey)} (não encontrada em nenhuma policy)`);
				continue;
			}

			for (const loc of locs) {
				const plan = ensurePlan(loc.policyPath);
				const currentDest = normalizeRedirectDestination(loc.destination);
				if (normalizePathKey(currentDest) === normalizePathKey(correctDest)) {
					actions.push({
						kind: 'noop',
						from: wrongKey,
						to: correctDest,
						policy: path.relative(ROOT, loc.policyPath),
						note: 'já aponta ao destino correto',
					});
					continue;
				}

				plan.changes.push({
					kind: 'set',
					key: loc.literalKey,
					from: loc.destination,
					to: correctDest,
				});
				actions.push({
					kind: 'set',
					from: wrongKey,
					to: correctDest,
					was: loc.destination,
					policy: path.relative(ROOT, loc.policyPath),
				});
			}
		}

		// Remove reverse: destino correto não pode apontar para a URL errada do par
		const correctLocs = locationsFor(row.keyCorrect);
		for (const loc of correctLocs) {
			const destKey = normalizePathKey(loc.destination);
			if (!row.wrongKeys.includes(destKey)) continue;

			const plan = ensurePlan(loc.policyPath);
			plan.changes.push({
				kind: 'delete',
				key: loc.literalKey,
				from: loc.destination,
			});
			actions.push({
				kind: 'delete',
				from: row.keyCorrect,
				was: loc.destination,
				policy: path.relative(ROOT, loc.policyPath),
				note: 'remove reverse do loop (destino final não redireciona)',
			});
		}
	}

	return { plans, actions, missing };
}

async function applyPlans(plans) {
	for (const plan of plans.values()) {
		if (!plan.changes.length) continue;

		const data = JSON.parse(await readFile(plan.policyPath, 'utf8'));
		const redirects = { ...(data.redirects ?? {}) };

		for (const change of plan.changes) {
			if (change.kind === 'delete') {
				const lit = findRedirectKey(redirects, normalizePathKey(change.key)) ?? change.key;
				delete redirects[lit];
			} else if (change.kind === 'set') {
				const lit = findRedirectKey(redirects, normalizePathKey(change.key)) ?? change.key;
				redirects[lit] = change.to;
			}
		}

		data.redirects = Object.fromEntries(
			Object.entries(redirects).sort(([a], [b]) => a.localeCompare(b)),
		);
		if (data.stats && typeof data.stats === 'object') {
			data.stats = {
				...data.stats,
				redirects: Object.keys(data.redirects).length,
			};
		}
		if (typeof data.generatedAt === 'string') {
			data.generatedAt = new Date().toISOString();
		}

		await writeFile(plan.policyPath, `${JSON.stringify(data, null, '\t')}\n`, 'utf8');
	}
}

function runNodeScript(relScript, scriptArgs = []) {
	const result = spawnSync(
		process.execPath,
		[path.join(ROOT, relScript), ...scriptArgs],
		{ cwd: ROOT, encoding: 'utf8', stdio: 'inherit' },
	);
	return result.status === 0;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(
			'Uso:\n' +
				'  node scripts/fix-redirect-loops.mjs           # dry-run\n' +
				'  node scripts/fix-redirect-loops.mjs --apply  # grava + sync + detect\n\n' +
				'Lê redirect-loops-report.csv (coluna direcao_correta) e corrige policies.\n',
		);
		return;
	}

	console.log('fix-redirect-loops');
	console.log(`Modo: ${args.write ? '--apply' : '--dry-run'}\n`);

	const { rows, skipped, errors } = await loadReviewedRows();
	if (errors.length) {
		for (const e of errors) console.error(`❌ ${e}`);
		process.exitCode = 1;
		return;
	}

	if (skipped.length) {
		console.log(`Linhas ignoradas (sem direcao_correta): ${skipped.length}`);
		for (const s of skipped.slice(0, 20)) {
			console.log(`  · ${s.urlA} | ${s.urlB} — ${s.reason}`);
		}
		console.log('');
	}

	if (!rows.length) {
		console.error(
			'Nenhuma linha com direcao_correta preenchida. Preencha o CSV e rode de novo.',
		);
		process.exitCode = 1;
		return;
	}

	const index = await indexPolicies();
	const { plans, actions, missing } = planFixes(rows, index);

	console.log(`Pares a corrigir: ${rows.length}`);
	console.log(`Ações planejadas: ${actions.filter((a) => a.kind !== 'noop').length}`);
	console.log('');

	for (const a of actions) {
		if (a.kind === 'set') {
			console.log(
				`  SET  ${displayPath(a.from)} → ${a.to}  (era ${a.was})  [${a.policy}]`,
			);
		} else if (a.kind === 'delete') {
			console.log(
				`  DEL  ${displayPath(a.from)} → ${a.was}  [${a.policy}]${a.note ? ` — ${a.note}` : ''}`,
			);
		} else {
			console.log(`  OK   ${displayPath(a.from)} → ${a.to}  [${a.policy}] — ${a.note}`);
		}
	}

	if (missing.length) {
		console.log('\nNão encontradas:');
		for (const m of missing) console.log(`  · ${m}`);
	}

	const policiesTouched = [...plans.values()].filter((p) => p.changes.length);
	console.log(`\nPolicies afetadas: ${policiesTouched.length}`);
	for (const p of policiesTouched) {
		console.log(`  · ${path.relative(ROOT, p.policyPath)} (${p.changes.length} mudanças)`);
	}

	if (!args.write) {
		console.log('\nDry-run — nada gravado. Use --apply para aplicar.');
		return;
	}

	console.log('\nGravando policies…');
	await applyPlans(plans);

	console.log('\nRodando sync-vercel-redirects.mjs --write…\n');
	if (!runNodeScript('scripts/sync-vercel-redirects.mjs', ['--write'])) {
		console.error('❌ sync-vercel-redirects falhou.');
		process.exitCode = 1;
		return;
	}

	console.log('\nRodando detect-redirect-loops.mjs…\n');
	if (!runNodeScript('scripts/detect-redirect-loops.mjs')) {
		console.error('❌ detect-redirect-loops falhou.');
		process.exitCode = 1;
		return;
	}

	// Confirma 0 loops no CSV gerado
	const report = parseCsv(await readFile(CSV_PATH, 'utf8'));
	const headers = report[0]?.map((h) => String(h).trim()) ?? [];
	const idxTipo = headers.indexOf('tipo');
	let loops = 0;
	let chains = 0;
	for (const cells of report.slice(1)) {
		const tipo = String(cells[idxTipo] ?? '').trim();
		if (tipo === 'loop_direto' || tipo === 'loop_indireto') loops += 1;
		if (tipo === 'cadeia_longa') chains += 1;
	}

	console.log(`\nPós-aplicação: loops=${loops} cadeias_longas=${chains}`);
	if (loops > 0) {
		console.error('❌ Ainda há loops em redirect-loops-report.csv.');
		process.exitCode = 1;
		return;
	}

	console.log('✓ 0 loops diretos/indiretos.');
	if (chains > 0) {
		console.log(
			`⚠ ${chains} cadeia(s) longa(s) restante(s) — preencha direcao_correta nessas linhas e rode --apply de novo.`,
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
