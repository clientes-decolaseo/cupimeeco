/**
 * Auditoria somente-leitura de páginas de cidade/bairro.
 *
 * Etapa 1 — Descoberta de pastas/arquivos
 * Etapa 2 — Extração de sinais de qualidade → scripts/.tmp-audit-cidades.csv
 * Etapa 3 — Severidade + resumo no console
 *
 * Uso: node scripts/audit-city-pages.mjs
 *      npm run audit:cidades
 */
import { readdir, readFile, writeFile, access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractLocationFromPath } from './lib/resolve-city.mjs';
import cidadesGsp from '../src/data/cidades-gsp.json' with { type: 'json' };

const ROOT = path.resolve('.');
const OUT_CSV = path.join(ROOT, 'scripts', '.tmp-audit-cidades.csv');
const OUT_PRIORIDADE = path.join(ROOT, 'scripts', '.tmp-audit-priorizacao.csv');

const OFFICIAL_PHONE_DIGITS = '08001117272';

/** Lista oficial Cupim Eco — 60 municípios (cidades-gsp.json / home / hubs de região) */
const MUNICIPIOS = cidadesGsp.municipios;
const ALIASES = cidadesGsp.aliases;
const BAIRROS_SP = new Set(cidadesGsp.bairrosSaoPaulo);
const ORDEM_CIDADES = cidadesGsp.ordemCidades;

const ALLOWED_EXTERNAL_SUFFIXES = [
	'cupins.eco.br',
	'anvisa.gov.br',
	'saude.gov.br',
	'wikipedia.org',
	'gov.br',
];

const WRONG_BRAND_RE =
	/\b(?:Universo(?:\s+Ambiental)?|OESTE\s*PRAGAS|Oeste\s*Pragas|Bio[\s-]*Solu[cç][oõ]es|biosolucoes|bio-solucoes|Combate\s+Ambiental|Cicero\s+Desentupidora)\b/gi;

const CITY_SLUG_RE =
	/^(?:dedetizadora-de-cupim|dedetizadora-de-ratos?|dedetizadora-de-barata|dedetizadora-de-formiga|dedetizadora-de-pulga|dedetizadora-de-carrapato|dedetizadora-de-escorpiao|dedetizadora-em|dedetizadora|descupinizacao|descupinizadora|empresa-de-descupinizacao|empresa-de-dedetizacao|empresa-de|desratizacao|desratizadora|sanitizacao|desinsetizacao)(?:-em|-no|-na|-de)?-.+/i;

const CITY_CONTENT_HINT_RE =
	/(?:dedetizadora-de-cupim-em-|dedetizadora-de-(?:ratos?|barata|formiga|pulga|carrapato|escorpiao)-|dedetizadora-em-|descupinizacao-em-|descupinizadora-|sanitizacao-em-|desratizacao-|empresa-de-)/i;

const PHONE_RE =
	/(?:0800[\s.\-]?\d{3}[\s.\-]?\d{4})|(?:\(?\d{2}\)?[\s.\-]\d{4,5}[\s.\-]\d{4})|(?:\+?55[\s.\-]?\(?\d{2}\)?[\s.\-]?\d{4,5}[\s.\-]?\d{4})/g;

const HREF_RE = /(?:href|src)=["']([^"']+)["']/gi;
const MALFORMED_URL_RE = /\b(?:ttp:\/\/|htps:\/\/|hhtp:\/\/|https?:\/(?!\/))/gi;
const PAGE_ID_PREVIEW_RE = /(?:\?|&|&amp;)(?:page_id=\d+|preview=true)/i;
const WP_UPLOADS_RE = /\/wp-content\/uploads\//i;

const CONTENT_EXTS = new Set(['.md', '.mdx', '.astro', '.json']);

const DISCOVERY_ROOTS = ['src/content', 'src/pages', 'src/data'];

function slugify(text) {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Extrai slug de localidade do path (padrão amplo de páginas de cidade).
 */
function extractLocationSlug(itemPath) {
	const fromLib = extractLocationFromPath(itemPath);
	if (fromLib) return fromLib;

	const segment = itemPath.split('/').pop() ?? itemPath;
	const match = segment.match(
		/(?:dedetizadora-de-cupim|dedetizadora-de-ratos?|dedetizadora-de-barata|dedetizadora-de-formiga|dedetizadora-de-pulga|dedetizadora-de-carrapato|dedetizadora-de-escorpiao|dedetizadora-em|dedetizadora|descupinizacao|descupinizadora|empresa-de-descupinizacao|empresa-de-dedetizacao|empresa-de|desratizacao|desratizadora|sanitizacao|desinsetizacao|dedetizacao)(?:-em|-no|-na|-de)?-(.+)$/i,
	);
	return match ? match[1].replace(/-\d+$/, '') : null;
}

function resolveOfficialCity(locationSlug) {
	if (!locationSlug) {
		return { cidade_detectada: '', area_atendimento: false, cityId: '' };
	}

	const slug = locationSlug.toLowerCase().replace(/^-+|-+$/g, '');

	if (BAIRROS_SP.has(slug) || /^(?:zona-(?:norte|sul|leste|oeste)|centro|moema|pinheiros|itaim|vila-)/i.test(slug)) {
		return {
			cidade_detectada: MUNICIPIOS['sao-paulo']?.nome ?? 'São Paulo',
			area_atendimento: true,
			cityId: 'sao-paulo',
		};
	}

	if (MUNICIPIOS[slug]) {
		return {
			cidade_detectada: MUNICIPIOS[slug].nome,
			area_atendimento: true,
			cityId: slug,
		};
	}

	const aliasKey = slug.replace(/-/g, ' ');
	const aliasId = ALIASES[aliasKey] ?? ALIASES[slug] ?? ALIASES[slugify(aliasKey)];
	if (aliasId && MUNICIPIOS[aliasId]) {
		return {
			cidade_detectada: MUNICIPIOS[aliasId].nome,
			area_atendimento: true,
			cityId: aliasId,
		};
	}

	// Fallback: nome legível do slug (fora da área)
	const label = slug
		.split('-')
		.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
		.join(' ');

	return { cidade_detectada: label || slug, area_atendimento: false, cityId: slug };
}

const ACAO_MANTER_POST = 'MANTER - conteúdo editorial, avaliar qualidade separadamente';
const ACAO_MANTER_OUTRO = 'MANTER - não é página WP de cidade';

/** "pagina" | "post" | "outro" conforme pasta WP */
function contentTypeFromRel(rel) {
	const norm = String(rel ?? '').replace(/\\/g, '/');
	if (norm.includes('src/data/wp/pages/')) return 'pagina';
	if (norm.includes('src/data/wp/posts/')) return 'post';
	return 'outro';
}

function priorityAction(areaAtendida, severidade, tipoConteudo) {
	if (tipoConteudo === 'post') return ACAO_MANTER_POST;
	if (tipoConteudo !== 'pagina') return ACAO_MANTER_OUTRO;
	if (!areaAtendida) return 'REMOVER - fora da área de atendimento';
	if (severidade >= 6) return 'REESCREVER - prioridade alta';
	if (severidade >= 3) return 'REESCREVER - prioridade média';
	return 'REVISAR - validar apenas';
}

function priorityRank(acao) {
	if (acao.startsWith('REESCREVER - prioridade alta')) return 0;
	if (acao.startsWith('REESCREVER - prioridade média')) return 1;
	if (acao.startsWith('REVISAR')) return 2;
	if (acao.startsWith('REMOVER')) return 3;
	return 4; // MANTER
}

function stripHtml(html = '') {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z#0-9]+;/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function countWords(text) {
	if (!text) return 0;
	return text.split(/\s+/).filter(Boolean).length;
}

function csvEscape(value) {
	const str = String(value ?? '');
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

async function pathExists(target) {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

async function walkFiles(dir, acc = []) {
	if (!(await pathExists(dir))) return acc;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkFiles(full, acc);
			continue;
		}
		const ext = path.extname(entry.name).toLowerCase();
		if (CONTENT_EXTS.has(ext)) acc.push(full);
	}
	return acc;
}

async function listImmediateSubdirs(dir) {
	if (!(await pathExists(dir))) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
}

function isCitySlug(slugOrPath) {
	const segment = (slugOrPath ?? '').replace(/^\/+|\/+$/g, '').split('/').pop() ?? '';
	if (!segment) return false;
	if (CITY_SLUG_RE.test(segment)) return true;
	if (CITY_CONTENT_HINT_RE.test(segment)) return true;
	return Boolean(extractLocationFromPath(segment));
}

function extractSlugFromPreview(rawPreview, filePath) {
	const slugField = rawPreview.match(/"(?:path|slug)"\s*:\s*"([^"]+)"/);
	if (slugField) return slugField[1];
	return path.basename(filePath, path.extname(filePath));
}

function fileLooksLikeCity(filePath, rawPreview) {
	const base = path.basename(filePath, path.extname(filePath));
	if (isCitySlug(base)) return true;
	if (CITY_CONTENT_HINT_RE.test(filePath.replace(/\\/g, '/'))) return true;

	const slugFromPreview = extractSlugFromPreview(rawPreview, filePath);
	if (isCitySlug(slugFromPreview)) return true;
	if (CITY_CONTENT_HINT_RE.test(rawPreview.slice(0, 4000))) return true;
	return false;
}

function parseContentFile(filePath, raw) {
	const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
	const ext = path.extname(filePath).toLowerCase();

	if (ext === '.json') {
		try {
			const data = JSON.parse(raw);
			const slug = data.path || data.slug || path.basename(filePath, '.json');
			const body = [data.title, data.excerpt, data.content, data.seo?.title, data.seo?.description]
				.filter(Boolean)
				.join('\n');
			return { rel, slug, body, raw };
		} catch {
			return null;
		}
	}

	if (ext === '.md' || ext === '.mdx') {
		const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
		let slug = path.basename(filePath, ext);
		let body = raw;
		if (fmMatch) {
			const fm = fmMatch[1];
			const slugFm = fm.match(/^(?:slug|path):\s*["']?([^"'\n]+)["']?/m);
			if (slugFm) slug = slugFm[1].trim();
			body = fmMatch[2];
		}
		return { rel, slug, body, raw };
	}

	if (ext === '.astro') {
		const slug = path
			.relative(path.join(ROOT, 'src/pages'), filePath)
			.replace(/\\/g, '/')
			.replace(/\.astro$/, '')
			.replace(/\/index$/, '');
		return { rel, slug, body: raw, raw };
	}

	return null;
}

function extractHrefs(text) {
	const hrefs = [];
	let match;
	const re = new RegExp(HREF_RE.source, HREF_RE.flags);
	while ((match = re.exec(text)) !== null) hrefs.push(match[1]);
	return hrefs;
}

function hostFromUrl(href) {
	try {
		const normalized = href.startsWith('//') ? `https:${href}` : href;
		if (!/^https?:\/\//i.test(normalized)) return null;
		return new URL(normalized).hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return null;
	}
}

function isAllowedHost(host) {
	if (!host) return true;
	for (const suffix of ALLOWED_EXTERNAL_SUFFIXES) {
		if (host === suffix || host.endsWith(`.${suffix}`)) return true;
	}
	return false;
}

function normalizePhone(phone) {
	return phone.replace(/\D/g, '');
}

function phonesDifferFromOfficial(phones) {
	if (!phones.length) return false;
	return phones.some((p) => {
		const digits = normalizePhone(p);
		if (!digits) return false;
		if (digits === OFFICIAL_PHONE_DIGITS) return false;
		if (digits === `55${OFFICIAL_PHONE_DIGITS}`) return false;
		return true;
	});
}

function findWrongBrandSnippet(text) {
	WRONG_BRAND_RE.lastIndex = 0;
	const match = WRONG_BRAND_RE.exec(text);
	if (!match) return null;
	const idx = match.index;
	const start = Math.max(0, idx - 40);
	const end = Math.min(text.length, idx + match[0].length + 40);
	return stripHtml(text.slice(start, end)).slice(0, 120);
}

function hasKeywordStuffingBlock(html) {
	const linkLabels = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) =>
		stripHtml(m[1]),
	);

	let streak = 0;
	for (const label of linkLabels) {
		const words = label.split(/\s+/).filter(Boolean);
		if (words.length > 0 && words.length <= 6 && label.length <= 80) {
			streak += 1;
			if (streak >= 15) return true;
		} else {
			streak = 0;
		}
	}

	const lines = stripHtml(html)
		.split(/(?<=[.!?])\s+|\n+/)
		.map((l) => l.trim())
		.filter(Boolean);

	streak = 0;
	for (const line of lines) {
		const words = line.split(/\s+/).filter(Boolean);
		if (words.length > 0 && words.length <= 6) {
			streak += 1;
			if (streak >= 15) return true;
		} else {
			streak = 0;
		}
	}

	return false;
}

function auditPage({ rel, slug, body, raw }) {
	const text = stripHtml(body);
	const words = countWords(text);
	const haystack = `${body}\n${raw}`;

	const brandSnippet = findWrongBrandSnippet(haystack);
	const wrongBrand = Boolean(brandSnippet);

	const hasWpUploads = WP_UPLOADS_RE.test(haystack);
	const hasPageIdPreview = PAGE_ID_PREVIEW_RE.test(haystack);

	const phones = [...new Set((haystack.match(PHONE_RE) ?? []).map((p) => p.trim()))];
	const wrongPhone = phonesDifferFromOfficial(phones);

	const hrefs = extractHrefs(body);
	const externalDomains = [];
	const malformed = [];

	for (const href of hrefs) {
		if (/^(?:ttp:\/\/|htps:\/\/|hhtp:\/\/)/i.test(href) || /^https?:\/(?!\/)/i.test(href)) {
			malformed.push(href);
		}
		const host = hostFromUrl(href);
		if (host && !isAllowedHost(host)) externalDomains.push(host);
	}

	for (const m of body.match(MALFORMED_URL_RE) ?? []) {
		if (!malformed.includes(m)) malformed.push(m);
	}

	const uniqueExternal = [...new Set(externalDomains)].sort();
	const hasMalformed = malformed.length > 0;
	const keywordStuffing = hasKeywordStuffingBlock(body);

	let severity = 0;
	if (wrongBrand) severity += 4;
	if (hasWpUploads) severity += 2;
	if (hasPageIdPreview) severity += 2;
	if (wrongPhone) severity += 1;
	if (hasMalformed || uniqueExternal.length > 0) severity += 1;
	severity = Math.min(10, severity);

	const url = `/${String(slug).replace(/^\/+|\/+$/g, '')}/`;
	const tipo_conteudo = contentTypeFromRel(rel);
	const locationSlug = extractLocationSlug(String(slug));
	const city = resolveOfficialCity(locationSlug);

	// area_atendimento e REMOVER/REESCREVER/REVISAR só para páginas WP
	const area_atendimento = tipo_conteudo === 'pagina' ? city.area_atendimento : '';
	const cidade_detectada = city.cidade_detectada;
	const acao = priorityAction(city.area_atendimento, severity, tipo_conteudo);

	return {
		arquivo: rel,
		tipo_conteudo,
		slug_url: url,
		cidade_detectada,
		area_atendimento,
		palavras: words,
		marca_errada: wrongBrand,
		marca_trecho: brandSnippet ?? '',
		wp_uploads: hasWpUploads,
		page_id_preview: hasPageIdPreview,
		telefones: phones.join(' | '),
		dominios_externos: uniqueExternal.join(' | '),
		links_malformados: malformed.join(' | '),
		bloco_keywords: keywordStuffing,
		severidade: severity,
		acao,
		_externalList: uniqueExternal,
		_phones: phones,
	};
}

/**
 * ETAPA 1 — Descoberta
 * @returns {Promise<string[] | null>} caminhos absolutos das páginas de cidade, ou null se nenhuma
 */
async function runDiscovery() {
	console.log('\n📂 Estrutura encontrada:\n');

	/** @type {Map<string, { files: string[]; cityFiles: string[] }>} */
	const folderStats = new Map();
	/** @type {string[]} */
	const allCityFiles = [];

	for (const rootRel of DISCOVERY_ROOTS) {
		const rootAbs = path.join(ROOT, rootRel);
		if (!(await pathExists(rootAbs))) {
			console.log(`  ${rootRel}/  → (pasta não existe)`);
			continue;
		}

		const rootStat = await stat(rootAbs);
		if (!rootStat.isDirectory()) continue;

		const subdirs = await listImmediateSubdirs(rootAbs);
		const targets = subdirs.length > 0 ? subdirs : [rootAbs];

		for (const dir of targets) {
			const files = await walkFiles(dir);
			const cityFiles = [];

			for (const file of files) {
				let preview = '';
				try {
					const buf = await readFile(file, 'utf8');
					preview = buf.slice(0, 8000);
				} catch {
					continue;
				}
				if (fileLooksLikeCity(file, preview)) {
					cityFiles.push(file);
					allCityFiles.push(file);
				}
			}

			const rel = path.relative(ROOT, dir).replace(/\\/g, '/');
			folderStats.set(rel, { files, cityFiles });
			const seemsCity = cityFiles.length > 0 ? 'sim' : 'não';
			console.log(
				`  ${rel}/  → ${files.length} arquivos (parece conter páginas de cidade: ${seemsCity})`,
			);
		}
	}

	console.log('');

	if (allCityFiles.length === 0) {
		console.log(
			'❌ Nenhum arquivo correspondente aos padrões de URL de cidade/bairro foi encontrado.\n' +
				'   Padrões procurados: dedetizadora-de-cupim-em-*, descupinizacao-em-*,\n' +
				'   descupinizadora-*, dedetizadora-de-ratos-*, dedetizadora-de-barata-*,\n' +
				'   sanitizacao-em-*, desratizacao-*, empresa-de-*\n\n' +
				'   Informe o caminho correto dos arquivos de conteúdo (ex.: src/data/wp/pages/)\n' +
				'   para que a auditoria possa continuar. Nenhuma etapa 2/3 foi executada.',
		);
		return null;
	}

	console.log(
		`✅ Descoberta: ${allCityFiles.length} arquivo(s) de cidade/bairro em ${folderStats.size} pasta(s) analisada(s).\n` +
			'   Iniciando Etapa 2 — Auditoria…\n',
	);

	return [...new Set(allCityFiles)];
}

async function runAudit(cityFiles) {
	const rows = [];
	/** @type {Map<string, number>} */
	const domainFreq = new Map();
	/** @type {Map<string, number>} */
	const phoneFreq = new Map();

	console.log(
		`📋 Área oficial: ${ORDEM_CIDADES.length} municípios em ${cidadesGsp.regioes.length} regiões ` +
			'(cidades-gsp.json — mesma base da home e /descupinizacao/regioes/).\n',
	);

	for (const file of cityFiles) {
		const raw = await readFile(file, 'utf8');
		const parsed = parseContentFile(file, raw);
		if (!parsed) continue;
		if (!isCitySlug(parsed.slug) && !fileLooksLikeCity(file, raw.slice(0, 8000))) continue;

		const row = auditPage(parsed);
		for (const d of row._externalList) {
			domainFreq.set(d, (domainFreq.get(d) ?? 0) + 1);
		}
		for (const p of row._phones) {
			phoneFreq.set(p, (phoneFreq.get(p) ?? 0) + 1);
		}
		delete row._externalList;
		delete row._phones;
		rows.push(row);
	}

	rows.sort((a, b) => b.severidade - a.severidade || a.slug_url.localeCompare(b.slug_url));

	const headers = [
		'arquivo',
		'tipo_conteudo',
		'slug_url',
		'cidade_detectada',
		'area_atendimento',
		'palavras',
		'marca_errada',
		'marca_trecho',
		'wp_uploads',
		'page_id_preview',
		'telefones',
		'dominios_externos',
		'links_malformados',
		'bloco_keywords',
		'severidade',
	];

	const csvLines = [
		headers.join(','),
		...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(',')),
	];

	await mkdir(path.dirname(OUT_CSV), { recursive: true });
	await writeFile(OUT_CSV, `${csvLines.join('\n')}\n`, 'utf8');

	const baixa = rows.filter((r) => r.severidade <= 2).length;
	const media = rows.filter((r) => r.severidade >= 3 && r.severidade <= 5).length;
	const critica = rows.filter((r) => r.severidade >= 6).length;

	console.log('=== Etapa 3 — Resumo ===\n');
	console.log(`Total de páginas auditadas: ${rows.length}`);
	console.log(`Severidade 0–2 (baixa):    ${baixa}`);
	console.log(`Severidade 3–5 (média):    ${media}`);
	console.log(`Severidade 6–10 (crítica): ${critica}`);
	console.log(`\nCSV: ${path.relative(ROOT, OUT_CSV)}`);

	// ——— Etapa 4 — Priorização ———
	const prioridade = [...rows].sort((a, b) => {
		const ra = priorityRank(a.acao);
		const rb = priorityRank(b.acao);
		if (ra !== rb) return ra - rb;
		if (b.severidade !== a.severidade) return b.severidade - a.severidade;
		return a.slug_url.localeCompare(b.slug_url);
	});

	const prioHeaders = [
		'acao',
		'arquivo',
		'tipo_conteudo',
		'slug_url',
		'cidade_detectada',
		'area_atendimento',
		'severidade',
		'palavras',
		'marca_errada',
		'marca_trecho',
		'wp_uploads',
		'page_id_preview',
		'telefones',
		'dominios_externos',
		'links_malformados',
		'bloco_keywords',
	];

	const prioCsv = [
		prioHeaders.join(','),
		...prioridade.map((row) => prioHeaders.map((h) => csvEscape(row[h])).join(',')),
	];

	await writeFile(OUT_PRIORIDADE, `${prioCsv.join('\n')}\n`, 'utf8');

	const catAlta = prioridade.filter((r) => r.acao.startsWith('REESCREVER - prioridade alta')).length;
	const catMedia = prioridade.filter((r) => r.acao.startsWith('REESCREVER - prioridade média')).length;
	const catRevisar = prioridade.filter((r) => r.acao.startsWith('REVISAR')).length;
	const catRemover = prioridade.filter((r) => r.acao.startsWith('REMOVER')).length;
	const catManterPost = prioridade.filter((r) => r.acao === ACAO_MANTER_POST).length;
	const catManterOutro = prioridade.filter((r) => r.acao === ACAO_MANTER_OUTRO).length;
	const nPaginas = prioridade.filter((r) => r.tipo_conteudo === 'pagina').length;
	const nPosts = prioridade.filter((r) => r.tipo_conteudo === 'post').length;

	console.log('\n=== Etapa 4 — Priorização ===\n');
	console.log(`CSV priorização: ${path.relative(ROOT, OUT_PRIORIDADE)}\n`);
	console.log(`Tipo: páginas=${nPaginas} | posts=${nPosts} | outros=${prioridade.length - nPaginas - nPosts}`);
	console.log('Categorias de ação (REESCREVER/REVISAR/REMOVER só em páginas):');
	console.log(`  REESCREVER - prioridade alta  (página + área + sev 6–10): ${catAlta}`);
	console.log(`  REESCREVER - prioridade média (página + área + sev 3–5):  ${catMedia}`);
	console.log(`  REVISAR - validar apenas      (página + área + sev 0–2):  ${catRevisar}`);
	console.log(`  REMOVER - fora da área        (página fora das 60):       ${catRemover}`);
	console.log(`  MANTER - post editorial:       ${catManterPost}`);
	console.log(`  MANTER - outro arquivo:        ${catManterOutro}`);

	const topDomains = [...domainFreq.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 20);

	console.log(`\nTop 20 domínios externos (por páginas):`);
	if (topDomains.length === 0) console.log('  (nenhum)');
	else {
		for (const [domain, count] of topDomains) {
			console.log(`  ${String(count).padStart(4)} × ${domain}`);
		}
	}

	const phonesSorted = [...phoneFreq.entries()].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
	);

	console.log(`\nTelefones únicos (${phonesSorted.length}) — páginas onde aparece:`);
	if (phonesSorted.length === 0) console.log('  (nenhum)');
	else {
		for (const [phone, count] of phonesSorted) {
			const digits = phone.replace(/\D/g, '');
			const isOfficial =
				digits === OFFICIAL_PHONE_DIGITS || digits === `55${OFFICIAL_PHONE_DIGITS}`;
			const tag = isOfficial ? ' ← oficial Cupim Eco' : '';
			console.log(`  ${String(count).padStart(4)} × ${phone}${tag}`);
		}
	}

	if (rows.length > 0) {
		console.log('\nTop 10 por severidade (auditoria):');
		for (const row of rows.slice(0, 10)) {
			console.log(
				`  [${row.severidade}] ${row.slug_url} — ${row.cidade_detectada} (área=${row.area_atendimento}) → ${row.acao}`,
			);
		}
	}
}

async function main() {
	const cityFiles = await runDiscovery();
	if (!cityFiles) process.exit(1);
	await runAudit(cityFiles);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
