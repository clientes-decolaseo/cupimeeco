/**
 * Auditoria de conteúdo fora do vertical cupim/dedetização
 * (desentupimento, caixa d'água, etc.).
 *
 * Escopo de busca:
 *   - src/pages/
 *   - src/data/wp/posts/  (blog)
 *   - src/data/wp/pages/  (landings WP — onde está a maior parte do off-topic)
 *
 * Uso:
 *   node scripts/audit-off-topic-content.mjs
 *   npm run audit:off-topic
 *
 * Saída: off-topic-content-report.csv — somente leitura.
 */
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import cupimPolicy from '../src/data/seo/cupim-policy.json' with { type: 'json' };
import dedetizacaoPolicy from '../src/data/seo/dedetizacao-policy.json' with { type: 'json' };
import deratizacaoPolicy from '../src/data/seo/deratizacao-policy.json' with { type: 'json' };
import sanitizacaoPolicy from '../src/data/seo/sanitizacao-policy.json' with { type: 'json' };
import mosquitosPolicy from '../src/data/seo/mosquitos-policy.json' with { type: 'json' };
import foraAreaPolicy from '../src/data/seo/fora-area-policy.json' with { type: 'json' };
import duplicatesPolicy from '../src/data/seo/duplicates-policy.json' with { type: 'json' };
import gsc404Policy from '../src/data/seo/gsc-404-policy.json' with { type: 'json' };

const ROOT = path.resolve('.');
const OUT_CSV = path.join(ROOT, 'off-topic-content-report.csv');

const SRC_PAGES = path.join(ROOT, 'src', 'pages');
const WP_POSTS = path.join(ROOT, 'src', 'data', 'wp', 'posts');
const WP_PAGES = path.join(ROOT, 'src', 'data', 'wp', 'pages');

/** Termos fora do vertical de pragas/cupim (slug ou título). */
const OFF_TOPIC_TERMS = [
	'desentupidora',
	'desentupimento',
	'encanador',
	'vazamento',
	'hidrojateamento',
	'esgoto',
	'caixa-dagua',
	'caixa-d-agua',
	"caixa d'agua",
	"caixa d'água",
	'caixa dagua',
	'caixa dágua',
	'caixa de agua',
	'caixa de água',
	'limpeza-de-caixa',
	'limpeza de caixa',
];

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

const NOINDEX_PATHS = new Set(
	[
		cupimPolicy,
		dedetizacaoPolicy,
		deratizacaoPolicy,
		sanitizacaoPolicy,
		mosquitosPolicy,
		foraAreaPolicy,
		duplicatesPolicy,
		gsc404Policy,
	].flatMap((p) => (p.noindex ?? []).map((x) => normalizePathKey(x))),
);

function isNoindexPath(pathKey, wpRobotsFlag = false) {
	return Boolean(wpRobotsFlag) || NOINDEX_PATHS.has(pathKey);
}

async function pathExists(p) {
	try {
		await access(p);
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

function normalizeForMatch(text) {
	return String(text ?? '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/['’`]/g, '');
}

function findMatchedTerms(haystack) {
	const hay = normalizeForMatch(haystack);
	/** @type {string[]} */
	const hits = [];
	for (const term of OFF_TOPIC_TERMS) {
		const t = normalizeForMatch(term);
		if (t && hay.includes(t)) hits.push(term);
	}
	// dedupe por forma normalizada
	const seen = new Set();
	return hits.filter((h) => {
		const k = normalizeForMatch(h);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

function detectNoindexFromFrontmatterOrHtml(raw, fm) {
	if (/^noindex\s*:\s*true\b/im.test(fm)) return true;
	if (/name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(raw)) return true;
	if (/content=["'][^"']*noindex[^"']*["'][^>]*name=["']robots["']/i.test(raw)) return true;
	return false;
}

function detectNoindexWpJson(data) {
	// import-wordpress: seo.robots === true ⇒ Yoast noindex
	if (data?.seo?.robots === true) return true;
	const pathKey = normalizePathKey(data?.path || data?.slug || '');
	if (pathKey && isNoindexPath(pathKey, Boolean(data?.seo?.robots))) return true;
	return false;
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

function extractFrontmatter(raw) {
	const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---/);
	return m ? m[1] : '';
}

async function loadSitemapPaths() {
	/** @type {Set<string>} */
	const paths = new Set();
	const candidates = [
		path.join(ROOT, 'dist', 'sitemap-0.xml'),
		path.join(ROOT, 'dist', 'client', 'sitemap-0.xml'),
		path.join(ROOT, 'dist', 'sitemap-index.xml'),
		path.join(ROOT, '.vercel', 'output', 'static', 'sitemap-0.xml'),
	];

	// também varre dist/ por sitemap*.xml
	const distDir = path.join(ROOT, 'dist');
	if (await pathExists(distDir)) {
		const found = await walkFiles(distDir, new Set(['.xml']));
		for (const f of found) {
			if (/sitemap/i.test(path.basename(f))) candidates.push(f);
		}
	}

	const uniqueFiles = [...new Set(candidates)];
	/** @type {string[]} */
	const readFiles = [];

	for (const file of uniqueFiles) {
		if (!(await pathExists(file))) continue;
		let xml;
		try {
			xml = await readFile(file, 'utf8');
		} catch {
			continue;
		}
		readFiles.push(path.relative(ROOT, file).replace(/\\/g, '/'));
		const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
		let m;
		while ((m = re.exec(xml)) !== null) {
			const key = normalizePathKey(m[1]);
			if (key) paths.add(key);
		}
	}

	return { paths, readFiles };
}

/**
 * Índice invertido simples: pathKey → arquivos em src/ que mencionam o path
 * (href / strings). Só .astro/.md/.mdx — não varre todos os JSON WP (caro).
 */
async function buildInternalLinkIndex(offTopicPathKeys) {
	/** @type {Map<string, Set<string>} */
	const index = new Map();
	for (const k of offTopicPathKeys) index.set(k, new Set());

	const keys = [...offTopicPathKeys].filter((k) => k.length >= 4);
	if (!keys.length) return index;

	const srcFiles = await walkFiles(path.join(ROOT, 'src'), new Set(['.astro', '.md', '.mdx', '.ts', '.tsx']));
	for (const abs of srcFiles) {
		let text;
		try {
			text = await readFile(abs, 'utf8');
		} catch {
			continue;
		}
		const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
		const lower = text.toLowerCase();
		for (const key of keys) {
			if (lower.includes(key) || lower.includes(`/${key}`) || lower.includes(`/${key}/`)) {
				index.get(key)?.add(rel);
			}
		}
	}
	return index;
}

/**
 * @returns {Promise<{ arquivo: string, url_path: string, titulo: string, termos: string, tem_noindex: boolean, kind: string }[]>}
 */
async function collectOffTopicFiles() {
	/** @type {{ arquivo: string, url_path: string, titulo: string, termos: string, tem_noindex: boolean, kind: string }[]} */
	const hits = [];

	// 1) src/pages
	const pageFiles = await walkFiles(SRC_PAGES, new Set(['.astro', '.md', '.mdx']));
	for (const abs of pageFiles) {
		const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
		let urlPath = rel
			.replace(/^src\/pages\//, '')
			.replace(/\.(astro|md|mdx)$/i, '')
			.replace(/\/index$/i, '');
		if (urlPath.includes('[')) continue;

		const raw = await readFile(abs, 'utf8');
		const fm = extractFrontmatter(raw);
		const titleMatch = fm.match(/^title\s*:\s*["']?(.+?)["']?\s*$/m);
		const title = titleMatch ? titleMatch[1].trim() : '';
		const matched = findMatchedTerms(`${urlPath} ${title} ${path.basename(abs)}`);
		if (!matched.length) continue;

		hits.push({
			arquivo: rel,
			url_path: normalizePathKey(urlPath),
			titulo: title,
			termos: matched.join('|'),
			tem_noindex: detectNoindexFromFrontmatterOrHtml(raw, fm),
			kind: 'src-pages',
		});
	}

	// 2) WP posts (blog) + 3) WP pages
	for (const [dir, kind] of [
		[WP_POSTS, 'wp-post'],
		[WP_PAGES, 'wp-page'],
	]) {
		if (!(await pathExists(dir))) continue;
		for (const name of await readdir(dir)) {
			if (!name.endsWith('.json')) continue;
			const abs = path.join(dir, name);
			let data;
			try {
				data = JSON.parse(await readFile(abs, 'utf8'));
			} catch {
				continue;
			}
			const slug = String(data.path || data.slug || '');
			const title = String(data.title || data.seo?.title || '');
			const matched = findMatchedTerms(`${slug} ${title}`);
			if (!matched.length) continue;

			hits.push({
				arquivo: path.relative(ROOT, abs).replace(/\\/g, '/'),
				url_path: normalizePathKey(slug),
				titulo: title.slice(0, 120),
				termos: matched.join('|'),
				tem_noindex: detectNoindexWpJson(data),
				kind,
			});
		}
	}

	return hits;
}

async function main() {
	console.log('🔍 audit-off-topic-content — somente relatório\n');
	console.log(`Termos: ${OFF_TOPIC_TERMS.slice(0, 8).join(', ')}…\n`);

	const hits = await collectOffTopicFiles();
	console.log(`Arquivos off-topic (slug/título): ${hits.length}`);

	const byKind = {};
	for (const h of hits) byKind[h.kind] = (byKind[h.kind] || 0) + 1;
	for (const [k, n] of Object.entries(byKind)) console.log(`  · ${k}: ${n}`);

	const sitemap = await loadSitemapPaths();
	console.log(
		sitemap.readFiles.length
			? `\nSitemaps lidos: ${sitemap.readFiles.join(', ')} (${sitemap.paths.size} URLs)`
			: '\nSitemap: nenhum dist/sitemap*.xml encontrado (rode `npm run build` se quiser checar)',
	);

	const pathKeys = new Set(hits.map((h) => h.url_path).filter(Boolean));
	console.log('Indexando links internos em src/ (astro/md/ts)…');
	const linkIndex = await buildInternalLinkIndex(pathKeys);

	/** @type {object[]} */
	const rows = [];
	let nNoindex = 0;
	let nSitemap = 0;
	let nInternal = 0;

	for (const h of hits) {
		const inSitemap = Boolean(h.url_path && sitemap.paths.has(h.url_path));
		const internalRefs = [...(linkIndex.get(h.url_path) ?? [])].filter((f) => f !== h.arquivo);
		const hasInternal = internalRefs.length > 0;

		if (h.tem_noindex) nNoindex += 1;
		if (inSitemap) nSitemap += 1;
		if (hasInternal) nInternal += 1;

		rows.push({
			arquivo: h.arquivo,
			url_path: h.url_path ? `/${h.url_path}/` : '',
			titulo: h.titulo,
			termos_matched: h.termos,
			tem_noindex: h.tem_noindex ? 'true' : 'false',
			no_sitemap: inSitemap ? 'true' : 'false',
			em_link_interno: hasInternal ? 'true' : 'false',
			arquivos_que_linkam: internalRefs.join(' | '),
		});
	}

	rows.sort((a, b) => a.arquivo.localeCompare(b.arquivo));

	// Colunas pedidas (+ úteis). Pedido: path, noindex, sitemap/link interno.
	const headers = [
		'arquivo',
		'url_path',
		'titulo',
		'termos_matched',
		'tem_noindex',
		'no_sitemap',
		'em_link_interno',
		'arquivos_que_linkam',
	];

	const csv = [
		headers.join(','),
		...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')),
	].join('\n');

	await writeFile(OUT_CSV, `${csv}\n`, 'utf8');

	console.log('\n=== Resumo ===\n');
	console.log(`Total off-topic:     ${rows.length}`);
	console.log(`Já com noindex:      ${nNoindex}`);
	console.log(`No sitemap:          ${nSitemap}`);
	console.log(`Com link interno:    ${nInternal}`);
	console.log(`Sem noindex:         ${rows.length - nNoindex}`);
	console.log(`\nCSV: ${path.relative(ROOT, OUT_CSV)}`);
	console.log('\nNenhuma alteração feita.\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
