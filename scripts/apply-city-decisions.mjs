/**
 * Aplica decisões manuais de city-pages-audit.csv (coluna decisao_final).
 *
 * Valores de decisao_final:
 *   - noindex_temporario → marca a página com noindex (seo.robots = true no JSON WP,
 *     ou frontmatter noindex: true em .astro/.md/.mdx)
 *   - manter / consolidar → nenhuma alteração neste script (só contabiliza)
 *
 * Uso:
 *   node scripts/apply-city-decisions.mjs              # dry-run (padrão)
 *   node scripts/apply-city-decisions.mjs --dry-run
 *   node scripts/apply-city-decisions.mjs --apply
 *
 * Nunca deleta nem renomeia arquivos.
 */
import { spawnSync } from 'node:child_process';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const DEFAULT_CSV = path.join(ROOT, 'city-pages-audit.csv');
const WP_PAGES_DIR = path.join(ROOT, 'src', 'data', 'wp', 'pages');
const WP_POSTS_DIR = path.join(ROOT, 'src', 'data', 'wp', 'posts');
const SRC_PAGES = path.join(ROOT, 'src', 'pages');
const SRC_CONTENT = path.join(ROOT, 'src', 'content');

const VALID_DECISIONS = new Set(['manter', 'noindex_temporario', 'consolidar']);

function parseArgs(argv) {
	const args = {
		apply: false,
		dryRun: true,
		csv: DEFAULT_CSV,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--apply') {
			args.apply = true;
			args.dryRun = false;
		} else if (a === '--dry-run') {
			args.dryRun = true;
			args.apply = false;
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
			'\n❌ Repositório com mudanças não commitadas. Abortando por segurança.\n\n' +
				'   Faça commit ou `git stash` antes (vale para dry-run e --apply).\n\n' +
				'   Status (até 20 linhas):\n' +
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

function normalizePathKey(raw) {
	let s = String(raw ?? '').trim();
	if (!s) return '';
	try {
		if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
	} catch {
		/* keep */
	}
	s = s.split(/[?#]/)[0];
	return s.replace(/^\/+|\/+$/g, '').toLowerCase();
}

async function walkFiles(dir, exts, acc = []) {
	if (!(await pathExists(dir))) return acc;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			await walkFiles(full, exts, acc);
			continue;
		}
		if (exts.has(path.extname(entry.name).toLowerCase())) acc.push(full);
	}
	return acc;
}

/**
 * Índice path → { kind, abs, rel }
 * kind: 'wp-json' | 'astro' | 'md'
 */
async function buildPathIndex() {
	/** @type {Map<string, { kind: string, abs: string, rel: string }>} */
	const index = new Map();

	async function indexWpDir(dir) {
		if (!(await pathExists(dir))) return;
		for (const name of await readdir(dir)) {
			if (!name.endsWith('.json')) continue;
			const abs = path.join(dir, name);
			let data;
			try {
				data = JSON.parse(await readFile(abs, 'utf8'));
			} catch {
				continue;
			}
			const key = normalizePathKey(data.path || data.slug || '');
			if (!key) continue;
			const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
			index.set(key, { kind: 'wp-json', abs, rel });
		}
	}

	await indexWpDir(WP_PAGES_DIR);
	await indexWpDir(WP_POSTS_DIR);

	const staticFiles = [
		...(await walkFiles(SRC_PAGES, new Set(['.astro', '.md', '.mdx']))),
		...(await walkFiles(SRC_CONTENT, new Set(['.md', '.mdx']))),
	];

	for (const abs of staticFiles) {
		const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
		let key = '';
		if (rel.startsWith('src/pages/')) {
			key = rel
				.replace(/^src\/pages\//, '')
				.replace(/\.(astro|md|mdx)$/i, '')
				.replace(/\/index$/i, '');
		} else if (rel.startsWith('src/content/')) {
			key = rel.replace(/^src\/content\//, '').replace(/\.(md|mdx)$/i, '');
		}
		key = normalizePathKey(key);
		if (!key || index.has(key)) continue;
		const ext = path.extname(abs).toLowerCase();
		index.set(key, {
			kind: ext === '.astro' ? 'astro' : 'md',
			abs,
			rel,
		});
	}

	return index;
}

/**
 * Aplica noindex em JSON WP: seo.robots = true
 * (import-wordpress: robots true ≡ Yoast noindex; ContentLayout → BioLayout)
 */
function applyNoindexWpJson(raw) {
	const data = JSON.parse(raw);
	if (!data.seo || typeof data.seo !== 'object') data.seo = {};
	const before = data.seo.robots;
	if (before === true) {
		return { changed: false, before, after: true, next: raw, note: 'já_noindex' };
	}
	data.seo.robots = true;
	const next = `${JSON.stringify(data, null, 2)}\n`;
	return { changed: true, before, after: true, next, note: 'seo.robots: true' };
}

/**
 * Frontmatter YAML: garante `noindex: true` (layouts BioLayout / páginas estáticas).
 */
function applyNoindexFrontmatter(raw) {
	const text = String(raw);
	const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)([\s\S]*)$/);

	if (fmMatch) {
		let fm = fmMatch[1];
		if (/^noindex\s*:\s*true\s*$/im.test(fm)) {
			return { changed: false, before: 'noindex: true', after: 'noindex: true', next: text, note: 'já_noindex' };
		}
		if (/^noindex\s*:/im.test(fm)) {
			fm = fm.replace(/^noindex\s*:.*$/im, 'noindex: true');
		} else {
			fm = `${fm.replace(/\s+$/, '')}\nnoindex: true`;
		}
		const next = `---\n${fm}\n---${fmMatch[2]}${fmMatch[3]}`;
		return { changed: next !== text, before: '(frontmatter)', after: 'noindex: true', next, note: 'frontmatter noindex: true' };
	}

	// Sem frontmatter: cria um
	const next = `---\nnoindex: true\n---\n${text}`;
	return { changed: true, before: '(sem frontmatter)', after: 'noindex: true', next, note: 'frontmatter criado' };
}

function formatDiff(rel, beforeDesc, afterDesc, note) {
	return (
		`--- ${rel}\n` +
		`+++ ${rel}\n` +
		`@@ noindex_temporario @@\n` +
		`- ${beforeDesc}\n` +
		`+ ${afterDesc}\n` +
		`  (${note})\n`
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(
			'Uso:\n' +
				'  node scripts/apply-city-decisions.mjs [--dry-run|--apply] [--csv city-pages-audit.csv]\n\n' +
				'Dry-run é o padrão. --apply grava seo.robots=true (WP) ou frontmatter noindex.\n' +
				'Nunca deleta nem renomeia arquivos.',
		);
		return;
	}

	console.log('🔧 apply-city-decisions\n');
	console.log(`Modo: ${args.apply ? '--apply (grava + git add)' : '--dry-run (só lista/diff)'}`);
	console.log(`CSV:  ${path.relative(ROOT, args.csv)}\n`);

	assertCleanGit();

	if (!(await pathExists(args.csv))) {
		console.error(`❌ Não encontrei ${path.relative(ROOT, args.csv)}`);
		process.exit(1);
	}

	const rows = parseCsv(await readFile(args.csv, 'utf8'));
	if (!rows.length) {
		console.error('❌ CSV vazio.');
		process.exit(1);
	}

	if (!('decisao_final' in rows[0]) && !rows.some((r) => 'decisao_final' in r && r.decisao_final)) {
		// header check via first row keys
		const sampleKeys = Object.keys(rows[0] || {});
		if (!sampleKeys.includes('decisao_final')) {
			console.error(
				'❌ Coluna "decisao_final" ausente em city-pages-audit.csv.\n' +
					'   Adicione a coluna e preencha: manter | noindex_temporario | consolidar\n' +
					`   Colunas atuais: ${sampleKeys.join(', ')}`,
			);
			process.exit(1);
		}
	}

	const index = await buildPathIndex();
	console.log(`Índice de paths: ${index.size} arquivos\n`);

	const counts = {
		manter: 0,
		consolidar: 0,
		noindex_temporario: 0,
		vazio: 0,
		invalido: 0,
	};

	/** @type {{ url: string, rel: string, diff: string, next?: string, abs?: string }[]} */
	const toChange = [];
	/** @type {string[]} */
	const missing = [];
	/** @type {string[]} */
	const already = [];
	/** @type {string[]} */
	const diffs = [];

	for (const row of rows) {
		const url = String(row.url ?? '').trim();
		const decision = String(row.decisao_final ?? '').trim().toLowerCase();

		if (!decision) {
			counts.vazio += 1;
			continue;
		}
		if (!VALID_DECISIONS.has(decision)) {
			counts.invalido += 1;
			console.warn(`⚠ decisão inválida "${decision}" em ${url}`);
			continue;
		}

		if (decision === 'manter') {
			counts.manter += 1;
			continue;
		}
		if (decision === 'consolidar') {
			counts.consolidar += 1;
			continue;
		}

		// noindex_temporario
		counts.noindex_temporario += 1;
		const key = normalizePathKey(url);
		const hit = index.get(key);
		if (!hit) {
			missing.push(url);
			continue;
		}

		const raw = await readFile(hit.abs, 'utf8');
		const result =
			hit.kind === 'wp-json' ? applyNoindexWpJson(raw) : applyNoindexFrontmatter(raw);

		if (!result.changed) {
			already.push(`${url} → ${hit.rel} (${result.note})`);
			continue;
		}

		const beforeDesc =
			hit.kind === 'wp-json'
				? `seo.robots: ${JSON.stringify(result.before)}`
				: String(result.before);
		const afterDesc =
			hit.kind === 'wp-json' ? 'seo.robots: true' : String(result.after);
		const diff = formatDiff(hit.rel, beforeDesc, afterDesc, result.note);
		diffs.push(diff);
		toChange.push({ url, rel: hit.rel, abs: hit.abs, diff, next: result.next });
	}

	console.log('=== Planejamento ===\n');
	console.log(`manter (noop):              ${counts.manter}`);
	console.log(`consolidar (noop aqui):     ${counts.consolidar}`);
	console.log(`noindex_temporario (CSV):   ${counts.noindex_temporario}`);
	console.log(`  → seriam alterados:       ${toChange.length}`);
	console.log(`  → já noindex:             ${already.length}`);
	console.log(`  → URL sem arquivo:        ${missing.length}`);
	console.log(`decisão vazia:              ${counts.vazio}`);
	console.log(`decisão inválida:           ${counts.invalido}`);

	if (missing.length) {
		console.log('\nURLs sem arquivo correspondente (até 20):');
		for (const u of missing.slice(0, 20)) console.log(`  · ${u}`);
		if (missing.length > 20) console.log(`  · … +${missing.length - 20}`);
	}

	if (diffs.length) {
		console.log('\n=== Diffs (mudança exata) ===\n');
		for (const d of diffs) console.log(d);
	} else {
		console.log('\n(nenhuma alteração pendente de noindex)\n');
	}

	if (!args.apply) {
		console.log('Dry-run: nenhum arquivo escrito. Use --apply para gravar.');
		console.log('Nenhum arquivo foi deletado ou renomeado.\n');
		return;
	}

	let written = 0;
	for (const item of toChange) {
		await writeFile(item.abs, item.next, 'utf8');
		gitAdd(item.rel);
		written += 1;
	}

	console.log(`\n✓ Gravados e staged (git add): ${written}. Sem commit.`);
	console.log('Nenhum arquivo foi deletado ou renomeado.\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
