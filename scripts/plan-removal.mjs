/**
 * Plano de remoção (somente leitura) para páginas fora da área de atendimento.
 *
 * Usa scripts/.tmp-audit-priorizacao.csv e cruza com export do Search Console
 * (Desempenho → Páginas, últimos 90 dias: colunas URL + Impressões/Cliques).
 *
 * Uso:
 *   node scripts/plan-removal.mjs
 *   node scripts/plan-removal.mjs --gsc caminho/para/export.csv
 *   node scripts/plan-removal.mjs --gsc caminho/para/export.xlsx
 *
 * Saída: scripts/.tmp-plano-remocao.csv (não versionar)
 */
import { readdir, readFile, writeFile, access, mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('.');
const PRIO_CSV = path.join(ROOT, 'scripts', '.tmp-audit-priorizacao.csv');
const OUT_CSV = path.join(ROOT, 'scripts', '.tmp-plano-remocao.csv');
const REMOVER_PREFIX = 'REMOVER - fora da área de atendimento';
const FALLBACK_301 = '/descupinizacao/regioes/';
const ACAO_REVISAR_SEM_LOCAL =
	'REVISAR - conteúdo sem localização, avaliar individualmente';
/** Páginas REMOVER no audit mas que ficam FORA do 410/301 nesta rodada. */
const EXCLUSOES_AREA_MANUAL = new Map([
	[
		'src/data/wp/pages/24594.json',
		'REESCREVER - área de atendimento (Aldeia da Serra → Barueri/Santana de Parnaíba)',
	],
]);
const WP_DATA_DIR = path.join(ROOT, 'src', 'data', 'wp');
const SRC_DIR = path.join(ROOT, 'src');

/** Preposição + localidade no slug/path (sinal de geografia real). */
const SLUG_GEO_PREP_RE = /(?:^|\/|-)(?:em|na|no|nas|nos)-[a-z0-9]+(?:-[a-z0-9]+)*(?:\/|$)/i;
/** Pasta pai tipo /sao-roque-sp/ ou /rj/. */
const SLUG_GEO_PARENT_RE = /(?:^|\/)(?:[a-z0-9-]+-sp|rj|sp)(?:\/|$)/i;

/**
 * Cidade ausente (vazio/nulo) OU rótulo inventado do slug sem sinal geográfico
 * (ex.: "Pulga", "Cupins", "Limpeza De Coifa" — não é município fora da área).
 * @param {{ cidade_detectada?: string, slug_url?: string, slug?: string }} row
 */
function isSemLocalizacao(row) {
	const cidade = String(row.cidade_detectada ?? '').trim();
	if (!cidade || cidade === '-' || /^\(?\s*vazio\s*\)?$/i.test(cidade)) {
		return true;
	}

	const slug = String(row.slug_url ?? row.slug ?? '')
		.trim()
		.toLowerCase();
	if (SLUG_GEO_PREP_RE.test(slug) || SLUG_GEO_PARENT_RE.test(slug)) {
		return false;
	}

	// Sem prep no slug: rótulo title-case do path não conta como cidade identificada
	return true;
}

/** Extrai ID numérico do caminho (ex.: src/data/wp/pages/48994.json → 48994) */
function extractWpIdFromArquivo(arquivo) {
	const m = String(arquivo ?? '')
		.replace(/\\/g, '/')
		.match(/\/(\d+)\.json$/i);
	return m ? m[1] : null;
}

async function walkFilesByExt(dir, exts, acc = []) {
	try {
		await access(dir);
	} catch {
		return acc;
	}
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkFilesByExt(full, exts, acc);
			continue;
		}
		const ext = path.extname(entry.name).toLowerCase();
		if (exts.has(ext)) acc.push(full);
	}
	return acc;
}

/**
 * Índice invertido: id → lista de locais que referenciam o ID
 * (exclui o próprio arquivo do ID e o manifest.json, que lista todos os IDs).
 */
async function buildIdReferenceIndex(candidateIds) {
	/** @type {Map<string, Set<string>>} */
	const index = new Map();
	for (const id of candidateIds) index.set(id, new Set());

	const idList = [...candidateIds];
	if (idList.length === 0) return index;

	const codeFiles = await walkFilesByExt(SRC_DIR, new Set(['.ts', '.astro']));
	const wpFiles = (await walkFilesByExt(WP_DATA_DIR, new Set(['.json']))).filter(
		(f) => path.basename(f) !== 'manifest.json',
	);

	function makeStructuralRe(ids) {
		const alt = ids.join('|');
		return new RegExp(
			`(?:` +
				`"parent"\\s*:\\s*(${alt})\\b` +
				`|"postId"\\s*:\\s*(${alt})\\b` +
				`|"pageId"\\s*:\\s*(${alt})\\b` +
				`|(?:pages|posts)/(${alt})\\.json` +
				`|page_id=(${alt})\\b` +
				`|(?:relatedPosts|clusterPosts|postIds|pageIds)[^\\n]{0,120}?\\b(${alt})\\b` +
				// "id": N só conta fora do arquivo do próprio N (self filtrado abaixo)
				`|"id"\\s*:\\s*(${alt})\\b` +
				`)`,
			'gi',
		);
	}

	function makeCodeRe(ids) {
		const alt = ids.join('|');
		// Código: refs explícitas + literais de path/módulo WP
		return new RegExp(
			`(?:` +
				`(?:postId|pageId|parentId|contentId)\\s*[:=]\\s*(${alt})\\b` +
				`|(?:pages|posts)/(${alt})(?:\\.json)?` +
				`|(?:relatedPosts|clusterPosts|postIds|pageIds)[^\\n]{0,120}?\\b(${alt})\\b` +
				`|\\b(${alt})\\.json\\b` +
				`)`,
			'gi',
		);
	}

	function collectMatches(text, re, rel, selfId) {
		re.lastIndex = 0;
		let match;
		while ((match = re.exec(text)) !== null) {
			const id = match.slice(1).find((g) => g != null);
			if (!id || !index.has(id)) continue;
			if (selfId === id) continue;
			const line = text.slice(0, match.index).split(/\r?\n/).length;
			const snippet = match[0].replace(/\s+/g, ' ').slice(0, 70);
			index.get(id).add(`${rel}:${line} (${snippet})`);
		}
	}

	const chunkSize = 100;

	for (const fileAbs of wpFiles) {
		const rel = path.relative(ROOT, fileAbs).replace(/\\/g, '/');
		const selfId = extractWpIdFromArquivo(rel);
		let text;
		try {
			text = await readFile(fileAbs, 'utf8');
		} catch {
			continue;
		}
		for (let i = 0; i < idList.length; i += chunkSize) {
			const chunk = idList.slice(i, i + chunkSize);
			collectMatches(text, makeStructuralRe(chunk), rel, selfId);
		}
	}

	for (const fileAbs of codeFiles) {
		const rel = path.relative(ROOT, fileAbs).replace(/\\/g, '/');
		let text;
		try {
			text = await readFile(fileAbs, 'utf8');
		} catch {
			continue;
		}
		for (let i = 0; i < idList.length; i += chunkSize) {
			const chunk = idList.slice(i, i + chunkSize);
			collectMatches(text, makeCodeRe(chunk), rel, null);
		}
	}

	return index;
}

/**
 * Para itens "410 direto", se o ID estiver referenciado em outro lugar → MANTER.
 */
function applyReferentialIntegrity(plan, refIndex) {
	let changed = 0;
	/** @type {{ arquivo: string; id: string; refs: string[] }[]} */
	const kept = [];

	for (const item of plan) {
		if (item.acao_sugerida !== '410 direto') continue;
		const id = extractWpIdFromArquivo(item.arquivo);
		if (!id) continue;
		const refs = [...(refIndex.get(id) ?? [])];
		if (refs.length === 0) continue;

		const where = refs
			.slice(0, 5)
			.map((r) => r.replace(/\s+/g, ' '))
			.join('; ');
		const more = refs.length > 5 ? ` (+${refs.length - 5})` : '';
		item.acao_sugerida = `MANTER - referenciado por: ${where}${more}`;
		item.destino_301 = '';
		changed += 1;
		kept.push({ arquivo: item.arquivo, id, refs });
	}

	return { changed, kept };
}

function parseArgs(argv) {
	const args = { gsc: process.env.GSC_PERFORMANCE_FILE || null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--gsc' && argv[i + 1]) {
			args.gsc = argv[++i];
		}
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

/** Parser CSV simples com suporte a aspas */
function parseCsvLine(line) {
	const cells = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (ch === '"') {
				inQuotes = false;
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			cells.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	cells.push(cur);
	return cells;
}

async function readCsvRows(filePath) {
	const raw = await readFile(filePath, 'utf8');
	const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
	if (lines.length === 0) return { headers: [], rows: [] };
	const headers = parseCsvLine(lines[0]).map((h) => h.trim());
	const rows = lines.slice(1).map((line) => {
		const cells = parseCsvLine(line);
		const obj = {};
		headers.forEach((h, i) => {
			obj[h] = cells[i] ?? '';
		});
		return obj;
	});
	return { headers, rows };
}

function normalizeUrlKey(urlOrPath) {
	if (!urlOrPath) return '';
	let s = String(urlOrPath).trim();
	try {
		if (/^https?:\/\//i.test(s)) {
			const u = new URL(s);
			s = u.pathname;
		}
	} catch {
		/* keep as-is */
	}
	s = s.replace(/^https?:\/\/[^/]+/i, '');
	s = s.replace(/^\/+|\/+$/g, '').toLowerCase();
	s = s.replace(/^d\//, '');
	return s;
}

function normalizeHeader(h) {
	return String(h ?? '')
		.trim()
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/\s+/g, ' ');
}

/**
 * Aliases GSC → chaves internas.
 * EN: Page, Clicks, Impressions, CTR, Position
 * PT: Páginas principais, Cliques, Impressões, CTR, Posição
 */
const GSC_HEADER_ALIASES = {
	page: [
		'page',
		'top pages',
		'top page',
		'pages',
		'url',
		'landing page',
		'pagina',
		'paginas',
		'paginas principais',
		'pagina principal',
		'endereco',
		'endereco da pagina',
	],
	clicks: ['clicks', 'click', 'cliques', 'clique'],
	impressions: ['impressions', 'impression', 'impressoes', 'impressao'],
	ctr: ['ctr', 'click through rate', 'taxa de cliques'],
	position: ['position', 'avg. position', 'average position', 'posicao', 'posicao media'],
};

/**
 * Detecta locale do export e mapeia cabeçalhos originais → chaves internas.
 * @returns {{ ok: true, locale: 'en'|'pt'|'mixed', columns: Record<string, string>, normalizedHeaders: string[] }
 *        | {{ ok: false, reason: string }}
 */
function mapGscHeaders(headers) {
	const normalized = headers.map(normalizeHeader);
	/** @type {Record<string, string>} chave interna → cabeçalho original */
	const columns = {};
	/** @type {Set<'en'|'pt'>} */
	const locales = new Set();

	const enHints = new Set([
		'page',
		'top pages',
		'clicks',
		'click',
		'impressions',
		'impression',
		'position',
		'avg. position',
		'average position',
	]);
	const ptHints = new Set([
		'pagina',
		'paginas',
		'paginas principais',
		'pagina principal',
		'cliques',
		'clique',
		'impressoes',
		'impressao',
		'posicao',
		'posicao media',
	]);

	for (const [internalKey, aliases] of Object.entries(GSC_HEADER_ALIASES)) {
		const aliasSet = new Set(aliases.map(normalizeHeader));
		let matchIdx = -1;

		// 1) match exato
		matchIdx = normalized.findIndex((h) => aliasSet.has(h));

		// 2) fallback: cabeçalho contém o alias (ex.: "Top pages")
		if (matchIdx < 0) {
			matchIdx = normalized.findIndex((h) =>
				[...aliasSet].some((a) => a.length >= 4 && (h === a || h.includes(a))),
			);
		}

		if (matchIdx >= 0) {
			columns[internalKey] = headers[matchIdx];
			const h = normalized[matchIdx];
			if (enHints.has(h) || [...enHints].some((e) => h.includes(e) && e.length > 3)) locales.add('en');
			if (ptHints.has(h) || [...ptHints].some((p) => h.includes(p) && p.length > 3)) locales.add('pt');
		}
	}

	if (!columns.page) {
		return {
			ok: false,
			reason: `Arquivo sem coluna de página/URL. Cabeçalhos: ${headers.join(' | ')}`,
		};
	}
	if (!columns.impressions && !columns.clicks) {
		return {
			ok: false,
			reason:
				`Arquivo sem colunas de Impressões/Cliques (não parece export de Desempenho).\n` +
				`  Cabeçalhos: ${headers.join(' | ')}`,
		};
	}

	let locale = 'mixed';
	if (locales.size === 1) locale = [...locales][0];
	else if (locales.has('pt') && !locales.has('en')) locale = 'pt';
	else if (locales.has('en') && !locales.has('pt')) locale = 'en';
	else if (locales.size === 0) {
		// CTR é igual nos dois idiomas — inferir pelo page header
		const pageNorm = normalizeHeader(columns.page);
		locale = /pagina/.test(pageNorm) ? 'pt' : 'en';
	}

	return { ok: true, locale, columns, normalizedHeaders: normalized };
}

/** Converte célula numérica GSC (EN "1,234" / PT "1.234" / "12,5%") */
function parseGscNumber(value) {
	if (value == null || value === '') return 0;
	let s = String(value).trim().replace(/%/g, '').replace(/\s/g, '');
	if (!s) return 0;
	// 1.234.567,89 (pt) ou 1,234,567.89 (en)
	if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
		s = s.replace(/\./g, '').replace(',', '.');
	} else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
		s = s.replace(/,/g, '');
	} else if (/^\d+,\d+$/.test(s)) {
		s = s.replace(',', '.');
	}
	const n = Number(s);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Normaliza uma linha bruta do export para chaves internas.
 */
function normalizeGscRow(rawRow, columns) {
	return {
		page: String(rawRow[columns.page] ?? ''),
		clicks: parseGscNumber(rawRow[columns.clicks]),
		impressions: parseGscNumber(rawRow[columns.impressions]),
		ctr: parseGscNumber(rawRow[columns.ctr]),
		position: parseGscNumber(rawRow[columns.position]),
	};
}

/**
 * Lê export GSC (CSV) e devolve Map<pathNormalizado, { impressions, clicks }>
 */
async function loadGscPerformanceFromCsv(filePath) {
	const { headers, rows } = await readCsvRows(filePath);
	const mapped = mapGscHeaders(headers);
	if (!mapped.ok) return mapped;

	/** @type {Map<string, { impressions: number; clicks: number }>} */
	const map = new Map();
	for (const row of rows) {
		const norm = normalizeGscRow(row, mapped.columns);
		const key = normalizeUrlKey(norm.page);
		if (!key) continue;
		const prev = map.get(key) ?? { impressions: 0, clicks: 0 };
		map.set(key, {
			impressions: prev.impressions + norm.impressions,
			clicks: prev.clicks + norm.clicks,
		});
	}

	return {
		ok: true,
		map,
		headers,
		locale: mapped.locale,
		columns: mapped.columns,
		urlCol: mapped.columns.page,
		impressionsCol: mapped.columns.impressions ?? null,
		clicksCol: mapped.columns.clicks ?? null,
	};
}

/**
 * Extrai sharedStrings + sheet1 de um xlsx e tenta montar linhas (limitado, sem lib).
 * Preferível exportar CSV do GSC; xlsx só como fallback.
 */
async function loadGscPerformanceFromXlsx(filePath) {
	const tmpDir = path.join(ROOT, 'scripts', '.tmp-gsc-xlsx');
	const zipPath = path.join(tmpDir, 'book.zip');
	await rm(tmpDir, { recursive: true, force: true });
	await mkdir(tmpDir, { recursive: true });
	await copyFile(filePath, zipPath);

	await new Promise((resolve, reject) => {
		const ps = spawn(
			'powershell',
			['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force`],
			{ stdio: 'inherit' },
		);
		ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Expand-Archive exit ${code}`))));
	});

	const sharedPath = path.join(tmpDir, 'xl', 'sharedStrings.xml');
	const sheetPath = path.join(tmpDir, 'xl', 'worksheets', 'sheet1.xml');

	if (!(await pathExists(sharedPath)) || !(await pathExists(sheetPath))) {
		await rm(tmpDir, { recursive: true, force: true });
		return {
			ok: false,
			reason: 'XLSX sem sharedStrings/sheet1 — exporte do GSC como CSV (Desempenho → Páginas).',
		};
	}

	const sharedXml = await readFile(sharedPath, 'utf8');
	const strings = [...sharedXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);

	const sheetXml = await readFile(sheetPath, 'utf8');
	const rowMatches = [...sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
	const table = [];

	for (const rowMatch of rowMatches) {
		const cells = [];
		const cellRe = /<c\b([^>]*)>(?:<v>([^<]*)<\/v>)?/g;
		let cm;
		while ((cm = cellRe.exec(rowMatch[1])) !== null) {
			const attrs = cm[1];
			const v = cm[2] ?? '';
			const isShared = /\bt="s"/.test(attrs);
			cells.push(isShared ? (strings[Number(v)] ?? '') : v);
		}
		if (cells.length) table.push(cells);
	}

	await rm(tmpDir, { recursive: true, force: true });

	if (table.length < 2) {
		return { ok: false, reason: 'XLSX vazio ou ilegível. Prefira export CSV do GSC.' };
	}

	const headers = table[0].map((h) => String(h).trim());
	const mapped = mapGscHeaders(headers);
	if (!mapped.ok) {
		return {
			ok: false,
			reason:
				`${mapped.reason}\n` +
				`  Arquivo: ${path.relative(ROOT, filePath)}\n` +
				`  Obs.: cupins.eco.br-Coverage-Drilldown-*.xlsx é relatório de cobertura (404), não de desempenho.`,
		};
	}

	/** @type {Map<string, { impressions: number; clicks: number }>} */
	const map = new Map();
	for (const cells of table.slice(1)) {
		const rawRow = {};
		headers.forEach((h, i) => {
			rawRow[h] = cells[i] ?? '';
		});
		const norm = normalizeGscRow(rawRow, mapped.columns);
		const key = normalizeUrlKey(norm.page);
		if (!key) continue;
		const prev = map.get(key) ?? { impressions: 0, clicks: 0 };
		map.set(key, {
			impressions: prev.impressions + norm.impressions,
			clicks: prev.clicks + norm.clicks,
		});
	}

	return {
		ok: true,
		map,
		headers,
		locale: mapped.locale,
		columns: mapped.columns,
		urlCol: mapped.columns.page,
		impressionsCol: mapped.columns.impressions ?? null,
		clicksCol: mapped.columns.clicks ?? null,
	};
}

async function discoverGscFiles() {
	const found = [];
	const entries = await readdir(ROOT, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const name = entry.name;
		const lower = name.toLowerCase();
		if (!/\.(csv|xlsx|tsv)$/i.test(name)) continue;
		if (
			/coverage|drilldown|404/i.test(name) ||
			lower.includes('performance') ||
			lower.includes('desempenho') ||
			lower.includes('consultas') ||
			lower.includes('pagina') ||
			lower.includes('página') ||
			lower.includes('impress') ||
			lower.includes('chart') ||
			lower.includes('tabela')
		) {
			found.push(path.join(ROOT, name));
		}
	}
	return found;
}

async function resolveGscSource(cliPath) {
	if (cliPath) {
		const abs = path.isAbsolute(cliPath) ? cliPath : path.join(ROOT, cliPath);
		if (!(await pathExists(abs))) {
			return { ok: false, reason: `Arquivo GSC não encontrado: ${cliPath}` };
		}
		return { ok: true, path: abs };
	}

	const discovered = await discoverGscFiles();
	const coverageOnly = discovered.filter((f) => /coverage|drilldown|404/i.test(path.basename(f)));
	const performanceLike = discovered.filter((f) => !/coverage|drilldown|404/i.test(path.basename(f)));

	if (performanceLike.length === 1) {
		return { ok: true, path: performanceLike[0] };
	}
	if (performanceLike.length > 1) {
		return {
			ok: false,
			reason:
				`Vários arquivos candidatos a GSC encontrados. Informe qual usar com --gsc:\n` +
				performanceLike.map((f) => `  - ${path.relative(ROOT, f)}`).join('\n'),
		};
	}

	// Só Coverage Drilldown no repo — não serve para impressões/cliques
	if (coverageOnly.length > 0) {
		return {
			ok: false,
			reason:
				`Encontrei no repo apenas relatório de cobertura (ex.: ${path.basename(coverageOnly[0])}),\n` +
				`  que lista URLs "Não encontrado (404)" — NÃO inclui impressões/cliques dos últimos 90 dias.\n\n` +
				`  Para continuar, exporte no Google Search Console:\n` +
				`    Desempenho → Páginas → Últimos 90 dias → Exportar (CSV ou Excel)\n` +
				`  e rode:\n` +
				`    node scripts/plan-removal.mjs --gsc caminho/do/arquivo.csv\n`,
		};
	}

	return {
		ok: false,
		reason:
			`Nenhum export de Desempenho do Search Console encontrado no repositório.\n\n` +
			`  Coloque o arquivo na raiz do projeto ou informe o caminho:\n` +
			`    node scripts/plan-removal.mjs --gsc caminho/do/arquivo.csv\n\n` +
			`  No GSC: Desempenho → Páginas → 90 dias → Exportar.\n`,
	};
}

async function loadGscMap(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.csv' || ext === '.tsv') {
		return loadGscPerformanceFromCsv(filePath);
	}
	if (ext === '.xlsx') {
		return loadGscPerformanceFromXlsx(filePath);
	}
	return { ok: false, reason: `Formato não suportado: ${ext} (use .csv ou .xlsx)` };
}

function suggestAction(hadTraffic) {
	if (hadTraffic) {
		return {
			acao_sugerida: `301 para ${FALLBACK_301}`,
			destino_301: FALLBACK_301,
		};
	}
	return {
		acao_sugerida: '410 direto',
		destino_301: '',
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (!(await pathExists(PRIO_CSV))) {
		console.error(
			`❌ Não encontrei ${path.relative(ROOT, PRIO_CSV)}.\n` +
				`   Rode antes: npm run audit:cidades`,
		);
		process.exit(1);
	}

	const { rows: prioRows } = await readCsvRows(PRIO_CSV);
	const remover = prioRows.filter(
		(r) =>
			String(r.acao ?? '').startsWith('REMOVER') &&
			(String(r.tipo_conteudo ?? '') === 'pagina' ||
				String(r.arquivo ?? '').replace(/\\/g, '/').includes('/wp/pages/')),
	);

	console.log(`\n📋 Páginas "REMOVER - fora da área" (só tipo_conteudo=pagina): ${remover.length}`);

	const gscSource = await resolveGscSource(args.gsc);
	if (!gscSource.ok) {
		console.log(`\n⚠️  ${gscSource.reason}`);
		process.exit(1);
	}

	console.log(`📊 GSC: ${path.relative(ROOT, gscSource.path)}`);
	const gsc = await loadGscMap(gscSource.path);
	if (!gsc.ok) {
		console.log(`\n⚠️  ${gsc.reason}`);
		process.exit(1);
	}

	const localeLabel = gsc.locale === 'pt' ? 'PT' : gsc.locale === 'en' ? 'EN' : 'misto EN/PT';
	console.log(
		`   Idioma detectado: ${localeLabel} | URLs: ${gsc.map.size}\n` +
			`   Mapeamento: page←"${gsc.urlCol}"` +
			(gsc.impressionsCol ? ` | impressions←"${gsc.impressionsCol}"` : '') +
			(gsc.clicksCol ? ` | clicks←"${gsc.clicksCol}"` : ''),
	);

	const plan = [];
	const withTraffic = [];
	/** @type {typeof plan} */
	const excluidasSemLocal = [];
	/** @type {typeof plan} */
	const excluidasAreaManual = [];

	for (const row of remover) {
		const slug = String(row.slug_url ?? '');
		const arquivoNorm = String(row.arquivo ?? '').replace(/\\/g, '/');
		const key = normalizeUrlKey(slug);
		const stats = gsc.map.get(key) ?? { impressions: 0, clicks: 0 };
		const teve = stats.impressions > 0 || stats.clicks > 0;
		const acaoManual = EXCLUSOES_AREA_MANUAL.get(arquivoNorm);
		const semLocal = !acaoManual && isSemLocalizacao(row);

		let acao_sugerida;
		let destino_301;
		if (acaoManual) {
			acao_sugerida = acaoManual;
			destino_301 = '';
		} else if (semLocal) {
			acao_sugerida = ACAO_REVISAR_SEM_LOCAL;
			destino_301 = '';
		} else {
			({ acao_sugerida, destino_301 } = suggestAction(teve));
		}

		const item = {
			arquivo: row.arquivo ?? '',
			slug: slug,
			cidade_detectada: row.cidade_detectada ?? '',
			impressoes_gsc: stats.impressions,
			cliques_gsc: stats.clicks,
			teve_impressao_gsc: teve,
			acao_sugerida,
			destino_301,
		};
		plan.push(item);
		if (acaoManual) excluidasAreaManual.push(item);
		else if (semLocal) excluidasSemLocal.push(item);
		else if (teve) withTraffic.push(item);
	}

	// Integridade referencial antes de gravar o CSV
	const ids410 = plan
		.filter((p) => p.acao_sugerida === '410 direto')
		.map((p) => extractWpIdFromArquivo(p.arquivo))
		.filter(Boolean);
	console.log(`\n🔗 Checagem de integridade referencial (${ids410.length} candidatos a 410)…`);
	const refIndex = await buildIdReferenceIndex(new Set(ids410));
	const integrity = applyReferentialIntegrity(plan, refIndex);
	console.log(
		`   ${integrity.changed} página(s) mudaram para MANTER (referenciadas em src/**/*.{ts,astro} ou src/data/wp/).`,
	);
	if (integrity.kept.length > 0) {
		for (const k of integrity.kept.slice(0, 15)) {
			console.log(`   · id=${k.id} ← ${k.refs[0]}${k.refs.length > 1 ? ` (+${k.refs.length - 1})` : ''}`);
		}
		if (integrity.kept.length > 15) {
			console.log(`   · … e mais ${integrity.kept.length - 15}`);
		}
	}

	plan.sort((a, b) => {
		const rank = (acao) => {
			if (String(acao).startsWith('301')) return 0;
			if (acao === '410 direto') return 1;
			if (String(acao).startsWith('REESCREVER')) return 2;
			if (String(acao).startsWith('REVISAR')) return 3;
			return 4; // MANTER
		};
		const ra = rank(a.acao_sugerida);
		const rb = rank(b.acao_sugerida);
		if (ra !== rb) return ra - rb;
		if (a.teve_impressao_gsc !== b.teve_impressao_gsc) return a.teve_impressao_gsc ? -1 : 1;
		return (b.impressoes_gsc || 0) - (a.impressoes_gsc || 0) || a.slug.localeCompare(b.slug);
	});

	const headers = [
		'arquivo',
		'slug',
		'cidade_detectada',
		'impressoes_gsc',
		'cliques_gsc',
		'teve_impressao_gsc',
		'acao_sugerida',
		'destino_301',
	];

	const csv = [
		headers.join(','),
		...plan.map((row) => headers.map((h) => csvEscape(row[h])).join(',')),
	];

	await mkdir(path.dirname(OUT_CSV), { recursive: true });
	await writeFile(OUT_CSV, `${csv.join('\n')}\n`, 'utf8');

	const n410 = plan.filter((p) => p.acao_sugerida === '410 direto').length;
	const n301 = plan.filter((p) => p.acao_sugerida.startsWith('301')).length;
	const nRevisarSemLocal = plan.filter((p) => p.acao_sugerida === ACAO_REVISAR_SEM_LOCAL).length;
	const nReescreverManual = plan.filter((p) => String(p.acao_sugerida).startsWith('REESCREVER')).length;
	const nManter = plan.filter((p) => String(p.acao_sugerida).startsWith('MANTER')).length;
	const nRemocaoEfetiva = n410 + n301;

	console.log('\n=== Plano de remoção (somente relatório) ===\n');
	console.log(`Total no CSV:      ${plan.length}  (REMOVER do audit, incl. exclusões)`);
	console.log(`410/301 (plano):   ${nRemocaoEfetiva}  ← remoção de fato`);
	console.log(`410 direto:        ${n410}  (sem impressão/clique no GSC)`);
	console.log(`301 → ${FALLBACK_301}: ${n301}  (teve tráfego — revisar manualmente)`);
	console.log(
		`REVISAR sem local: ${nRevisarSemLocal}  (excluídas do 410/301 — avaliar individualmente)`,
	);
	console.log(
		`REESCREVER manual: ${nReescreverManual}  (excluídas do 410/301 — área de atendimento)`,
	);
	console.log(`MANTER (refs):     ${nManter}  (integridade referencial)`);
	console.log(`\nCSV: ${path.relative(ROOT, OUT_CSV)}`);

	if (excluidasAreaManual.length > 0) {
		console.log(`\nExcluídas do plano 410/301 por área manual (${excluidasAreaManual.length}):`);
		for (const item of excluidasAreaManual) {
			const id = extractWpIdFromArquivo(item.arquivo) ?? '?';
			console.log(`  ${id}  ${item.slug} — ${item.acao_sugerida}`);
		}
	}

	if (excluidasSemLocal.length > 0) {
		console.log(`\nExcluídas do plano 410/301 por sem localização (${excluidasSemLocal.length}):`);
		const sortedEx = [...excluidasSemLocal].sort((a, b) => a.slug.localeCompare(b.slug));
		for (const item of sortedEx) {
			const id = extractWpIdFromArquivo(item.arquivo) ?? '?';
			console.log(
				`  ${id}  ${item.slug} — cidade_detectada="${item.cidade_detectada || '(vazio)'}"`,
			);
		}
	}

	console.log(`\nPáginas com teve_impressao_gsc = true (${withTraffic.length}):`);
	if (withTraffic.length === 0) {
		console.log('  (nenhuma — todas sem impressão/clique no período do export)');
	} else {
		const sorted = [...withTraffic].sort(
			(a, b) => b.impressoes_gsc - a.impressoes_gsc || a.slug.localeCompare(b.slug),
		);
		for (const item of sorted) {
			console.log(
				`  ${item.slug} — ${item.cidade_detectada || '(sem cidade)'} | impressões=${item.impressoes_gsc} cliques=${item.cliques_gsc}`,
			);
		}
	}

	console.log(
		'\nNenhum arquivo de conteúdo ou rota foi alterado — revise o CSV antes de aplicar 410/301.\n',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
