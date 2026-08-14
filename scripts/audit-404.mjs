/**
 * Auditoria de URLs 404 — somente leitura / relatório.
 *
 * Uso:
 *   node scripts/audit-404.mjs
 *   node scripts/audit-404.mjs --dry-run
 *   node scripts/audit-404.mjs --input urls-404.txt --out audit-404-report.csv
 *
 * Entrada: urls-404.txt (uma URL ou path por linha; # comentários ok)
 * Saída:   audit-404-report.csv
 *
 * Nunca deleta nem modifica arquivos de conteúdo.
 * --dry-run é o padrão (e o único modo — não há --apply).
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const DEFAULT_INPUT = path.join(ROOT, 'urls-404.txt');
const DEFAULT_OUT = path.join(ROOT, 'audit-404-report.csv');

const LINK_EXTS = new Set(['.astro', '.md', '.mdx']);
const SITEMAP_GLOBS_DIRS = [
	path.join(ROOT, 'public'),
	path.join(ROOT, 'dist'),
	path.join(ROOT, 'dist', 'client'),
	path.join(ROOT, '.vercel', 'output', 'static'),
];

function parseArgs(argv) {
	const args = {
		dryRun: true,
		input: DEFAULT_INPUT,
		out: DEFAULT_OUT,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--dry-run') args.dryRun = true;
		else if (a === '--input' && argv[i + 1]) args.input = path.resolve(argv[++i]);
		else if (a === '--out' && argv[i + 1]) args.out = path.resolve(argv[++i]);
		else if (a === '--help' || a === '-h') args.help = true;
	}
	return args;
}

async function pathExists(target) {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

function csvEscape(value) {
	const str = String(value ?? '');
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

/**
 * Normaliza URL/path → pathname relativo sem query/hash, com leading slash,
 * sem trailing slash (exceto "/").
 */
function normalizePathname(raw) {
	let s = String(raw ?? '').trim();
	if (!s || s.startsWith('#')) return null;

	try {
		if (/^https?:\/\//i.test(s)) {
			s = new URL(s).pathname;
		} else if (s.startsWith('//')) {
			s = new URL(`https:${s}`).pathname;
		}
	} catch {
		// mantém s como veio
	}

	s = s.split(/[?#]/)[0].trim();
	if (!s) return null;
	if (!s.startsWith('/')) s = `/${s}`;
	s = s.replace(/\/{2,}/g, '/');
	if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
	return s;
}

async function readUrlList(filePath) {
	const text = await readFile(filePath, 'utf8');
	/** @type {Map<string, string>} path → url original (primeira ocorrência) */
	const map = new Map();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const pathname = normalizePathname(trimmed);
		if (!pathname) continue;
		if (!map.has(pathname)) map.set(pathname, trimmed);
	}
	return map;
}

async function walkFiles(dir, predicate, acc = []) {
	if (!(await pathExists(dir))) return acc;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			await walkFiles(full, predicate, acc);
			continue;
		}
		if (predicate(full, entry.name)) acc.push(full);
	}
	return acc;
}

async function collectSitemapFiles() {
	/** @type {string[]} */
	const files = [];
	for (const dir of SITEMAP_GLOBS_DIRS) {
		if (!(await pathExists(dir))) continue;
		const found = await walkFiles(dir, (_full, name) => {
			const lower = name.toLowerCase();
			return lower.startsWith('sitemap') && lower.endsWith('.xml');
		});
		files.push(...found);
	}
	// Também aceita sitemap na raiz do projeto (cópia manual)
	const rootHits = await walkFiles(ROOT, (full, name) => {
		const rel = path.relative(ROOT, full).replace(/\\/g, '/');
		if (rel.includes('/')) return false;
		const lower = name.toLowerCase();
		return lower.startsWith('sitemap') && lower.endsWith('.xml');
	});
	files.push(...rootHits);
	return [...new Set(files)];
}

/**
 * Extrai pathnames de um XML de sitemap (loc / url).
 */
function extractPathsFromSitemapXml(xml) {
	/** @type {Set<string>} */
	const paths = new Set();
	const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
	let m;
	while ((m = re.exec(xml)) !== null) {
		const p = normalizePathname(m[1]);
		if (p) paths.add(p);
	}
	return paths;
}

async function loadSitemapPathSet() {
	const files = await collectSitemapFiles();
	/** @type {Set<string>} */
	const paths = new Set();
	/** @type {string[]} */
	const sources = [];

	for (const file of files) {
		let text;
		try {
			text = await readFile(file, 'utf8');
		} catch {
			continue;
		}
		const before = paths.size;
		for (const p of extractPathsFromSitemapXml(text)) paths.add(p);
		if (paths.size > before) {
			sources.push(path.relative(ROOT, file).replace(/\\/g, '/'));
		}
	}

	return { paths, sources, filesChecked: files.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')) };
}

/**
 * Gera variantes de string para busca textual do path no código.
 */
function pathSearchNeedles(pathname) {
	const p = pathname;
	const withSlash = p === '/' ? '/' : `${p}/`;
	const bare = p.replace(/^\//, '');
	return [
		p,
		withSlash,
		`"${p}"`,
		`"${withSlash}"`,
		`'${p}'`,
		`'${withSlash}'`,
		`href="${p}"`,
		`href="${withSlash}"`,
		`href='${p}'`,
		`href='${withSlash}'`,
		`to="${p}"`,
		`to="${withSlash}"`,
		bare.length > 1 ? bare : null,
	].filter(Boolean);
}

/**
 * Match conservador: path como segmento de URL/href, evitando falsos positivos
 * tipo "/sp" dentro de "/especial".
 */
function fileMentionsPath(text, pathname) {
	const escaped = pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const withOptSlash = `${escaped}/?`;
	const patterns = [
		new RegExp(`(?:href|to|url|canonical|path|permalink)\\s*[=:]\\s*["'\`]${withOptSlash}["'\`]`, 'i'),
		new RegExp(`["'\`]${withOptSlash}["'\`]`, 'i'),
		new RegExp(`https?://[^\\s"'<>]*${withOptSlash}(?=["'\\s?#<>]|$)`, 'i'),
		// frontmatter: key: /path ou key: "/path"
		new RegExp(`^[\\t ]*[\\w-]+\\s*:\\s*["']?${withOptSlash}["']?\\s*$`, 'im'),
	];
	return patterns.some((re) => re.test(text));
}

async function collectSourceFiles() {
	const srcDir = path.join(ROOT, 'src');
	const contentDir = path.join(ROOT, 'src', 'content');

	const codeFiles = await walkFiles(srcDir, (full) => {
		const ext = path.extname(full).toLowerCase();
		if (!LINK_EXTS.has(ext)) return false;
		// content collections também são .md/.mdx sob src/content — entram aqui
		return true;
	});

	// Garante varredura explícita de src/content mesmo se vazia (só log)
	const contentExists = await pathExists(contentDir);

	return {
		files: codeFiles,
		contentExists,
		contentDir: contentExists ? contentDir : null,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(
			'Uso:\n' +
				'  node scripts/audit-404.mjs [--dry-run] [--input urls-404.txt] [--out audit-404-report.csv]\n\n' +
				'Modo padrão: --dry-run (apenas relatório CSV). Não altera nem apaga arquivos.',
		);
		return;
	}

	console.log('🔍 audit-404 — somente leitura / relatório\n');
	console.log(`Modo: ${args.dryRun ? '--dry-run (padrão, sem alterações)' : 'relatório'}`);
	console.log(`Input: ${path.relative(ROOT, args.input)}`);
	console.log(`Output: ${path.relative(ROOT, args.out)}\n`);

	if (!(await pathExists(args.input))) {
		console.error(
			`❌ Não encontrei ${path.relative(ROOT, args.input)}.\n` +
				`   Crie o arquivo na raiz do projeto com uma URL (ou path) 404 por linha.\n` +
				`   Exemplo:\n` +
				`     https://cupins.eco.br/pagina-antiga/\n` +
				`     /outro-path-404/\n`,
		);
		process.exit(1);
	}

	const urlMap = await readUrlList(args.input);
	console.log(`📋 URLs/paths únicos a auditar: ${urlMap.size}`);

	const sitemap = await loadSitemapPathSet();
	console.log(
		`🗺️  Sitemaps lidos: ${sitemap.filesChecked.length}` +
			(sitemap.filesChecked.length
				? `\n   ${sitemap.filesChecked.map((f) => `· ${f}`).join('\n   ')}`
				: ' (nenhum sitemap*.xml em public/, dist/ ou raiz — rode `npm run build` se quiser checar o gerado)'),
	);
	console.log(`   Paths no sitemap: ${sitemap.paths.size}`);

	const sources = await collectSourceFiles();
	console.log(`📄 Arquivos .astro/.md/.mdx em src/: ${sources.files.length}`);
	console.log(
		sources.contentExists
			? `📚 src/content/: presente`
			: `📚 src/content/: pasta não existe (ok — collections serão puladas)`,
	);

	// Pré-carrega conteúdos (evita reler o mesmo arquivo N vezes)
	/** @type {Map<string, string>} */
	const fileTexts = new Map();
	for (const abs of sources.files) {
		try {
			fileTexts.set(abs, await readFile(abs, 'utf8'));
		} catch {
			// ignore
		}
	}

	/** @type {{ url: string, encontrado_no_sitemap: string, encontrado_em_link_interno: string, arquivos_origem: string }[]} */
	const rows = [];

	let inSitemap = 0;
	let inLinks = 0;

	for (const [pathname, original] of urlMap) {
		const onSitemap = sitemap.paths.has(pathname) || sitemap.paths.has(`${pathname}/`);
		if (onSitemap) inSitemap += 1;

		/** @type {string[]} */
		const origins = [];
		for (const [abs, text] of fileTexts) {
			if (fileMentionsPath(text, pathname)) {
				origins.push(path.relative(ROOT, abs).replace(/\\/g, '/'));
			}
		}
		// Também marca se algum needle trivial aparece (fallback) — já coberto por fileMentionsPath

		const hasInternal = origins.length > 0;
		if (hasInternal) inLinks += 1;

		rows.push({
			url: original,
			encontrado_no_sitemap: onSitemap ? 'true' : 'false',
			encontrado_em_link_interno: hasInternal ? 'true' : 'false',
			arquivos_origem: origins.join(' | '),
		});
	}

	rows.sort((a, b) => {
		const score = (r) =>
			(r.encontrado_no_sitemap === 'true' ? 2 : 0) +
			(r.encontrado_em_link_interno === 'true' ? 1 : 0);
		return score(b) - score(a) || a.url.localeCompare(b.url);
	});

	const headers = ['url', 'encontrado_no_sitemap', 'encontrado_em_link_interno', 'arquivos_origem'];
	const csv = [
		headers.join(','),
		...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')),
	].join('\n');

	await mkdir(path.dirname(args.out), { recursive: true });
	await writeFile(args.out, `${csv}\n`, 'utf8');

	const neither = rows.filter(
		(r) => r.encontrado_no_sitemap === 'false' && r.encontrado_em_link_interno === 'false',
	).length;

	console.log('\n=== Resumo ===\n');
	console.log(`Total auditado:              ${rows.length}`);
	console.log(`Ainda no sitemap:            ${inSitemap}`);
	console.log(`Com link interno em src/:    ${inLinks}`);
	console.log(`Sem sitemap nem link:        ${neither}`);
	console.log(`\nCSV: ${path.relative(ROOT, args.out)}`);
	console.log('\nNenhum arquivo de conteúdo foi alterado ou apagado.\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
