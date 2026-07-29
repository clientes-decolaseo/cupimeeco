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
const OUT_CSV_PREV = path.join(ROOT, 'scripts', '.tmp-audit-cidades.prev.csv');
const OUT_PRIORIDADE_PREV = path.join(ROOT, 'scripts', '.tmp-audit-priorizacao.prev.csv');
/** Baseline dos 615 (pré-expansão title) — nunca sobrescrever depois de criado. */
const OUT_CSV_BASELINE615 = path.join(ROOT, 'scripts', '.tmp-audit-cidades.baseline615.csv');
const OUT_PRIORIDADE_BASELINE615 = path.join(
	ROOT,
	'scripts',
	'.tmp-audit-priorizacao.baseline615.csv',
);
/** Snapshot imediatamente antes da correção de cidade_detectada via title. */
const OUT_CSV_PRE_CITYFIX = path.join(ROOT, 'scripts', '.tmp-audit-cidades.pre-cityfix.csv');
const OUT_PRIORIDADE_PRE_CITYFIX = path.join(
	ROOT,
	'scripts',
	'.tmp-audit-priorizacao.pre-cityfix.csv',
);
const WP_PAGES_DIR = path.join(ROOT, 'src', 'data', 'wp', 'pages');
const WP_POSTS_DIR = path.join(ROOT, 'src', 'data', 'wp', 'posts');


/**
 * Capitais / cidades de outros estados vistas na auditoria (title "em X").
 * Expandida conforme aparecem; fora da área → REMOVER nas páginas.
 */
const OUT_OF_STATE_CITIES = [
	'Curitiba',
	'Salvador',
	'Rio de Janeiro',
	'RJ',
	'Recife',
	'Fortaleza',
	'Maceió',
	'Maceio',
	'Macapá',
	'Macapa',
	'Belo Horizonte',
	'Porto Alegre',
	'Brasília',
	'Brasilia',
	'Goiânia',
	'Goiania',
	'Belém',
	'Belem',
	'Natal',
	'Florianópolis',
	'Florianopolis',
	'Manaus',
	'Vitória',
	'Vitoria',
	'João Pessoa',
	'Joao Pessoa',
	'Teresina',
	'Cuiabá',
	'Cuiaba',
	'Campo Grande',
	'Aracaju',
	'Palmas',
	'São Luís',
	'Sao Luis',
	'Porto Velho',
	'Rio Branco',
	'Boa Vista',
];



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

/**
 * Telefones BR:
 * - 0800 XXX XXXX
 * - (DD) NNNN-NNNN  (fixo, 8 dígitos) e (DD) NNNNN-NNNN (celular, 9)
 * - compacto sem espaço após DDD: (DD)NNNNN-NNNN
 * - com 55 / +55, com ou sem separadores
 */
const PHONE_RE =
	/(?:0800[\s.\-]?\d{3}[\s.\-]?\d{4})|(?:\(\d{2}\)\s*\d{4,5}[\s.\-]?\d{4})|(?:\(?\d{2}\)?[\s.\-]\d{4,5}[\s.\-]\d{4})|(?:\+?55[\s.\-]?\(?\d{2}\)?[\s.\-]?\d{4,5}[\s.\-]?\d{4})|(?:\+?55\d{10,11})/g;

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

/**
 * Contagem bruta de .json em um diretório (recursivo), sem filtro de cidade.
 * @returns {Promise<string[]>} caminhos absolutos
 */
async function listJsonFilesRaw(dir, acc = []) {
	if (!(await pathExists(dir))) return acc;
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await listJsonFilesRaw(full, acc);
			continue;
		}
		if (path.extname(entry.name).toLowerCase() === '.json') acc.push(full);
	}
	return acc;
}

function escapeRegExp(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Nomes oficiais para checagem SOLTA (title/conteúdo): municípios, labels de
 * região e zonas da capital. Ordenados do mais longo ao mais curto.
 */
function buildLooseLocationNames() {
	/** @type {Set<string>} */
	const names = new Set();

	for (const m of Object.values(MUNICIPIOS ?? {})) {
		if (m?.nome) names.add(String(m.nome).trim());
	}

	for (const r of cidadesGsp.regioes ?? []) {
		const label = String(r?.label ?? '').trim();
		if (!label) continue;
		names.add(label);
		const stripped = label.replace(/^Região\s+(?:de|do|da)\s+/i, '').trim();
		if (stripped.length >= 4) names.add(stripped);
	}

	for (const z of ['Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste']) {
		names.add(z);
	}

	return [...names]
		.filter((n) => n.length >= 3)
		.sort((a, b) => b.length - a.length || a.localeCompare(b, 'pt-BR'));
}

const LOOSE_LOCATION_NAMES = buildLooseLocationNames();

/** Preposição + nome oficial (checagem solta; não altera fileLooksLikeCity). */
const LOOSE_LOCATION_RE = new RegExp(
	`(^|[^\\p{L}])(?:em|na|no|nas|nos)\\s+(?:${LOOSE_LOCATION_NAMES.map(escapeRegExp).join('|')})(?=$|[^\\p{L}])`,
	'iu',
);

/**
 * Procura menção solta a cidade/região/zona em title ou conteúdo.
 * @returns {{ matched: string, field: string, trecho: string } | null}
 */
function findLooseLocationMention(title, content) {
	const haystacks = [
		{ field: 'title', text: String(title ?? '') },
		{ field: 'content', text: stripHtml(String(content ?? '')) },
	];

	for (const { field, text } of haystacks) {
		if (!text) continue;
		LOOSE_LOCATION_RE.lastIndex = 0;
		const m = LOOSE_LOCATION_RE.exec(text);
		if (!m) continue;
		const full = m[0].replace(/^[^\p{L}]+/u, '').trim();
		const idx = m.index + (m[0].length - full.length);
		const start = Math.max(0, idx - 50);
		const end = Math.min(text.length, idx + full.length + 50);
		return {
			matched: full,
			field,
			trecho: text.slice(start, end).replace(/\s+/g, ' ').trim(),
		};
	}
	return null;
}

/**
 * Diagnostica por que um JSON de pages/posts não entrou no CSV do audit.
 * @param {string} absPath
 * @param {Set<string>} discoveryAbsSet caminhos absolutos normalizados da Etapa 1
 * @returns {Promise<{ rel: string, razao: string }>}
 */
async function diagnoseWpFileExclusion(absPath, discoveryAbsSet) {
	const rel = path.relative(ROOT, absPath).replace(/\\/g, '/');
	const base = path.basename(absPath);
	const absNorm = path.resolve(absPath);

	let raw;
	try {
		raw = await readFile(absPath, 'utf8');
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			rel,
			razao: `exceção silenciosa/falha na leitura do arquivo (${msg})`,
		};
	}

	if (base.toLowerCase() === 'manifest.json') {
		return {
			rel,
			razao: 'nome de arquivo especial (manifest.json) — não é página/post de conteúdo auditável',
		};
	}

	const looksNumericId = /^\d+\.json$/i.test(base);
	const preview = raw.slice(0, 8000);
	const looksCity = fileLooksLikeCityExpanded(absPath, preview);

	if (!looksCity) {
		const slugHint = extractSlugFromPreview(preview, absPath);
		return {
			rel,
			razao:
				`filtrado na Etapa 1 (descoberta) — fileLooksLikeCityExpanded=false` +
				` (basename=${JSON.stringify(base)}, slug_preview=${JSON.stringify(slugHint)}` +
				`${looksNumericId ? '' : '; nome fora do padrão N.json'})`,
		};
	}

	if (!discoveryAbsSet.has(absNorm)) {
		return {
			rel,
			razao:
				'parece página de cidade, mas não entrou no conjunto da Etapa 1' +
				' (possível exceção silenciosa na leitura durante a descoberta, ou fora dos DISCOVERY_ROOTS)',
		};
	}

	const parsed = parseContentFile(absPath, raw);
	if (!parsed) {
		return {
			rel,
			razao: 'erro de parse do JSON na Etapa 2 (parseContentFile retornou null — JSON inválido ou extensão inesperada)',
		};
	}

	if (!isCitySlug(parsed.slug) && !fileLooksLikeCityExpanded(absPath, raw)) {
		return {
			rel,
			razao:
				`filtrado na Etapa 2 — slug=${JSON.stringify(parsed.slug)}` +
				' não passou em isCitySlug nem fileLooksLikeCityExpanded na revalidação',
		};
	}

	return {
		rel,
		razao:
			'passou nos filtros conhecidos mas ausente do CSV (causa desconhecida — investigar; possível race/dedupe)',
	};
}

/**
 * Classifica ausentes do CSV com checagem SOLTA (preposição + cidade no title/conteúdo).
 * Não altera fileLooksLikeCity nem o CSV.
 * @param {string[]} missingAbs
 */
async function classifyMissingByLooseLocation(missingAbs) {
	/** @type {{ arquivo: string, title: string, matched: string, field: string, trecho: string }[]} */
	const provavel = [];
	/** @type {{ arquivo: string, title: string }[]} */
	const generico = [];

	for (const abs of missingAbs) {
		const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
		let title = '';
		let content = '';
		try {
			const data = JSON.parse(await readFile(abs, 'utf8'));
			title = String(data?.title ?? data?.seo?.title ?? '');
			content = String(data?.content ?? data?.excerpt ?? '');
		} catch {
			generico.push({ arquivo: rel, title: '(JSON inválido / ilegível)' });
			continue;
		}

		const hit = findLooseLocationMention(title, content);
		if (hit) {
			provavel.push({
				arquivo: rel,
				title: title.slice(0, 160),
				matched: hit.matched,
				field: hit.field,
				trecho: hit.trecho.slice(0, 220),
			});
		} else {
			generico.push({ arquivo: rel, title: title.slice(0, 160) });
		}
	}

	return { provavel, generico };
}

/**
 * Checagem de integridade: todos os .json em wp/pages + wp/posts vs linhas do CSV.
 * Sempre imprime aviso (diagnóstico; não corrige nada).
 * @param {Array<{ arquivo: string }>} csvRows
 * @param {string[]} discoveryFiles caminhos absolutos da Etapa 1
 */
async function reportWpJsonIntegrity(csvRows, discoveryFiles) {
	const pagesJson = await listJsonFilesRaw(WP_PAGES_DIR);
	const postsJson = await listJsonFilesRaw(WP_POSTS_DIR);
	const diskFiles = [...pagesJson, ...postsJson].sort((a, b) =>
		path.relative(ROOT, a).localeCompare(path.relative(ROOT, b)),
	);

	const csvArquivos = new Set(
		csvRows.map((r) => String(r.arquivo ?? '').replace(/\\/g, '/')),
	);
	const discoveryAbsSet = new Set(discoveryFiles.map((f) => path.resolve(f)));

	const missing = [];
	for (const abs of diskFiles) {
		const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
		if (!csvArquivos.has(rel)) missing.push(abs);
	}

	console.log('\n⚠ === Integridade WP JSON (pages + posts) ===\n');
	console.log(`  .json em disco src/data/wp/pages/: ${pagesJson.length}`);
	console.log(`  .json em disco src/data/wp/posts/: ${postsJson.length}`);
	console.log(`  Total bruto em disco (pages+posts): ${diskFiles.length}`);
	console.log(`  Linhas de dados no CSV final:       ${csvRows.length}`);
	console.log(
		`  Em disco e AUSENTES do CSV:           ${missing.length}` +
			(missing.length === 0 ? ' ✓' : ''),
	);

	if (missing.length === 0) {
		console.log('\n  Nenhum arquivo pages/posts ficou de fora do CSV.\n');
		return;
	}

	/** @type {{ rel: string, razao: string }[]} */
	const diagnosed = [];
	/** @type {Map<string, number>} */
	const allBuckets = new Map();

	for (const abs of missing) {
		const d = await diagnoseWpFileExclusion(abs, discoveryAbsSet);
		diagnosed.push(d);
		const bucketKey = d.razao.split(' — ')[0].split(' (')[0];
		allBuckets.set(bucketKey, (allBuckets.get(bucketKey) ?? 0) + 1);
	}

	const sample = diagnosed.slice(0, 30);
	console.log(`\n  Primeiros ${sample.length} ausentes (de ${missing.length}) e razão provável:\n`);

	for (const { rel, razao } of sample) {
		console.log(`  - ${rel}`);
		console.log(`      → ${razao}`);
	}

	if (missing.length > 30) {
		console.log(`\n  … +${missing.length - 30} outros ausentes não listados.`);
	}

	console.log('\n  Resumo de motivos (todos os ausentes):');
	for (const [motivo, n] of [...allBuckets.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`    ${String(n).padStart(5)} × ${motivo}`);
	}

	// ——— Segunda checagem (solta): preposição + cidade no title/conteúdo ———
	const { provavel, generico } = await classifyMissingByLooseLocation(missing);

	console.log('\n⚠ === Classificação dos ausentes (checagem SOLTA title/conteúdo) ===\n');
	console.log(
		`  Nomes oficiais usados na checagem solta: ${LOOSE_LOCATION_NAMES.length}` +
			' (municípios + regiões + Zona N/S/L/O)',
	);
	console.log(`  GENUINAMENTE_GENERICO:           ${generico.length}`);
	console.log(`  PROVAVEL_PAGINA_CIDADE_PERDIDA:   ${provavel.length}`);

	console.log(
		`\n--- GENUINAMENTE_GENERICO (${generico.length}) — sem preposição+cidade oficial no title/conteúdo ---\n`,
	);
	if (generico.length === 0) {
		console.log('  (nenhum)\n');
	} else {
		const genSample = generico.slice(0, 15);
		for (const g of genSample) {
			console.log(`  - ${g.arquivo}`);
			if (g.title) console.log(`      title: ${g.title}`);
		}
		if (generico.length > 15) {
			console.log(`\n  … +${generico.length - 15} outros genuinamente genéricos.`);
		}
		console.log('');
	}

	console.log(
		`--- PROVAVEL_PAGINA_CIDADE_PERDIDA (${provavel.length}) — lista completa (candidatos a bug de regex) ---\n`,
	);
	if (provavel.length === 0) {
		console.log('  (nenhum)\n');
	} else {
		for (const p of provavel) {
			console.log(`  - ${p.arquivo}`);
			console.log(`      title:  ${p.title || '(sem title)'}`);
			console.log(`      match:  ${JSON.stringify(p.matched)} (campo: ${p.field})`);
			console.log(`      trecho: ${p.trecho}`);
			console.log('');
		}
	}

	const outGrupos = path.join(ROOT, 'scripts', '.tmp-audit-integridade-grupos.json');
	await writeFile(
		outGrupos,
		`${JSON.stringify(
			{
				gerado_em: new Date().toISOString(),
				ausentes_total: missing.length,
				GENUINAMENTE_GENERICO: generico,
				PROVAVEL_PAGINA_CIDADE_PERDIDA: provavel,
			},
			null,
			2,
		)}\n`,
		'utf8',
	);
	console.log(`  JSON dos grupos: ${path.relative(ROOT, outGrupos)}\n`);
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

function decodeBasicEntities(s) {
	return String(s ?? '')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ');
}

/**
 * Extrai "title" do JSON (preview ou arquivo completo).
 */
function extractTitleFromPreview(rawPreview) {
	const m = String(rawPreview ?? '').match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
	if (!m) return '';
	try {
		return decodeBasicEntities(JSON.parse(`"${m[1]}"`));
	} catch {
		return decodeBasicEntities(m[1].replace(/\\"/g, '"'));
	}
}

/**
 * Nomes para match de TITLE: municípios, aliases oficiais, zonas e
 * capitais/cidades de outros estados já vistas na auditoria.
 */
function buildTitleLocationNames() {
	/** @type {Set<string>} */
	const names = new Set();

	for (const m of Object.values(MUNICIPIOS ?? {})) {
		if (m?.nome) names.add(String(m.nome).trim());
	}

	for (const alias of Object.keys(ALIASES ?? {})) {
		const a = String(alias).trim();
		if (a.length < 2) continue;
		if (a === 'capital') continue;
		names.add(a);
		names.add(
			a
				.split(/\s+/)
				.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
				.join(' '),
		);
	}

	for (const z of ['Zona Norte', 'Zona Sul', 'Zona Leste', 'Zona Oeste']) {
		names.add(z);
	}

	for (const c of OUT_OF_STATE_CITIES) names.add(c);

	return [...names]
		.filter((n) => n.length >= 2)
		.sort((a, b) => b.length - a.length || a.localeCompare(b, 'pt-BR'));
}

const TITLE_LOCATION_NAMES = buildTitleLocationNames();

/** Preposição + localidade no TITLE (case-insensitive). */
const TITLE_LOCATION_RE = new RegExp(
	`(^|[^\\p{L}])(?:em|na|no|nas|nos)\\s+(?:${TITLE_LOCATION_NAMES.map(escapeRegExp).join('|')})(?=$|[^\\p{L}])`,
	'iu',
);

/**
 * @returns {{ matched: string, place: string } | null}
 */
function matchTitleLocation(title) {
	const text = decodeBasicEntities(title);
	if (!text) return null;
	TITLE_LOCATION_RE.lastIndex = 0;
	const m = TITLE_LOCATION_RE.exec(text);
	if (!m) return null;
	const full = m[0].replace(/^[^\p{L}]+/u, '').trim();
	const place = full.replace(/^(?:em|na|no|nas|nos)\s+/i, '').trim();
	return { matched: full, place };
}

/**
 * Resolve nome de localidade (vindo do title) → cidade oficial / fora da área.
 * @param {string} placeName
 */
function resolvePlaceNameToCity(placeName) {
	const raw = decodeBasicEntities(placeName).trim();
	if (!raw) {
		return { cidade_detectada: '', area_atendimento: false, cityId: '' };
	}

	if (/^zona\s+(norte|sul|leste|oeste)$/i.test(raw)) {
		return {
			cidade_detectada: MUNICIPIOS['sao-paulo']?.nome ?? 'São Paulo',
			area_atendimento: true,
			cityId: 'sao-paulo',
		};
	}

	const slug = slugify(raw);
	const lower = raw.toLowerCase();

	// Alias direto (sp, rj, zona sul, …)
	const aliasId =
		ALIASES[lower] ?? ALIASES[slug] ?? ALIASES[slug.replace(/-/g, ' ')] ?? ALIASES[raw];
	if (aliasId && MUNICIPIOS[aliasId]) {
		return {
			cidade_detectada: MUNICIPIOS[aliasId].nome,
			area_atendimento: true,
			cityId: aliasId,
		};
	}

	if (MUNICIPIOS[slug]) {
		return {
			cidade_detectada: MUNICIPIOS[slug].nome,
			area_atendimento: true,
			cityId: slug,
		};
	}

	// Match por nome oficial (acentos)
	for (const [id, m] of Object.entries(MUNICIPIOS ?? {})) {
		if (m?.nome && slugify(m.nome) === slug) {
			return {
				cidade_detectada: m.nome,
				area_atendimento: true,
				cityId: id,
			};
		}
	}

	// Outro estado / capital fora da lista oficial
	const outHit = OUT_OF_STATE_CITIES.find((c) => slugify(c) === slug || c.toLowerCase() === lower);
	if (outHit) {
		return {
			cidade_detectada: outHit === 'RJ' ? 'Rio de Janeiro' : outHit,
			area_atendimento: false,
			cityId: slug || 'outro-estado',
		};
	}

	return resolveOfficialCity(slug);
}

/**
 * Mesma lógica expandida da descoberta: slug/path OU title (prep + local).
 * Prefere slug quando já resolve área oficial.
 * Title como fallback — exceto nos 615 da baseline (não-regressão de ação).
 * @param {string} slug
 * @param {string} title
 * @param {{ allowTitleFallback?: boolean }} [opts]
 */
function resolveCityExpanded(slug, title, opts = {}) {
	const allowTitleFallback = opts.allowTitleFallback !== false;
	const locationSlug = extractLocationSlug(String(slug ?? ''));
	const fromSlug = resolveOfficialCity(locationSlug);

	if (fromSlug.area_atendimento) {
		return { ...fromSlug, fonte: 'slug' };
	}

	if (allowTitleFallback) {
		const titleHit = matchTitleLocation(title);
		if (titleHit?.place) {
			const fromTitle = resolvePlaceNameToCity(titleHit.place);
			if (fromTitle.cidade_detectada || fromTitle.area_atendimento) {
				return { ...fromTitle, fonte: 'title', title_match: titleHit.matched };
			}
		}
	}

	return { ...fromSlug, fonte: locationSlug ? 'slug' : 'nenhuma' };
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

/**
 * Ampliação: padrões de slug atuais OU title com prep + cidade/alias/zona/outro estado.
 * Não altera regras de tipo_conteudo / area_atendimento — só o universo de candidatos.
 */
function fileLooksLikeCityExpanded(filePath, rawPreview) {
	if (fileLooksLikeCity(filePath, rawPreview)) return true;
	const title = extractTitleFromPreview(rawPreview);
	return Boolean(matchTitleLocation(title));
}

function parseContentFile(filePath, raw) {
	const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
	const ext = path.extname(filePath).toLowerCase();

	if (ext === '.json') {
		try {
			const data = JSON.parse(raw);
			const slug = data.path || data.slug || path.basename(filePath, '.json');
			const title = String(data.title ?? data.seo?.title ?? '');
			const body = [data.title, data.excerpt, data.content, data.seo?.title, data.seo?.description]
				.filter(Boolean)
				.join('\n');
			return { rel, slug, title, body, raw };
		} catch {
			return null;
		}
	}

	if (ext === '.md' || ext === '.mdx') {
		const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
		let slug = path.basename(filePath, ext);
		let title = '';
		let body = raw;
		if (fmMatch) {
			const fm = fmMatch[1];
			const slugFm = fm.match(/^(?:slug|path):\s*["']?([^"'\n]+)["']?/m);
			if (slugFm) slug = slugFm[1].trim();
			const titleFm = fm.match(/^title:\s*["']?([^"'\n]+)["']?/m);
			if (titleFm) title = titleFm[1].trim();
			body = fmMatch[2];
		}
		return { rel, slug, title, body, raw };
	}

	if (ext === '.astro') {
		const slug = path
			.relative(path.join(ROOT, 'src/pages'), filePath)
			.replace(/\\/g, '/')
			.replace(/\.astro$/, '')
			.replace(/\/index$/, '');
		return { rel, slug, title: '', body: raw, raw };
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

function auditPage({ rel, slug, body, raw, title }, opts = {}) {
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
	const pageTitle = title || extractTitleFromPreview(raw);
	const city = resolveCityExpanded(String(slug), pageTitle, {
		allowTitleFallback: opts.allowTitleFallback !== false,
	});

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
		_title: pageTitle,
		_city_fonte: city.fonte ?? '',
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
				if (fileLooksLikeCityExpanded(file, preview)) {
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

/**
 * Parse CSV simples (com aspas) → array de objetos.
 * @param {string} raw
 * @returns {Record<string, string>[]}
 */
function parseCsvObjects(raw) {
	const lines = String(raw ?? '')
		.split(/\r?\n/)
		.filter((l) => l.trim().length > 0);
	if (lines.length === 0) return [];

	const parseLine = (line) => {
		const cells = [];
		let cur = '';
		let q = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (q) {
				if (ch === '"' && line[i + 1] === '"') {
					cur += '"';
					i++;
				} else if (ch === '"') q = false;
				else cur += ch;
			} else if (ch === '"') q = true;
			else if (ch === ',') {
				cells.push(cur);
				cur = '';
			} else cur += ch;
		}
		cells.push(cur);
		return cells;
	};

	const headers = parseLine(lines[0]).map((h) => h.trim());
	return lines.slice(1).map((line) => {
		const cells = parseLine(line);
		/** @type {Record<string, string>} */
		const row = {};
		headers.forEach((h, i) => {
			row[h] = cells[i] ?? '';
		});
		return row;
	});
}

function acaoBucket(acao) {
	const a = String(acao ?? '');
	if (a.startsWith('REMOVER')) return 'REMOVER';
	if (a.startsWith('REESCREVER')) return 'REESCREVER';
	if (a.startsWith('REVISAR')) return 'REVISAR';
	if (a === ACAO_MANTER_POST || /editorial/i.test(a)) return 'MANTER-editorial';
	if (a.startsWith('MANTER')) return 'MANTER-outro';
	return a || '(vazio)';
}

/**
 * Compara rodada atual com baseline 615 + pré-cityfix (não-regressão + flips REMOVER).
 * @param {Array<{ arquivo: string, tipo_conteudo: string, acao: string, cidade_detectada?: string }>} prioridadeAtual
 * @param {Map<string, { title: string, fonte: string }>} metaByArquivo
 */
async function reportAuditDeltaVsPrevious(prioridadeAtual, metaByArquivo = new Map()) {
	console.log('\n=== Delta / não-regressão (cidade via title) ===\n');

	const baselinePath = (await pathExists(OUT_PRIORIDADE_BASELINE615))
		? OUT_PRIORIDADE_BASELINE615
		: OUT_PRIORIDADE_PREV;
	const preFixPath = (await pathExists(OUT_PRIORIDADE_PRE_CITYFIX))
		? OUT_PRIORIDADE_PRE_CITYFIX
		: null;

	if (!(await pathExists(baselinePath))) {
		console.log('  (sem baseline 615 — impossível auditar não-regressão)\n');
		return;
	}

	const baseline = parseCsvObjects(await readFile(baselinePath, 'utf8'));
	const preFix = preFixPath ? parseCsvObjects(await readFile(preFixPath, 'utf8')) : [];

	/** @type {Map<string, string>} */
	const baselineAcao = new Map();
	for (const r of baseline) {
		const arq = String(r.arquivo ?? '').replace(/\\/g, '/');
		if (arq) baselineAcao.set(arq, String(r.acao ?? ''));
	}

	/** @type {Map<string, { acao: string, cidade: string, tipo: string }>} */
	const preFixByArq = new Map();
	for (const r of preFix) {
		const arq = String(r.arquivo ?? '').replace(/\\/g, '/');
		if (!arq) continue;
		preFixByArq.set(arq, {
			acao: String(r.acao ?? ''),
			cidade: String(r.cidade_detectada ?? ''),
			tipo: String(r.tipo_conteudo ?? ''),
		});
	}

	/** @type {Map<string, { acao: string, cidade: string, tipo: string }>} */
	const currByArq = new Map();
	for (const r of prioridadeAtual) {
		const arq = String(r.arquivo ?? '').replace(/\\/g, '/');
		currByArq.set(arq, {
			acao: String(r.acao ?? ''),
			cidade: String(r.cidade_detectada ?? ''),
			tipo: String(r.tipo_conteudo ?? ''),
		});
	}

	// ——— Não-regressão dos 615 ———
	let regressoes615 = 0;
	const regressaoSamples = [];
	for (const [arq, acaoPrev] of baselineAcao) {
		const curr = currByArq.get(arq);
		if (!curr) {
			regressoes615 += 1;
			if (regressaoSamples.length < 10) {
				regressaoSamples.push({ arquivo: arq, antes: acaoPrev, depois: '(ausente)' });
			}
			continue;
		}
		if (curr.acao !== acaoPrev) {
			regressoes615 += 1;
			if (regressaoSamples.length < 10) {
				regressaoSamples.push({ arquivo: arq, antes: acaoPrev, depois: curr.acao });
			}
		}
	}

	console.log(`  Baseline original (pré-expansão): ${baselineAcao.size} arquivos`);
	console.log(`  Total agora:                      ${currByArq.size}`);
	console.log(`  Regressões de ação nos 615:       ${regressoes615}`);
	if (regressoes615 === 0) {
		console.log('  ✓ Não-regressão: os 615 originais mantêm ação idêntica.');
	} else {
		console.log('  ⚠ REGRESSÃO nos 615 — amostras:');
		for (const s of regressaoSamples) {
			console.log(`    - ${s.arquivo}`);
			console.log(`        antes:  ${s.antes}`);
			console.log(`        depois: ${s.depois}`);
		}
	}

	// ——— Os 42 REMOVER do delta (novos da expansão) ———
	const removerAntes = [];
	for (const [arq, info] of preFixByArq) {
		if (baselineAcao.has(arq)) continue; // só os NOVOS (delta)
		if (!info.acao.startsWith('REMOVER')) continue;
		if (info.tipo !== 'pagina') continue;
		removerAntes.push(arq);
	}

	const flips = [];
	const stillRemover = [];
	for (const arq of removerAntes) {
		const antes = preFixByArq.get(arq);
		const depois = currByArq.get(arq);
		if (!depois) continue;
		const meta = metaByArquivo.get(arq) ?? { title: '', fonte: '' };
		if (depois.acao !== antes.acao) {
			flips.push({
				arquivo: arq,
				title: meta.title,
				cidade: depois.cidade,
				antes: antes.acao,
				depois: depois.acao,
				fonte: meta.fonte,
			});
		} else {
			stillRemover.push({
				arquivo: arq,
				title: meta.title,
				cidade: depois.cidade,
				acao: depois.acao,
			});
		}
	}

	console.log(`\n  REMOVER no delta (pré-cityfix, só páginas novas): ${removerAntes.length}`);
	console.log(`  Destes, MUDARAM de ação após correção:          ${flips.length}`);
	console.log(`  Continuam REMOVER:                              ${stillRemover.length}`);

	if (flips.length > 0) {
		console.log('\n--- Flips REMOVER → outra ação (lista nominal) ---\n');
		for (const f of flips) {
			console.log(`  - ${f.arquivo}`);
			console.log(`      title:   ${f.title || '(sem title)'}`);
			console.log(`      cidade:  ${f.cidade || '(vazia)'} (fonte=${f.fonte || '?'})`);
			console.log(`      ação:    ${acaoBucket(f.antes)} → ${acaoBucket(f.depois)}`);
			console.log(`      detalhe: ${f.antes}`);
			console.log(`           →   ${f.depois}`);
			console.log('');
		}
	}

	/** @type {Map<string, number>} */
	const flipBuckets = new Map();
	for (const f of flips) {
		const key = `${acaoBucket(f.antes)} → ${acaoBucket(f.depois)}`;
		flipBuckets.set(key, (flipBuckets.get(key) ?? 0) + 1);
	}
	if (flipBuckets.size > 0) {
		console.log('  Resumo dos flips:');
		for (const [k, n] of [...flipBuckets.entries()].sort((a, b) => b[1] - a[1])) {
			console.log(`    ${String(n).padStart(4)} × ${k}`);
		}
	}
	console.log('');
}

async function runAudit(cityFiles) {
	// Preserva baseline dos 615 (pré-expansão) uma vez
	if (!(await pathExists(OUT_PRIORIDADE_BASELINE615)) && (await pathExists(OUT_PRIORIDADE_PREV))) {
		await writeFile(OUT_PRIORIDADE_BASELINE615, await readFile(OUT_PRIORIDADE_PREV, 'utf8'), 'utf8');
		if (await pathExists(OUT_CSV_PREV)) {
			await writeFile(OUT_CSV_BASELINE615, await readFile(OUT_CSV_PREV, 'utf8'), 'utf8');
		}
		console.log(
			`📌 Baseline 615 preservada:\n` +
				`   ${path.relative(ROOT, OUT_PRIORIDADE_BASELINE615)}\n`,
		);
	}

	// Snapshot pré-cityfix: só cria se ainda não existir (estado pós-expansão / pré-correção title)
	if (!(await pathExists(OUT_PRIORIDADE_PRE_CITYFIX)) && (await pathExists(OUT_PRIORIDADE))) {
		await writeFile(OUT_PRIORIDADE_PRE_CITYFIX, await readFile(OUT_PRIORIDADE, 'utf8'), 'utf8');
		if (await pathExists(OUT_CSV)) {
			await writeFile(OUT_CSV_PRE_CITYFIX, await readFile(OUT_CSV, 'utf8'), 'utf8');
		}
	}
	if (await pathExists(OUT_PRIORIDADE_PRE_CITYFIX)) {
		console.log(
			`📸 Snapshot pré-cityfix:\n` +
				`   ${path.relative(ROOT, OUT_CSV_PRE_CITYFIX)}\n` +
				`   ${path.relative(ROOT, OUT_PRIORIDADE_PRE_CITYFIX)}\n`,
		);
	}

	/** @type {Set<string>} */
	const baselineArquivos = new Set();
	if (await pathExists(OUT_PRIORIDADE_BASELINE615)) {
		for (const r of parseCsvObjects(await readFile(OUT_PRIORIDADE_BASELINE615, 'utf8'))) {
			const arq = String(r.arquivo ?? '').replace(/\\/g, '/');
			if (arq) baselineArquivos.add(arq);
		}
	}

	const rows = [];
	/** @type {Map<string, number>} */
	const domainFreq = new Map();
	/** @type {Map<string, number>} */
	const phoneFreq = new Map();

	console.log(
		`📋 Área oficial: ${ORDEM_CIDADES.length} municípios em ${cidadesGsp.regioes.length} regiões ` +
			'(cidades-gsp.json — mesma base da home e /descupinizacao/regioes/).\n',
	);
	console.log(
		`🔎 cidade_detectada via resolveCityExpanded (slug/path OU title + prep)\n` +
			`   Title-fallback desligado nos ${baselineArquivos.size} arquivos da baseline 615 (não-regressão).\n`,
	);

	for (const file of cityFiles) {
		const raw = await readFile(file, 'utf8');
		const parsed = parseContentFile(file, raw);
		if (!parsed) continue;
		if (!isCitySlug(parsed.slug) && !fileLooksLikeCityExpanded(file, raw)) continue;

		const row = auditPage(parsed, {
			allowTitleFallback: !baselineArquivos.has(String(parsed.rel).replace(/\\/g, '/')),
		});
		for (const d of row._externalList) {
			domainFreq.set(d, (domainFreq.get(d) ?? 0) + 1);
		}
		for (const p of row._phones) {
			phoneFreq.set(p, (phoneFreq.get(p) ?? 0) + 1);
		}
		delete row._externalList;
		delete row._phones;
		// mantém _title / _city_fonte só para relatório interno; remove antes do CSV
		rows.push(row);
	}

	rows.sort((a, b) => b.severidade - a.severidade || a.slug_url.localeCompare(b.slug_url));

	/** Metadados internos para relatório (não vão ao CSV) */
	/** @type {Map<string, { title: string, fonte: string }>} */
	const metaByArquivo = new Map();
	for (const row of rows) {
		metaByArquivo.set(String(row.arquivo).replace(/\\/g, '/'), {
			title: String(row._title ?? ''),
			fonte: String(row._city_fonte ?? ''),
		});
		delete row._title;
		delete row._city_fonte;
	}

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

	// Integridade: todos os JSON em pages/posts vs CSV (aviso diagnóstico, sem correção)
	await reportWpJsonIntegrity(rows, cityFiles);

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

	await reportAuditDeltaVsPrevious(prioridade, metaByArquivo);

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
