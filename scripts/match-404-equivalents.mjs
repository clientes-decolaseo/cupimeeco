/**
 * Cruza URLs 404 (urls-404.txt) com slugs atualmente publicados e sugere
 * redirect 301 ou 410.
 *
 * Somente leitura — gera 404-matching-report.csv para revisão manual.
 *
 * Uso:
 *   node scripts/match-404-equivalents.mjs
 *   npm run match:404
 */
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import manifest from '../src/data/wp/manifest.json' with { type: 'json' };
import cidadesRedirects from './redirects-cidades.json' with { type: 'json' };

const ROOT = path.resolve('.');
const INPUT = path.join(ROOT, 'urls-404.txt');
const OUT_CSV = path.join(ROOT, '404-matching-report.csv');

const WP_PAGES_DIR = path.join(ROOT, 'src', 'data', 'wp', 'pages');
const WP_POSTS_DIR = path.join(ROOT, 'src', 'data', 'wp', 'posts');
const SRC_PAGES = path.join(ROOT, 'src', 'pages');
const SRC_CONTENT = path.join(ROOT, 'src', 'content');

// ——— limiares ajustáveis ———
/** Score mínimo para sugerir redirect_301 (0–1). */
const SCORE_REDIRECT_THRESHOLD = 0.55;
/** Abaixo disso → sem_equivalente_410 (mesmo que exista um “melhor” fraco). */
const SCORE_MIN_CANDIDATE = 0.28;

/** Peso da similaridade Jaccard (tokens) vs Levenshtein normalizado. */
const W_TOKEN = 0.65;
const W_LEVENSHTEIN = 0.35;

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

function normalizePathKey(raw) {
	let s = String(raw ?? '').trim();
	if (!s || s.startsWith('#')) return null;
	try {
		if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
		else if (s.startsWith('//')) s = new URL(`https:${s}`).pathname;
	} catch {
		/* keep */
	}
	s = s.split(/[?#]/)[0];
	s = s.replace(/^\/+|\/+$/g, '').toLowerCase();
	return s || null;
}

function toPublicUrl(pathKey) {
	if (!pathKey) return '/';
	return `/${pathKey}/`.replace(/\/{2,}/g, '/');
}

/** Slug “folha” + path completo para matching. */
function slugParts(pathKey) {
	const full = String(pathKey || '').toLowerCase();
	const leaf = full.split('/').filter(Boolean).pop() || full;
	return { full, leaf };
}

function tokenizeSlug(slug) {
	return String(slug ?? '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 2);
}

function jaccardTokens(a, b) {
	const A = new Set(a);
	const B = new Set(b);
	if (!A.size && !B.size) return 0;
	let inter = 0;
	for (const t of A) if (B.has(t)) inter += 1;
	return inter / (A.size + B.size - inter);
}

function levenshtein(a, b) {
	const s = String(a);
	const t = String(b);
	const m = s.length;
	const n = t.length;
	if (m === 0) return n;
	if (n === 0) return m;
	/** @type {number[]} */
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		/** @type {number[]} */
		const curr = [i];
		for (let j = 1; j <= n; j++) {
			const cost = s[i - 1] === t[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		prev = curr;
	}
	return prev[n];
}

function levenshteinSimilarity(a, b) {
	const s = String(a);
	const t = String(b);
	const maxLen = Math.max(s.length, t.length);
	if (!maxLen) return 1;
	return 1 - levenshtein(s, t) / maxLen;
}

/**
 * Score combinado: tokens (leaf + full) e Levenshtein no leaf.
 */
function similarityScore(queryPath, candidatePath) {
	const q = slugParts(queryPath);
	const c = slugParts(candidatePath);

	const tokenLeaf = jaccardTokens(tokenizeSlug(q.leaf), tokenizeSlug(c.leaf));
	const tokenFull = jaccardTokens(tokenizeSlug(q.full), tokenizeSlug(c.full));
	const tokenScore = Math.max(tokenLeaf, tokenFull * 0.95);

	const levLeaf = levenshteinSimilarity(q.leaf, c.leaf);
	const levFull = levenshteinSimilarity(q.full.replace(/\//g, '-'), c.full.replace(/\//g, '-'));
	const levScore = Math.max(levLeaf, levFull * 0.9);

	// Bônus: um contém o outro (substring de slug)
	let bonus = 0;
	if (q.leaf.length >= 6 && c.leaf.length >= 6) {
		if (c.leaf.includes(q.leaf) || q.leaf.includes(c.leaf)) bonus = 0.08;
	}

	const score = Math.min(1, W_TOKEN * tokenScore + W_LEVENSHTEIN * levScore + bonus);
	return score;
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

async function existingWpIds(dir) {
	/** @type {Set<number>} */
	const ids = new Set();
	if (!(await pathExists(dir))) return ids;
	for (const name of await readdir(dir)) {
		const m = name.match(/^(\d+)\.json$/i);
		if (m) ids.add(Number(m[1]));
	}
	return ids;
}

/**
 * Carrega redirects conhecidos (policies SEO + cidades) para excluir fontes
 * e, opcionalmente, usar destinos como candidatos publicados.
 */
async function loadRedirectMaps() {
	/** @type {Set<string>} */
	const redirectSources = new Set();
	/** @type {Set<string>} */
	const redirectDestinations = new Set();

	const policyFiles = [
		'src/data/seo/cupim-policy.json',
		'src/data/seo/dedetizacao-policy.json',
		'src/data/seo/deratizacao-policy.json',
		'src/data/seo/sanitizacao-policy.json',
		'src/data/seo/mosquitos-policy.json',
		'src/data/seo/fora-area-policy.json',
		'src/data/seo/duplicates-policy.json',
	];

	for (const rel of policyFiles) {
		const abs = path.join(ROOT, rel);
		if (!(await pathExists(abs))) continue;
		const data = JSON.parse(await readFile(abs, 'utf8'));
		for (const [from, to] of Object.entries(data.redirects ?? {})) {
			const f = normalizePathKey(from);
			const t = normalizePathKey(to);
			if (f) redirectSources.add(f);
			if (t) redirectDestinations.add(t);
		}
	}

	for (const [from, to] of Object.entries(cidadesRedirects ?? {})) {
		if (from.startsWith('_') || typeof to !== 'string') continue;
		const f = normalizePathKey(from);
		const t = normalizePathKey(to);
		if (f) redirectSources.add(f);
		if (t) redirectDestinations.add(t);
	}

	return { redirectSources, redirectDestinations };
}

/**
 * Slugs atualmente publicáveis:
 * - rotas estáticas em src/pages
 * - content collections (se houver)
 * - WP pages/posts com JSON vivo e sem redirect 301
 * - hubs de destino de redirects (ex.: /descupinizacao/)
 */
async function collectPublishedPaths() {
	/** @type {Set<string>} */
	const published = new Set();
	const { redirectSources, redirectDestinations } = await loadRedirectMaps();

	// src/pages → rotas estáticas
	const pageFiles = await walkFiles(SRC_PAGES, new Set(['.astro', '.md', '.mdx']));
	for (const abs of pageFiles) {
		const rel = path.relative(SRC_PAGES, abs).replace(/\\/g, '/');
		if (rel.includes('[')) continue; // rotas dinâmicas ([...slug], [topico], etc.)
		let key = rel
			.replace(/\.(astro|md|mdx)$/i, '')
			.replace(/\/index$/i, '');
		if (key === '404' || key === 'index') {
			if (key === 'index') published.add('');
			continue;
		}
		key = normalizePathKey(key);
		if (key) published.add(key);
	}

	// src/content
	const contentFiles = await walkFiles(SRC_CONTENT, new Set(['.md', '.mdx']));
	for (const abs of contentFiles) {
		const rel = path.relative(SRC_CONTENT, abs).replace(/\\/g, '/');
		const key = normalizePathKey(rel.replace(/\.(md|mdx)$/i, ''));
		if (key) published.add(key);
	}

	// WP live (não redirecionado)
	const pageIds = await existingWpIds(WP_PAGES_DIR);
	const postIds = await existingWpIds(WP_POSTS_DIR);
	for (const entry of [...(manifest.pages ?? []), ...(manifest.posts ?? [])]) {
		const id = entry.id;
		const isPage = (manifest.pages ?? []).some((p) => p.id === id);
		const alive = isPage ? pageIds.has(id) : postIds.has(id);
		if (!alive) continue;
		const key = normalizePathKey(entry.path);
		if (!key) continue;
		if (redirectSources.has(key)) continue;
		published.add(key);
	}

	// Destinos de redirect (= páginas-hub que existem no site)
	for (const dest of redirectDestinations) {
		if (dest) published.add(dest);
	}

	// Garante pilares comuns mesmo se só existirem como .astro
	for (const hub of [
		'descupinizacao',
		'dedetizacao',
		'deratizacao',
		'sanitizacao',
		'controle-de-mosquitos',
		'blog',
		'servico',
		'contato',
	]) {
		published.add(hub);
	}

	return { published: [...published].filter(Boolean).sort(), redirectSources };
}

async function readUrlList(filePath) {
	const text = await readFile(filePath, 'utf8');
	/** @type {{ original: string, pathKey: string }[]} */
	const list = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const pathKey = normalizePathKey(trimmed);
		if (!pathKey || seen.has(pathKey)) continue;
		seen.add(pathKey);
		list.push({ original: trimmed, pathKey });
	}
	return list;
}

function suggestAction(score) {
	if (score >= SCORE_REDIRECT_THRESHOLD) return 'redirect_301';
	return 'sem_equivalente_410';
}

async function main() {
	console.log('🔍 match-404-equivalents — somente relatório\n');

	if (!(await pathExists(INPUT))) {
		console.error(`❌ Não encontrei ${path.relative(ROOT, INPUT)}`);
		process.exit(1);
	}

	const urls = await readUrlList(INPUT);
	const { published, redirectSources } = await collectPublishedPaths();

	console.log(`URLs 404:              ${urls.length}`);
	console.log(`Slugs publicados:      ${published.length}`);
	console.log(`Limiar redirect_301:   ${SCORE_REDIRECT_THRESHOLD}`);
	console.log(`Score mínimo candidato:${SCORE_MIN_CANDIDATE}\n`);

	/** @type {object[]} */
	const rows = [];
	let n301 = 0;
	let n410 = 0;

	for (const item of urls) {
		// Se a URL 404 ainda é fonte de um 301 já configurado, o “equivalente”
		// real pode ser o destino — mas o usuário pediu match por similaridade
		// contra páginas publicadas. Mantemos o scoring uniforme.

		let bestPath = '';
		let bestScore = 0;

		for (const cand of published) {
			// Não sugerir a própria URL se por acaso ainda estiver no índice
			if (cand === item.pathKey) continue;
			const score = similarityScore(item.pathKey, cand);
			if (score > bestScore) {
				bestScore = score;
				bestPath = cand;
			}
		}

		const scoreRounded = Number(bestScore.toFixed(3));
		const weak = bestScore < SCORE_MIN_CANDIDATE;
		const acao = weak ? 'sem_equivalente_410' : suggestAction(bestScore);
		if (acao === 'redirect_301') n301 += 1;
		else n410 += 1;

		if (redirectSources.has(item.pathKey)) {
			console.log(`ℹ já em policy de redirect: /${item.pathKey}/ → ver seo-policy`);
		}

		rows.push({
			url_404: item.original,
			melhor_candidato_atual: weak ? '' : toPublicUrl(bestPath),
			score_similaridade: scoreRounded,
			acao_sugerida: acao,
		});
	}

	const headers = ['url_404', 'melhor_candidato_atual', 'score_similaridade', 'acao_sugerida'];
	const csv = [
		headers.join(','),
		...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')),
	].join('\n');

	await writeFile(OUT_CSV, `${csv}\n`, 'utf8');

	console.log('\n=== Resumo ===\n');
	console.log(`Total:                 ${rows.length}`);
	console.log(`redirect_301:          ${n301}`);
	console.log(`sem_equivalente_410:   ${n410}`);
	console.log(`\nCSV: ${path.relative(ROOT, OUT_CSV)}`);
	console.log('\nNenhuma alteração feita — revise o CSV manualmente.\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
