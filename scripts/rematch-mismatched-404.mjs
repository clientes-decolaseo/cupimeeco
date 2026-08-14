/**
 * Rematch das URLs de pest-type-mismatch-report.csv com candidatos
 * restritos à MESMA categoria de praga.
 *
 * Algoritmo de score: espelha scripts/match-404-equivalents.mjs
 * (Jaccard de tokens + Levenshtein), limiar redirect_301 = 0.45
 * (mais permissivo que 0.55 — a restrição de categoria reduz FPs).
 *
 * Dicionário de pragas: scripts/lib/pest-categories.mjs (compartilhado).
 *
 * Uso:
 *   node scripts/rematch-mismatched-404.mjs
 *
 * Saída: rematch-same-category-report.csv — somente leitura (não altera policies).
 */
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import manifest from '../src/data/wp/manifest.json' with { type: 'json' };
import cidadesRedirects from './redirects-cidades.json' with { type: 'json' };
import {
	belongsToSamePestCategoryOnly,
	matchPestCategories,
	primaryCategory,
} from './lib/pest-categories.mjs';
import { normalizePathKey } from './lib/redirect-map.mjs';

const ROOT = path.resolve('.');
const MISMATCH_CSV = path.join(ROOT, 'pest-type-mismatch-report.csv');
const OUT_CSV = path.join(ROOT, 'rematch-same-category-report.csv');

const WP_PAGES_DIR = path.join(ROOT, 'src', 'data', 'wp', 'pages');
const WP_POSTS_DIR = path.join(ROOT, 'src', 'data', 'wp', 'posts');
const SRC_PAGES = path.join(ROOT, 'src', 'pages');
const SRC_CONTENT = path.join(ROOT, 'src', 'content');

/** Limiar mais permissivo (original em match-404 = 0.55). */
const SCORE_REDIRECT_THRESHOLD = 0.45;
/** Abaixo disso o candidato é descartado mesmo como “melhor fraco”. */
const SCORE_MIN_CANDIDATE = 0.28;

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

function toPublicUrl(pathKey) {
	if (!pathKey) return '/';
	return `/${pathKey}/`.replace(/\/{2,}/g, '/');
}

/* ——— score (espelha match-404-equivalents.mjs) ——— */

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
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
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

function similarityScore(queryPath, candidatePath) {
	const q = slugParts(queryPath);
	const c = slugParts(candidatePath);

	const tokenLeaf = jaccardTokens(tokenizeSlug(q.leaf), tokenizeSlug(c.leaf));
	const tokenFull = jaccardTokens(tokenizeSlug(q.full), tokenizeSlug(c.full));
	const tokenScore = Math.max(tokenLeaf, tokenFull * 0.95);

	const levLeaf = levenshteinSimilarity(q.leaf, c.leaf);
	const levFull = levenshteinSimilarity(
		q.full.replace(/\//g, '-'),
		c.full.replace(/\//g, '-'),
	);
	const levScore = Math.max(levLeaf, levFull * 0.9);

	let bonus = 0;
	if (q.leaf.length >= 6 && c.leaf.length >= 6) {
		if (c.leaf.includes(q.leaf) || q.leaf.includes(c.leaf)) bonus = 0.08;
	}

	return Math.min(1, W_TOKEN * tokenScore + W_LEVENSHTEIN * levScore + bonus);
}

/* ——— universo publicado (espelha match-404-equivalents.mjs) ——— */

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
	const ids = new Set();
	if (!(await pathExists(dir))) return ids;
	for (const name of await readdir(dir)) {
		const m = name.match(/^(\d+)\.json$/i);
		if (m) ids.add(Number(m[1]));
	}
	return ids;
}

async function loadRedirectMaps() {
	const redirectSources = new Set();
	const redirectDestinations = new Set();

	const policyFiles = [
		'src/data/seo/cupim-policy.json',
		'src/data/seo/dedetizacao-policy.json',
		'src/data/seo/deratizacao-policy.json',
		'src/data/seo/sanitizacao-policy.json',
		'src/data/seo/mosquitos-policy.json',
		'src/data/seo/fora-area-policy.json',
		'src/data/seo/duplicates-policy.json',
		'src/data/seo/gsc-404-policy.json',
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

async function collectPublishedPaths() {
	const published = new Set();
	const { redirectSources, redirectDestinations } = await loadRedirectMaps();

	const pageFiles = await walkFiles(SRC_PAGES, new Set(['.astro', '.md', '.mdx']));
	for (const abs of pageFiles) {
		const rel = path.relative(SRC_PAGES, abs).replace(/\\/g, '/');
		if (rel.includes('[')) continue;
		let key = rel.replace(/\.(astro|md|mdx)$/i, '').replace(/\/index$/i, '');
		if (key === '404' || key === 'index') {
			if (key === 'index') published.add('');
			continue;
		}
		key = normalizePathKey(key);
		if (key) published.add(key);
	}

	const contentFiles = await walkFiles(SRC_CONTENT, new Set(['.md', '.mdx']));
	for (const abs of contentFiles) {
		const rel = path.relative(SRC_CONTENT, abs).replace(/\\/g, '/');
		const key = normalizePathKey(rel.replace(/\.(md|mdx)$/i, ''));
		if (key) published.add(key);
	}

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

	for (const dest of redirectDestinations) {
		if (dest) published.add(dest);
	}

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

	return [...published].filter(Boolean).sort();
}

async function loadMismatchRows() {
	const matrix = parseCsv(await readFile(MISMATCH_CSV, 'utf8'));
	if (matrix.length < 2) return [];

	const headers = matrix[0].map((h) => String(h).trim());
	const idxO = headers.indexOf('url_origem');
	const idxC = headers.indexOf('categoria_origem');

	const rows = [];
	const seen = new Set();

	for (const cells of matrix.slice(1)) {
		const urlOrigem = cells[idxO] ?? '';
		const key = toOriginKey(urlOrigem);
		if (!key || seen.has(key)) continue;
		seen.add(key);

		let categoria = String(cells[idxC] ?? '').trim();
		if (!categoria) {
			categoria = primaryCategory(matchPestCategories(key)) || '';
		}

		rows.push({
			url_origem: urlOrigem || toPublicUrl(key),
			pathKey: key,
			categoria,
		});
	}

	return rows;
}

function findBestSameCategory(originKey, category, published) {
	let best = { path: '', score: 0 };

	for (const candidate of published) {
		if (candidate === originKey) continue;
		if (!belongsToSamePestCategoryOnly(candidate, category)) continue;

		const score = similarityScore(originKey, candidate);
		if (score > best.score) {
			best = { path: candidate, score };
		}
	}

	return best;
}

function suggestAction(score) {
	if (score >= SCORE_REDIRECT_THRESHOLD) return 'redirect_301';
	return 'sem_equivalente_410';
}

async function main() {
	console.log('rematch-mismatched-404 — mesma categoria de praga\n');
	console.log(`Limiar redirect_301: ${SCORE_REDIRECT_THRESHOLD} (min candidato: ${SCORE_MIN_CANDIDATE})\n`);

	if (!(await pathExists(MISMATCH_CSV))) {
		console.error(`❌ Não encontrei ${path.relative(ROOT, MISMATCH_CSV)}`);
		process.exitCode = 1;
		return;
	}

	const mismatches = await loadMismatchRows();
	console.log(`URLs a rematchar: ${mismatches.length}`);

	const published = await collectPublishedPaths();
	console.log(`Slugs publicados: ${published.length}\n`);

	const outRows = [];
	let n301 = 0;
	let n410 = 0;

	for (const row of mismatches) {
		const { pathKey, categoria, url_origem } = row;

		if (!categoria) {
			outRows.push({
				url_origem,
				categoria: '',
				melhor_candidato_mesma_categoria: '',
				score: '',
				acao_sugerida: 'sem_equivalente_410',
			});
			n410++;
			console.log(`  ? ${pathKey} — categoria ausente → 410`);
			continue;
		}

		const sameCatPool = published.filter((p) =>
			belongsToSamePestCategoryOnly(p, categoria),
		);
		const best = findBestSameCategory(pathKey, categoria, published);

		const usable =
			best.path &&
			best.score >= SCORE_MIN_CANDIDATE &&
			best.score >= SCORE_REDIRECT_THRESHOLD;

		const action = usable ? 'redirect_301' : 'sem_equivalente_410';
		if (action === 'redirect_301') n301++;
		else n410++;

		const candidateUrl =
			best.path && best.score >= SCORE_MIN_CANDIDATE
				? toPublicUrl(best.path)
				: '';

		outRows.push({
			url_origem,
			categoria,
			melhor_candidato_mesma_categoria: candidateUrl,
			score: best.path ? best.score.toFixed(3) : '',
			acao_sugerida: action,
		});

		console.log(
			`  [${categoria}] pool=${sameCatPool.length}  ${pathKey}\n` +
				`    → ${candidateUrl || '(nenhum)'}  score=${best.path ? best.score.toFixed(3) : '—'}  ${action}`,
		);
	}

	const headers = [
		'url_origem',
		'categoria',
		'melhor_candidato_mesma_categoria',
		'score',
		'acao_sugerida',
	];
	const lines = [
		headers.join(','),
		...outRows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')),
	];
	await writeFile(OUT_CSV, `${lines.join('\n')}\n`, 'utf8');

	console.log(`\n→ ${path.relative(ROOT, OUT_CSV)}`);
	console.log(`  redirect_301:         ${n301}`);
	console.log(`  sem_equivalente_410:  ${n410}`);
	console.log('Policies não alteradas.');
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
