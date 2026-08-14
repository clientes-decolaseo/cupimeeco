/**
 * Aplica noindex em conteúdos off-topic confirmados manualmente.
 *
 * Pré-requisito: coluna `confirmado_offtopic` (sim|nao) em
 * off-topic-content-report.csv, preenchida após revisão de
 * off-topic-context-review.md.
 *
 * Para linhas com confirmado_offtopic=sim e tem_noindex=false:
 *   1) seo.robots=true (WP JSON) ou frontmatter noindex (astro/md/mdx)
 *   2) path entra em src/data/seo/offtopic-policy.json → noindex
 *      (mesmo mecanismo dos hubs finos em seo-policy.ts / sitemap)
 *
 * Uso:
 *   node scripts/apply-offtopic-noindex.mjs           # dry-run
 *   node scripts/apply-offtopic-noindex.mjs --dry-run
 *   node scripts/apply-offtopic-noindex.mjs --apply
 *   node scripts/apply-offtopic-noindex.mjs --apply --skip-build
 *
 * Nunca deleta nem renomeia arquivos.
 */
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const DEFAULT_CSV = path.join(ROOT, 'off-topic-content-report.csv');
const POLICY_PATH = path.join(ROOT, 'src', 'data', 'seo', 'offtopic-policy.json');

const SITEMAP_DIRS = [
	path.join(ROOT, 'dist'),
	path.join(ROOT, 'dist', 'client'),
	path.join(ROOT, '.vercel', 'output', 'static'),
];

function parseArgs(argv) {
	const args = {
		apply: false,
		dryRun: true,
		skipBuild: false,
		csv: DEFAULT_CSV,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--apply') {
			args.apply = true;
			args.dryRun = false;
		} else if (a === '--dry-run') {
			args.dryRun = true;
			args.apply = false;
		} else if (a === '--skip-build') {
			args.skipBuild = true;
		} else if (a === '--csv' && argv[i + 1]) {
			args.csv = path.resolve(argv[++i]);
		} else if (a === '--help' || a === '-h') {
			args.help = true;
		}
	}
	return args;
}

async function pathExists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
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

	if (cell.length > 0 || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}

	return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

function rowsToObjects(matrix) {
	if (matrix.length === 0) return [];
	const headers = matrix[0].map((h) => String(h).trim());
	return matrix.slice(1).map((cells) => {
		const obj = {};
		for (let i = 0; i < headers.length; i++) obj[headers[i]] = cells[i] ?? '';
		return obj;
	});
}

function normalizePathKey(raw) {
	let s = String(raw ?? '').trim();
	if (!s) return '';
	try {
		if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
	} catch {
		/* keep */
	}
	return s.replace(/^\/+|\/+$/g, '').toLowerCase();
}

function normalizeConfirmado(value) {
	const v = String(value ?? '')
		.trim()
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '');
	if (v === 'sim' || v === 'yes' || v === 'true' || v === '1') return 'sim';
	if (v === 'nao' || v === 'no' || v === 'false' || v === '0') return 'nao';
	return v;
}

function isTemNoindexFalse(value) {
	return String(value ?? '').trim().toLowerCase() === 'false';
}

/** Espelha apply-city-decisions.mjs */
function applyNoindexWpJson(raw) {
	const data = JSON.parse(raw);
	if (!data.seo || typeof data.seo !== 'object') data.seo = {};
	const before = data.seo.robots;
	if (before === true) {
		return { changed: false, before, after: true, next: raw, note: 'ja_noindex' };
	}
	data.seo.robots = true;
	const next = `${JSON.stringify(data, null, 2)}\n`;
	return { changed: true, before, after: true, next, note: 'seo.robots: true' };
}

function applyNoindexFrontmatter(raw) {
	const text = String(raw);
	const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)([\s\S]*)$/);

	if (fmMatch) {
		let fm = fmMatch[1];
		if (/^noindex\s*:\s*true\s*$/im.test(fm)) {
			return {
				changed: false,
				before: 'noindex: true',
				after: 'noindex: true',
				next: text,
				note: 'ja_noindex',
			};
		}
		if (/^noindex\s*:/im.test(fm)) {
			fm = fm.replace(/^noindex\s*:.*$/im, 'noindex: true');
		} else {
			fm = `${fm.replace(/\s+$/, '')}\nnoindex: true`;
		}
		const next = `---\n${fm}\n---${fmMatch[2]}${fmMatch[3]}`;
		return {
			changed: next !== text,
			before: '(frontmatter)',
			after: 'noindex: true',
			next,
			note: 'frontmatter noindex: true',
		};
	}

	const next = `---\nnoindex: true\n---\n${text}`;
	return {
		changed: true,
		before: '(sem frontmatter)',
		after: 'noindex: true',
		next,
		note: 'frontmatter criado',
	};
}

function detectKind(relPath) {
	const ext = path.extname(relPath).toLowerCase();
	if (ext === '.json') return 'wp-json';
	if (ext === '.astro' || ext === '.md' || ext === '.mdx') return 'frontmatter';
	return 'unknown';
}

async function writeOfftopicPolicy(pathKeys) {
	let existing = {
		generatedAt: null,
		cluster: 'offtopic',
		stats: { redirects: 0, noindex: 0 },
		redirects: {},
		noindex: [],
	};

	if (await pathExists(POLICY_PATH)) {
		try {
			existing = JSON.parse(await readFile(POLICY_PATH, 'utf8'));
		} catch {
			/* keep default */
		}
	}

	const merged = new Set([
		...(existing.noindex ?? []).map((p) => normalizePathKey(p)),
		...pathKeys.map((p) => normalizePathKey(p)).filter(Boolean),
	]);
	const noindex = [...merged].filter(Boolean).sort((a, b) => a.localeCompare(b));

	const payload = {
		generatedAt: new Date().toISOString(),
		cluster: 'offtopic',
		stats: {
			redirects: Object.keys(existing.redirects ?? {}).length,
			noindex: noindex.length,
		},
		redirects: existing.redirects ?? {},
		noindex,
	};

	await writeFile(POLICY_PATH, `${JSON.stringify(payload, null, '\t')}\n`, 'utf8');
	return payload;
}

async function collectSitemapFiles(dir, acc = []) {
	if (!(await pathExists(dir))) return acc;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue;
			await collectSitemapFiles(full, acc);
			continue;
		}
		if (/^sitemap.*\.xml$/i.test(entry.name)) acc.push(full);
	}
	return acc;
}

async function loadSitemapUrlKeys() {
	const files = [];
	for (const dir of SITEMAP_DIRS) {
		await collectSitemapFiles(dir, files);
	}
	const keys = new Set();
	for (const file of files) {
		const xml = await readFile(file, 'utf8');
		for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
			const key = normalizePathKey(m[1]);
			if (key) keys.add(key);
		}
	}
	return { files, keys };
}

function countTargetsInSitemap(targetKeys, sitemapKeys) {
	let present = 0;
	const still = [];
	for (const k of targetKeys) {
		if (sitemapKeys.has(k)) {
			present++;
			still.push(k);
		}
	}
	return { present, still };
}

function regenerateSitemap() {
	console.log('\nRegenerando sitemap (astro build)…\n');
	const result = spawnSync('npx', ['astro', 'build'], {
		cwd: ROOT,
		encoding: 'utf8',
		shell: true,
		stdio: 'inherit',
		env: { ...process.env },
	});
	return result.status === 0;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(
			'Uso:\n' +
				'  node scripts/apply-offtopic-noindex.mjs [--dry-run|--apply] [--skip-build]\n\n' +
				'Exige coluna confirmado_offtopic (sim|nao) no CSV.\n' +
				'Dry-run padrão. --apply grava noindex + offtopic-policy.json e regenera sitemap.\n' +
				'Nunca deleta nem renomeia arquivos.',
		);
		return;
	}

	console.log('apply-offtopic-noindex\n');
	console.log(`Modo: ${args.apply ? '--apply' : '--dry-run'}`);
	console.log(`CSV:  ${path.relative(ROOT, args.csv)}\n`);

	if (!(await pathExists(args.csv))) {
		console.error(`❌ Não encontrei ${path.relative(ROOT, args.csv)}`);
		process.exitCode = 1;
		return;
	}

	const objects = rowsToObjects(parseCsv(await readFile(args.csv, 'utf8')));
	if (!objects.length) {
		console.error('❌ CSV vazio.');
		process.exitCode = 1;
		return;
	}

	if (!('confirmado_offtopic' in objects[0])) {
		console.error(
			'❌ Coluna "confirmado_offtopic" ausente em off-topic-content-report.csv.\n' +
				'   Adicione a coluna e preencha sim|nao com base em off-topic-context-review.md.\n' +
				`   Colunas atuais: ${Object.keys(objects[0]).join(', ')}`,
		);
		process.exitCode = 1;
		return;
	}

	const counts = {
		sim_pendente: 0,
		sim_ja_noindex: 0,
		nao: 0,
		vazio: 0,
		invalido: 0,
		missing_file: 0,
	};

	/** @type {{ rel: string, abs: string, pathKey: string, kind: string, result: object }[]} */
	const toChange = [];
	/** @type {string[]} */
	const policyPaths = [];
	/** @type {string[]} */
	const already = [];
	/** @type {string[]} */
	const missing = [];

	for (const row of objects) {
		const confirmado = normalizeConfirmado(row.confirmado_offtopic);

		if (!confirmado) {
			counts.vazio++;
			continue;
		}
		if (confirmado === 'nao') {
			counts.nao++;
			continue;
		}
		if (confirmado !== 'sim') {
			counts.invalido++;
			console.warn(`⚠ confirmado_offtopic inválido: ${JSON.stringify(row.confirmado_offtopic)} (${row.arquivo})`);
			continue;
		}

		if (!isTemNoindexFalse(row.tem_noindex)) {
			counts.sim_ja_noindex++;
			const pk = normalizePathKey(row.url_path);
			if (pk) policyPaths.push(pk);
			continue;
		}

		counts.sim_pendente++;
		const rel = String(row.arquivo || '').replace(/\\/g, '/').trim();
		const pathKey = normalizePathKey(row.url_path);
		if (!rel || !pathKey) {
			missing.push(rel || row.url_path || '(linha sem arquivo/url)');
			counts.missing_file++;
			continue;
		}

		const abs = path.join(ROOT, rel);
		if (!(await pathExists(abs))) {
			missing.push(rel);
			counts.missing_file++;
			continue;
		}

		policyPaths.push(pathKey);

		const kind = detectKind(rel);
		if (kind === 'unknown') {
			console.warn(`⚠ tipo de arquivo não suportado para noindex: ${rel}`);
			continue;
		}

		const raw = await readFile(abs, 'utf8');
		const result = kind === 'wp-json' ? applyNoindexWpJson(raw) : applyNoindexFrontmatter(raw);

		if (!result.changed) {
			already.push(`${rel} (${result.note})`);
			continue;
		}

		toChange.push({ rel, abs, pathKey, kind, result });
	}

	const uniquePolicyPaths = [...new Set(policyPaths)];

	console.log('=== Planejamento ===\n');
	console.log(`confirmado=sim + tem_noindex=false (alvo): ${counts.sim_pendente}`);
	console.log(`  → arquivos a alterar:                 ${toChange.length}`);
	console.log(`  → já noindex no arquivo:              ${already.length}`);
	console.log(`  → arquivo ausente:                    ${counts.missing_file}`);
	console.log(`confirmado=sim + já tem_noindex=true:   ${counts.sim_ja_noindex}`);
	console.log(`confirmado=nao (noop):                  ${counts.nao}`);
	console.log(`confirmado vazio:                       ${counts.vazio}`);
	console.log(`confirmado inválido:                    ${counts.invalido}`);
	console.log(`paths p/ offtopic-policy.noindex:       ${uniquePolicyPaths.length}`);

	if (missing.length) {
		console.log('\nArquivos ausentes (até 20):');
		for (const m of missing.slice(0, 20)) console.log(`  · ${m}`);
	}

	if (toChange.length) {
		console.log('\n=== Diffs (noindex) ===\n');
		for (const item of toChange) {
			const before =
				item.kind === 'wp-json'
					? `seo.robots: ${JSON.stringify(item.result.before)}`
					: String(item.result.before);
			const after =
				item.kind === 'wp-json' ? 'seo.robots: true' : String(item.result.after);
			console.log(`--- ${item.rel}`);
			console.log(`- ${before}`);
			console.log(`+ ${after}`);
			console.log(`  (${item.result.note}) path=${item.pathKey}\n`);
		}
	} else {
		console.log('\n(nenhuma alteração de arquivo pendente)\n');
	}

	console.log('Policy offtopic (merge proposto):');
	for (const p of uniquePolicyPaths.slice(0, 30)) console.log(`  · ${p}`);
	if (uniquePolicyPaths.length > 30) {
		console.log(`  · … +${uniquePolicyPaths.length - 30}`);
	}

	if (!args.apply) {
		console.log('\nDry-run: nenhum arquivo escrito. Use --apply para gravar.');
		console.log('Nenhum arquivo foi deletado ou renomeado.\n');
		return;
	}

	const beforeSitemap = await loadSitemapUrlKeys();
	const beforeCount = countTargetsInSitemap(uniquePolicyPaths, beforeSitemap.keys);
	console.log(
		`\nSitemap antes: ${beforeSitemap.files.length} arquivo(s), ` +
			`${beforeSitemap.keys.size} URLs; alvos presentes: ${beforeCount.present}/${uniquePolicyPaths.length}`,
	);

	let written = 0;
	for (const item of toChange) {
		await writeFile(item.abs, item.result.next, 'utf8');
		written++;
	}

	const policy = await writeOfftopicPolicy(uniquePolicyPaths);
	console.log(
		`\n✓ Arquivos noindex gravados: ${written}` +
			`\n✓ Policy: ${path.relative(ROOT, POLICY_PATH)} (noindex=${policy.noindex.length})`,
	);

	if (args.skipBuild) {
		console.log('\n--skip-build: sitemap não regenerado. Rode `npm run build` depois.');
		console.log('Nenhum arquivo foi deletado ou renomeado.\n');
		return;
	}

	const ok = regenerateSitemap();
	if (!ok) {
		console.error('\n❌ astro build falhou — policy/arquivos já gravados; sitemap pode estar desatualizado.');
		process.exitCode = 1;
		return;
	}

	const afterSitemap = await loadSitemapUrlKeys();
	const afterCount = countTargetsInSitemap(uniquePolicyPaths, afterSitemap.keys);
	const removed = beforeCount.present - afterCount.present;

	console.log('\n=== Sitemap (pós-build) ===\n');
	console.log(`URLs totais no sitemap: ${afterSitemap.keys.size}`);
	console.log(`Alvos off-topic ainda no sitemap: ${afterCount.present}/${uniquePolicyPaths.length}`);
	console.log(
		`Saíram da contagem (vs sitemap anterior): ${removed >= 0 ? removed : 0}` +
			(beforeSitemap.keys.size === 0 ? ' (sem baseline prévia em dist/)' : ''),
	);

	if (afterCount.still.length) {
		console.log('\nAinda presentes no sitemap (revisar):');
		for (const k of afterCount.still.slice(0, 20)) console.log(`  · /${k}/`);
	} else {
		console.log('\n✓ Nenhum alvo confirmado permanece no sitemap.');
	}

	console.log('\nNenhum arquivo foi deletado ou renomeado.\n');
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
