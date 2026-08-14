/**
 * Auditoria de qualidade/similaridade de landing pages locais (cidade/bairro).
 *
 * NÃO confundir com scripts/audit-city-pages.mjs (área de atendimento / REMOVER).
 *
 * Descobre páginas em:
 *   - src/data/wp/pages/*.json  (padrão real deste projeto)
 *   - src/pages (arquivos .astro / .md / .mdx)
 *   - src/content (se existir)
 *
 * Uso:
 *   node scripts/audit-city-landing-quality.mjs
 *   npm run audit:city-landing-quality
 *
 * Saída: city-pages-audit.csv (raiz) — somente leitura, não altera conteúdo.
 */
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import cidadesGsp from '../src/data/cidades-gsp.json' with { type: 'json' };

const ROOT = path.resolve('.');
const OUT_CSV = path.join(ROOT, 'city-pages-audit.csv');
const WP_PAGES_DIR = path.join(ROOT, 'src', 'data', 'wp', 'pages');
const SRC_PAGES = path.join(ROOT, 'src', 'pages');
const SRC_CONTENT = path.join(ROOT, 'src', 'content');

/** Slug tipicamente local: …-em-cidade / -na- / -no- */
const CITY_SLUG_RE = /-(?:em|na|no|nas|nos)-[a-z0-9]+(?:-[a-z0-9]+)*\/?$/i;

const SHINGLE_SIZE = 5;
/** Similaridade alta (quase o mesmo template). */
const SIM_HIGH = 0.55;
/** Similaridade baixa (conteúdo distinto). */
const SIM_LOW = 0.28;
/** Poucas palavras → candidato a consolidar se template-like. */
const WORDS_THIN = 280;
/** Muitas palavras → favorece manter. */
const WORDS_RICH = 550;

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

function slugify(text) {
	return String(text ?? '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function buildCityPathTokens() {
	/** @type {Set<string>} */
	const set = new Set();
	for (const [id, m] of Object.entries(cidadesGsp.municipios ?? {})) {
		set.add(id);
		if (m?.nome) set.add(slugify(m.nome));
	}
	for (const [alias, id] of Object.entries(cidadesGsp.aliases ?? {})) {
		set.add(slugify(alias));
		if (id) set.add(id);
	}
	for (const b of cidadesGsp.bairrosSaoPaulo ?? []) set.add(slugify(b));
	for (const z of ['zona-norte', 'zona-sul', 'zona-leste', 'zona-oeste', 'centro']) {
		set.add(z);
	}
	return [...set].filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
}

const CITY_TOKENS = buildCityPathTokens();

function normalizePathSlug(raw) {
	let s = String(raw ?? '')
		.trim()
		.replace(/\\/g, '/');
	if (!s) return '';
	s = s.split(/[?#]/)[0];
	s = s.replace(/^https?:\/\/[^/]+/i, '');
	s = s.replace(/^\/+|\/+$/g, '');
	return s.toLowerCase();
}

function pathLooksLikeCityLanding(slugPath) {
	const slug = normalizePathSlug(slugPath);
	if (!slug) return false;
	const leaf = slug.split('/').filter(Boolean).pop() || slug;
	if (CITY_SLUG_RE.test(leaf) || CITY_SLUG_RE.test(`/${leaf}`)) return true;
	for (const token of CITY_TOKENS) {
		if (leaf === token) return true;
		if (leaf.endsWith(`-${token}`) || leaf.endsWith(`-${token}-sp`)) return true;
		if (leaf.includes(`-em-${token}`) || leaf.includes(`-na-${token}`) || leaf.includes(`-no-${token}`)) {
			return true;
		}
	}
	return false;
}

/** Agrupa por serviço (prefixo antes de -em-/-na-/-no-). */
function serviceClusterKey(slugPath) {
	const leaf = normalizePathSlug(slugPath).split('/').pop() || '';
	const m = leaf.match(/^(.+?)-(?:em|na|no|nas|nos)-(.+)$/i);
	return m ? m[1] : leaf.split('-').slice(0, 3).join('-') || 'outro';
}

function stripBoilerplateHtml(html) {
	let s = String(html ?? '');
	// Remove blocos tipicamente de chrome (se existirem no HTML WP)
	s = s.replace(/<(header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
	s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
	s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
	s = s.replace(/<!--[\s\S]*?-->/g, ' ');
	s = s.replace(/<[^>]+>/g, ' ');
	s = s.replace(/&[a-z#0-9]+;/gi, ' ');
	s = s.replace(/\s+/g, ' ').trim();
	return s;
}

function tokenizeWords(text) {
	return String(text ?? '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9À-ÿ\s]/gi, ' ')
		.split(/\s+/)
		.filter((w) => w.length > 1);
}

function wordCount(text) {
	return tokenizeWords(text).length;
}

function makeShingles(words, size = SHINGLE_SIZE) {
	/** @type {Set<string>} */
	const set = new Set();
	if (words.length < size) {
		if (words.length) set.add(words.join(' '));
		return set;
	}
	for (let i = 0; i <= words.length - size; i++) {
		set.add(words.slice(i, i + size).join(' '));
	}
	return set;
}

function jaccard(a, b) {
	if (!a.size && !b.size) return 0;
	let inter = 0;
	const smaller = a.size <= b.size ? a : b;
	const larger = a.size <= b.size ? b : a;
	for (const x of smaller) if (larger.has(x)) inter += 1;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

const OFFICIAL_PHONE_DIGITS = '08001117272';
const PHONE_RE =
	/(?:0800[\s.\-]?\d{3}[\s.\-]?\d{4})|(?:\(\d{2}\)\s*\d{4,5}[\s.\-]?\d{4})|(?:\+?55[\s.\-]?\(?\d{2}\)?[\s.\-]?\d{4,5}[\s.\-]?\d{4})/gi;
const PRICE_AMOUNT_RE =
	/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*(?:\/\s*(?:m2|m²|visita|ponto))?|\b\d{2,4}\s*reais\b/i;
const TESTIMONIAL_RE =
	/\b(?:depoimento\s+d[eo]|cliente\s+[A-ZÀ-Ú][a-zà-ú]{2,}\s*:|avaliou[- ]nos|"[^"]{25,100}"\s*[-—–]\s*[A-ZÀ-Ú][a-zà-ú]+)/i;
const BAIRRO_HINT_RE =
	/\b(?:no\s+bairro\s+[A-ZÀ-Ú][A-Za-zÀ-ú\s]{2,40}|bairro\s+[A-ZÀ-Ú][A-Za-zÀ-ú\s]{2,30}\s+em\s+)/i;

/**
 * Conteúdo único além de trocar só o nome da cidade?
 * Telefone oficial 0800 compartilhado NÃO conta como único.
 */
function detectUniqueSignals(plainText) {
	const phones = [...String(plainText).matchAll(PHONE_RE)].map((m) => m[0]);
	const nonOfficialPhone = phones.some((p) => {
		const digits = p.replace(/\D/g, '');
		if (!digits) return false;
		if (digits.includes(OFFICIAL_PHONE_DIGITS)) return false;
		if (digits.endsWith('8001117272')) return false;
		return true;
	});
	const hasPrice = PRICE_AMOUNT_RE.test(plainText);
	const hasTestimonial = TESTIMONIAL_RE.test(plainText);
	const hasBairroTalk = BAIRRO_HINT_RE.test(plainText);
	return {
		hasPhone: nonOfficialPhone,
		hasPrice,
		hasTestimonial,
		hasBairroTalk,
		signalCount: [nonOfficialPhone, hasPrice, hasTestimonial, hasBairroTalk].filter(Boolean)
			.length,
	};
}

function extractCityLeafToken(slugPath) {
	const leaf = normalizePathSlug(slugPath).split('/').pop() || '';
	const m = leaf.match(/-(?:em|na|no|nas|nos)-(.+)$/i);
	return m ? m[1].replace(/-sp$/i, '') : '';
}

/**
 * Remove ocorrências do topônimo da página para estimar “só troca de cidade”.
 */
function textWithoutCityNames(plain, citySlugToken) {
	let t = plain.toLowerCase();
	const variants = new Set();
	if (citySlugToken) {
		variants.add(citySlugToken.replace(/-/g, ' '));
		variants.add(citySlugToken);
	}
	for (const token of CITY_TOKENS) {
		if (citySlugToken && (token === citySlugToken || citySlugToken.includes(token))) {
			variants.add(token.replace(/-/g, ' '));
		}
	}
	for (const v of variants) {
		if (v.length < 3) continue;
		const re = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'gi');
		t = t.replace(re, ' ');
	}
	return t.replace(/\s+/g, ' ').trim();
}

function recommend({ palavras, score, temUnico, uniqueShingleRatio, looksLikeCitySwapOnly }) {
	// Template quase idêntico / só troca de cidade → consolidar (mesmo com texto longo)
	if (!temUnico && (looksLikeCitySwapOnly || (score >= SIM_HIGH && uniqueShingleRatio < 0.18))) {
		return 'consolidar';
	}
	if (!temUnico && score >= SIM_HIGH && palavras < WORDS_THIN) {
		return 'consolidar';
	}
	// Conteúdo distinto ou rico de verdade
	if (temUnico && uniqueShingleRatio >= 0.22) {
		return 'manter_e_enriquecer';
	}
	if (score <= SIM_LOW || (palavras >= WORDS_RICH && uniqueShingleRatio >= 0.3 && score < SIM_HIGH)) {
		return 'manter_e_enriquecer';
	}
	return 'revisar_manual';
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

function extractFrontmatterBody(raw) {
	const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!m) return { fm: '', body: raw };
	return { fm: m[1], body: m[2] };
}

async function loadWpCityPages() {
	/** @type {{ url: string, arquivo: string, cluster: string, plain: string }[]} */
	const pages = [];
	if (!(await pathExists(WP_PAGES_DIR))) return pages;

	const files = await readdir(WP_PAGES_DIR);
	for (const name of files) {
		if (!name.endsWith('.json')) continue;
		const abs = path.join(WP_PAGES_DIR, name);
		let data;
		try {
			data = JSON.parse(await readFile(abs, 'utf8'));
		} catch {
			continue;
		}
		const slugPath = String(data.path || data.slug || '').trim();
		if (!pathLooksLikeCityLanding(slugPath)) continue;

		const html = [data.content, data.excerpt].filter(Boolean).join('\n');
		const plain = stripBoilerplateHtml(html);
		if (plain.length < 40) continue;

		const url = `/${normalizePathSlug(slugPath)}/`;
		pages.push({
			url,
			arquivo: path.relative(ROOT, abs).replace(/\\/g, '/'),
			cluster: serviceClusterKey(slugPath),
			plain,
			slugPath: normalizePathSlug(slugPath),
		});
	}
	return pages;
}

async function loadStaticCityPages() {
	/** @type {{ url: string, arquivo: string, cluster: string, plain: string, slugPath: string }[]} */
	const pages = [];
	const files = [
		...(await walkFiles(SRC_PAGES, new Set(['.astro', '.md', '.mdx']))),
		...(await walkFiles(SRC_CONTENT, new Set(['.md', '.mdx']))),
	];

	for (const abs of files) {
		const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
		let slugPath = '';
		if (rel.startsWith('src/pages/')) {
			slugPath = rel
				.replace(/^src\/pages\//, '')
				.replace(/\.(astro|md|mdx)$/i, '')
				.replace(/\/index$/i, '');
		} else if (rel.startsWith('src/content/')) {
			slugPath = rel.replace(/^src\/content\//, '').replace(/\.(md|mdx)$/i, '');
		}
		if (!pathLooksLikeCityLanding(slugPath) && !pathLooksLikeCityLanding(rel)) continue;

		let raw;
		try {
			raw = await readFile(abs, 'utf8');
		} catch {
			continue;
		}

		let body = raw;
		if (/\.(md|mdx)$/i.test(abs)) {
			body = extractFrontmatterBody(raw).body;
		} else {
			// Astro: tenta pegar markup após frontmatter
			const fm = extractFrontmatterBody(raw);
			body = fm.body || raw;
			body = body.replace(/^[\s\S]*?<template[^>]*>/i, '');
		}

		const plain = stripBoilerplateHtml(body);
		if (plain.length < 40) continue;

		const url = `/${normalizePathSlug(slugPath)}/`;
		pages.push({
			url,
			arquivo: rel,
			cluster: serviceClusterKey(slugPath),
			plain,
			slugPath: normalizePathSlug(slugPath),
		});
	}
	return pages;
}

async function main() {
	console.log('🔍 Auditoria de landing pages locais (similaridade de template)\n');
	console.log('Somente leitura — não altera arquivos de conteúdo.\n');

	const wpPages = await loadWpCityPages();
	const staticPages = await loadStaticCityPages();

	/** Dedup por URL (WP prevalece se houver conflito) */
	/** @type {Map<string, typeof wpPages[0]>} */
	const byUrl = new Map();
	for (const p of staticPages) byUrl.set(p.url, p);
	for (const p of wpPages) byUrl.set(p.url, p);

	const pages = [...byUrl.values()];
	console.log(`WP pages (cidade):     ${wpPages.length}`);
	console.log(`src/pages|content:     ${staticPages.length}`);
	console.log(`Total único:           ${pages.length}\n`);

	if (pages.length === 0) {
		console.error('❌ Nenhuma landing local encontrada.');
		process.exit(1);
	}

	// Pré-computa palavras / shingles
	const enriched = pages.map((p) => {
		const words = tokenizeWords(p.plain);
		const cityToken = extractCityLeafToken(p.slugPath);
		const plainNoCity = textWithoutCityNames(p.plain, cityToken);
		const wordsNoCity = tokenizeWords(plainNoCity);
		return {
			...p,
			palavras: words.length,
			words,
			shingles: makeShingles(words),
			shinglesNoCity: makeShingles(wordsNoCity),
			cityToken,
			signals: detectUniqueSignals(p.plain),
		};
	});

	/** @type {Map<string, typeof enriched>} */
	const clusters = new Map();
	for (const p of enriched) {
		if (!clusters.has(p.cluster)) clusters.set(p.cluster, []);
		clusters.get(p.cluster).push(p);
	}

	console.log(`Clusters de serviço:   ${clusters.size}`);
	console.log('Calculando similaridade (shingles de 5 palavras)…\n');

	/** @type {object[]} */
	const rows = [];

	for (const [, group] of clusters) {
		for (let i = 0; i < group.length; i++) {
			const page = group[i];
			let maxSim = 0;
			/** @type {Set<string>} */
			const shared = new Set();

			for (let j = 0; j < group.length; j++) {
				if (i === j) continue;
				const other = group[j];
				const sim = jaccard(page.shingles, other.shingles);
				if (sim > maxSim) maxSim = sim;
				for (const s of page.shingles) {
					if (other.shingles.has(s)) shared.add(s);
				}
			}

			const uniqueCount = [...page.shingles].filter((s) => !shared.has(s)).length;
			const uniqueShingleRatio = page.shingles.size ? uniqueCount / page.shingles.size : 0;

			// “Só nome da cidade trocado”: shingles sem cidade quase iguais ao cluster
			let maxSimNoCity = 0;
			for (let j = 0; j < group.length; j++) {
				if (i === j) continue;
				maxSimNoCity = Math.max(maxSimNoCity, jaccard(page.shinglesNoCity, group[j].shinglesNoCity));
			}

			const signals = page.signals;
			const looksLikeCitySwapOnly = maxSimNoCity >= SIM_HIGH && signals.signalCount === 0;
			const temUnico =
				signals.signalCount >= 1 || (uniqueShingleRatio >= 0.35 && maxSim < SIM_HIGH);

			const score = Number(maxSim.toFixed(3));
			const recomendacao = recommend({
				palavras: page.palavras,
				score,
				temUnico,
				uniqueShingleRatio,
				looksLikeCitySwapOnly,
			});

			rows.push({
				url: page.url,
				palavras: page.palavras,
				score_similaridade: score,
				tem_conteudo_unico: temUnico ? 'true' : 'false',
				recomendacao,
				// extras úteis (não pedidos, mas ajudam — user asked exact columns only)
			});
		}
	}

	// Só as colunas pedidas
	const headers = ['url', 'palavras', 'score_similaridade', 'tem_conteudo_unico', 'recomendacao'];
	rows.sort(
		(a, b) =>
			a.recomendacao.localeCompare(b.recomendacao) ||
			b.score_similaridade - a.score_similaridade ||
			a.url.localeCompare(b.url),
	);

	const csv = [
		headers.join(','),
		...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(',')),
	].join('\n');

	await writeFile(OUT_CSV, `${csv}\n`, 'utf8');

	const counts = {
		manter_e_enriquecer: 0,
		consolidar: 0,
		revisar_manual: 0,
	};
	for (const r of rows) {
		if (counts[r.recomendacao] != null) counts[r.recomendacao] += 1;
	}

	console.log('=== Resumo ===\n');
	console.log(`Total de páginas:        ${rows.length}`);
	console.log(`manter_e_enriquecer:     ${counts.manter_e_enriquecer}`);
	console.log(`consolidar:              ${counts.consolidar}`);
	console.log(`revisar_manual:          ${counts.revisar_manual}`);
	console.log(`\nCSV: ${path.relative(ROOT, OUT_CSV)}`);
	console.log('\nNenhum arquivo de conteúdo foi alterado.\n');
	console.log(
		'Nota: o script legado scripts/audit-city-pages.mjs (área/REMOVER) permanece intacto.\n',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
