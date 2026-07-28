/**
 * Normalização de conteúdo em páginas WP dentro da área de atendimento.
 *
 * Segurança (sempre):
 *   - Aborta se `git status --porcelain` não estiver vazio
 *   - Só opera em scripts/.tmp-audit-priorizacao.csv com
 *     tipo_conteudo=pagina E area_atendimento=true
 *
 * Uso:
 *   node scripts/normalize-content.mjs telefone [--apply]
 *   node scripts/normalize-content.mjs links-toxicos [--apply]
 *   node scripts/normalize-content.mjs revisao-marca
 */
import { spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const PRIO_CSV = path.join(ROOT, 'scripts', '.tmp-audit-priorizacao.csv');
const AUDIT_CSV = path.join(ROOT, 'scripts', '.tmp-audit-cidades.csv');
const OUT_TELEFONE = path.join(ROOT, 'scripts', '.tmp-normalizacao-telefone.csv');
const OUT_LINKS = path.join(ROOT, 'scripts', '.tmp-normalizacao-links.csv');
const OUT_MARCA = path.join(ROOT, 'scripts', '.tmp-revisao-marca.csv');

const OFFICIAL_PHONE_DISPLAY = '0800 111 7272';
const OFFICIAL_PHONE_DIGITS = '08001117272';
const OFFICIAL_TEL_HREF = `tel:${OFFICIAL_PHONE_DIGITS}`;

/** Mesmo padrão do audit-city-pages.mjs */
const PHONE_RE =
	/(?:0800[\s.\-]?\d{3}[\s.\-]?\d{4})|(?:\(?\d{2}\)?[\s.\-]\d{4,5}[\s.\-]\d{4})|(?:\+?55[\s.\-]?\(?\d{2}\)?[\s.\-]?\d{4,5}[\s.\-]\d{4})/g;

const TEL_HREF_RE = /href\s*=\s*(["'])\s*tel:([^"']+)\1/gi;

const WHITELIST_SUFFIXES = [
	'cupins.eco.br',
	'anvisa.gov.br',
	'saude.gov.br',
	'gov.br',
	'wikipedia.org',
	'combateaedes.saude.gov.br',
	'google.com',
	'api.whatsapp.com',
	'maps.google.com',
];

const SOCIAL_HOSTS = new Set(['facebook.com', 'instagram.com', 'fb.com', 'fb.me', 'm.facebook.com']);

const CUPIM_SOCIAL_HINT =
	/cupim[\s._-]?eco|cupins\.eco|cupim\.eco/i;

/** Marcas concorrentes / legado (revisão manual) */
const WRONG_BRAND_NAME_RE =
	/\b(?:Universo(?:\s+Ambiental)?|OESTE\s*PRAGAS|Oeste\s*Pragas|Bio[\s-]*Solu[cç][oõ]es|biosolucoes|bio-solucoes|Combate\s+Ambiental|Cicero\s+Desentupidora)\b/gi;

const BRAND_CONTEXT_RE =
	/\b(?:empresa|somos|nossa|nosso|nossas|nossos|refer[eê]ncia|referencias|referências|atendemos|especializada|especialistas|equipe|marca)\b/i;

const ALLOWED_BRAND_NEARBY = /\bCupim[\s.]?Eco\b/i;

// ——— utils ———

function csvEscape(value) {
	const str = String(value ?? '');
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

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
	if (lines.length === 0) return [];
	const headers = parseCsvLine(lines[0]).map((h) => h.trim());
	return lines.slice(1).map((line) => {
		const cells = parseCsvLine(line);
		/** @type {Record<string, string>} */
		const obj = {};
		headers.forEach((h, i) => {
			obj[h] = cells[i] ?? '';
		});
		return obj;
	});
}

async function pathExists(target) {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

function assertCleanGit() {
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
				'   Faça commit ou `git stash` antes de rodar este script\n' +
				'   (vale para dry-run e para --apply).\n\n' +
				'   Status atual (até 20 linhas):\n' +
				lines.map((l) => `     ${l}`).join('\n') +
				'\n',
		);
		process.exit(1);
	}
	console.log('✓ git working tree limpo\n');
}

function parseArgs(argv) {
	const cmd = argv[0] || '';
	const apply = argv.includes('--apply');
	return { cmd, apply };
}

function isTruthyArea(value) {
	const v = String(value ?? '')
		.trim()
		.toLowerCase();
	return v === 'true' || v === '1' || v === 'yes' || v === 'sim';
}

/**
 * Páginas-alvo: tipo_conteudo=pagina + area_atendimento=true,
 * ainda em src/data/wp/pages/ (nunca archive/, nunca posts).
 */
async function loadTargetPages() {
	if (!(await pathExists(PRIO_CSV))) {
		console.error(
			`❌ Não encontrei ${path.relative(ROOT, PRIO_CSV)}.\n` +
				`   Rode antes: npm run audit:cidades`,
		);
		process.exit(1);
	}

	const rows = await readCsvRows(PRIO_CSV);
	const targets = [];

	for (const row of rows) {
		if (String(row.tipo_conteudo ?? '').trim() !== 'pagina') continue;
		if (!isTruthyArea(row.area_atendimento)) continue;

		const rel = String(row.arquivo ?? '')
			.trim()
			.replace(/\\/g, '/');
		if (!rel) continue;
		if (rel.includes('/archive/') || rel.startsWith('archive/')) continue;
		if (!rel.includes('src/data/wp/pages/')) continue;
		if (rel.includes('src/data/wp/posts/')) continue;

		const abs = path.join(ROOT, rel);
		if (!(await pathExists(abs))) continue;

		targets.push({
			arquivo: rel,
			abs,
			slug_url: String(row.slug_url ?? ''),
			cidade_detectada: String(row.cidade_detectada ?? ''),
		});
	}

	return targets;
}

function normalizePhoneDigits(phone) {
	return String(phone ?? '').replace(/\D/g, '');
}

function isOfficialPhone(phone) {
	const digits = normalizePhoneDigits(phone);
	if (!digits) return false;
	if (digits === OFFICIAL_PHONE_DIGITS) return true;
	if (digits === `55${OFFICIAL_PHONE_DIGITS}`) return true;
	// tel: / href variants
	if (digits.endsWith(OFFICIAL_PHONE_DIGITS) && digits.length <= OFFICIAL_PHONE_DIGITS.length + 2) {
		return true;
	}
	return false;
}

function hostFromUrl(href) {
	try {
		let raw = String(href ?? '').trim();
		if (!raw) return null;
		if (raw.startsWith('//')) raw = `https:${raw}`;
		if (!/^https?:\/\//i.test(raw)) return null;
		return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return null;
	}
}

function isWhitelistedHost(host) {
	if (!host) return true;
	const h = host.toLowerCase().replace(/^www\./, '');
	for (const suffix of WHITELIST_SUFFIXES) {
		if (h === suffix || h.endsWith(`.${suffix}`)) return true;
	}
	return false;
}

function stripHtmlText(html = '') {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z#0-9]+;/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
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

async function writeCsv(filePath, headers, rows) {
	const lines = [
		headers.join(','),
		...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(',')),
	];
	await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

// ——— telefone ———

/**
 * Substitui telefones não oficiais no texto bruto do arquivo.
 * Preserva tel: hrefs com formato oficial.
 */
function normalizePhonesInText(text) {
	let changed = 0;
	/** @type {Map<string, number>} */
	const found = new Map();

	// 1) href="tel:..."
	let out = text.replace(TEL_HREF_RE, (full, quote, telBody) => {
		const sample = String(telBody).trim();
		if (isOfficialPhone(sample)) return full;
		found.set(`tel:${sample}`, (found.get(`tel:${sample}`) ?? 0) + 1);
		changed += 1;
		return `href=${quote}${OFFICIAL_TEL_HREF}${quote}`;
	});

	// 2) Campos JSON "telefone"/"phone": "..."
	out = out.replace(
		/(["'](?:telefone|phone|tel|whatsapp|celular)["']\s*:\s*["'])([^"']+)(["'])/gi,
		(full, prefix, value, suffix) => {
			if (!PHONE_RE.test(value) && !/\d{8,}/.test(value)) return full;
			PHONE_RE.lastIndex = 0;
			if (isOfficialPhone(value)) return full;
			found.set(value.trim(), (found.get(value.trim()) ?? 0) + 1);
			changed += 1;
			return `${prefix}${OFFICIAL_PHONE_DISPLAY}${suffix}`;
		},
	);

	// 3) Telefones em texto (fora de tel: já tratados — evita reprocessar href tel)
	// Máscara temporária de tel: oficiais / já normalizados
	const masks = [];
	out = out.replace(/tel:[+\d\s.\-()]+/gi, (m) => {
		const token = `__TEL_MASK_${masks.length}__`;
		masks.push(m);
		return token;
	});

	PHONE_RE.lastIndex = 0;
	out = out.replace(PHONE_RE, (match) => {
		if (isOfficialPhone(match)) return match;
		const trimmed = match.trim();
		found.set(trimmed, (found.get(trimmed) ?? 0) + 1);
		changed += 1;
		return OFFICIAL_PHONE_DISPLAY;
	});

	out = out.replace(/__TEL_MASK_(\d+)__/g, (_, idx) => masks[Number(idx)] ?? '');

	return { text: out, changed, found };
}

async function cmdTelefone(apply) {
	const targets = await loadTargetPages();
	console.log(`📋 Alvos (página + área): ${targets.length}`);
	console.log(`Modo: ${apply ? '--apply (grava + git add)' : 'dry-run (só CSV)'}\n`);

	/** @type {Record<string, string>[]} */
	const report = [];
	let filesWithChanges = 0;
	let totalReplacements = 0;

	for (const target of targets) {
		const raw = await readFile(target.abs, 'utf8');
		const { text, changed, found } = normalizePhonesInText(raw);
		if (changed === 0) continue;

		filesWithChanges += 1;
		totalReplacements += changed;
		const phones = [...found.entries()]
			.map(([p, n]) => `${p} (×${n})`)
			.join(' | ');

		report.push({
			arquivo: target.arquivo,
			telefones_encontrados: phones,
			ocorrencias_a_trocar: String(changed),
		});

		if (apply && text !== raw) {
			await writeFile(target.abs, text, 'utf8');
			gitAdd(target.arquivo);
		}
	}

	await writeCsv(OUT_TELEFONE, ['arquivo', 'telefones_encontrados', 'ocorrencias_a_trocar'], report);

	console.log(`Arquivos com telefone a normalizar: ${filesWithChanges}`);
	console.log(`Ocorrências totais:                 ${totalReplacements}`);
	console.log(`CSV: ${path.relative(ROOT, OUT_TELEFONE)}`);
	if (apply) {
		console.log('\n✓ Alterações aplicadas e staged (git add). Sem commit.');
	} else {
		console.log('\nDry-run: nenhum arquivo alterado. Use --apply para gravar.');
	}
}

// ——— links-toxicos ———

async function loadToxicDomains() {
	if (!(await pathExists(AUDIT_CSV))) {
		console.error(
			`❌ Não encontrei ${path.relative(ROOT, AUDIT_CSV)}.\n` +
				`   Rode antes: npm run audit:cidades`,
		);
		process.exit(1);
	}

	const rows = await readCsvRows(AUDIT_CSV);
	/** @type {Set<string>} */
	const domains = new Set();
	for (const row of rows) {
		const cell = String(row.dominios_externos ?? '');
		for (const part of cell.split('|')) {
			const d = part.trim().toLowerCase().replace(/^www\./, '');
			if (!d) continue;
			if (isWhitelistedHost(d)) continue;
			domains.add(d);
		}
	}
	return domains;
}

function decodeHtmlEntities(s) {
	return String(s ?? '')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
}

function slugifyLoose(text) {
	return String(text ?? '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Extrai label de markers= do Google Maps (quando houver).
 */
function extractMapMarkerLabel(url) {
	try {
		const decoded = decodeHtmlEntities(url);
		const u = new URL(decoded.startsWith('//') ? `https:${decoded}` : decoded);
		const markers = u.searchParams.get('markers') || '';
		if (!markers) return null;
		// Formatos comuns: color:red|label:A|lat,lng  ou  label:Cidade|lat,lng
		const labelMatch = markers.match(/label:([^|]+)/i);
		if (labelMatch) return labelMatch[1].trim();
		// Às vezes o nome da cidade aparece como texto no markers
		const parts = markers.split('|').map((p) => p.trim());
		for (const p of parts) {
			if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(p)) continue;
			if (/^(?:color|size|scale):/i.test(p)) continue;
			if (p.length >= 3 && /[a-zA-ZÀ-ú]/.test(p)) return p;
		}
		return null;
	} catch {
		return null;
	}
}

function cityMismatch(pageCity, markerLabel) {
	if (!pageCity || !markerLabel) return false;
	const a = slugifyLoose(pageCity);
	const b = slugifyLoose(markerLabel);
	if (!a || !b) return false;
	if (a === b) return false;
	if (a.includes(b) || b.includes(a)) return false;
	// bairros vs município
	if (a.includes('sao-paulo') && /^(?:zona|centro|moema|pinheiros|itaim|vila)/.test(b)) return false;
	return true;
}

/**
 * Processa HTML/conteúdo: unwrap âncoras tóxicas, remove blocos sociais, sinaliza maps.
 * @returns {{ text: string, rows: object[] }}
 */
function processToxicLinks(content, { arquivo, cidade_detectada, toxicDomains }) {
	/** @type {object[]} */
	const rows = [];
	let text = content;

	// Ordem: social blocks → map markers report → generic anchors → bare URLs in markdown

	// 1) Âncoras HTML completas
	text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
		const hrefMatch = String(attrs).match(/\bhref\s*=\s*(["'])([^"']*)\1/i);
		if (!hrefMatch) return full;
		const href = hrefMatch[2];
		const host = hostFromUrl(href);
		if (!host) return full;

		const isMaps =
			/(?:maps\.google\.|google\.[^/]+\/maps|maps\.googleapis\.)/i.test(href) ||
			host === 'maps.google.com' ||
			(host === 'google.com' && /\/maps/i.test(href));

		if (isMaps) {
			const label = extractMapMarkerLabel(href);
			if (label && cityMismatch(cidade_detectada, label)) {
				rows.push({
					arquivo,
					dominio: host,
					tipo_link: 'mapa_embed_markers',
					acao: `SINALIZAR - markers label "${label}" ≠ cidade da página "${cidade_detectada}" (não corrigir auto)`,
					detalhe: href.slice(0, 180),
				});
			}
			return full; // whitelist maps — nunca remove
		}

		if (isWhitelistedHost(host)) return full;
		if (![...toxicDomains].some((d) => host === d || host.endsWith(`.${d}`))) {
			// Domínio externo não listado no audit original: ainda assim tratar se não whitelist
			// (requisito: lista = domínios do audit EXCETO whitelist). Fora da lista → ignorar.
			return full;
		}

		const baseHost = host.replace(/^www\./, '');
		const isSocial = [...SOCIAL_HOSTS].some((s) => baseHost === s || baseHost.endsWith(`.${s}`));

		if (isSocial) {
			const innerText = stripHtmlText(inner);
			const cupimProfile = CUPIM_SOCIAL_HINT.test(href) || CUPIM_SOCIAL_HINT.test(innerText);
			if (cupimProfile) {
				rows.push({
					arquivo,
					dominio: host,
					tipo_link: 'social_cupim',
					acao: 'MANTER - perfil Cupim Eco',
					detalhe: href.slice(0, 180),
				});
				return full;
			}
			rows.push({
				arquivo,
				dominio: host,
				tipo_link: 'social',
				acao: 'REMOVER bloco/linha inteira do link social',
				detalhe: href.slice(0, 180),
			});
			return ''; // remove bloco do <a>...</a>
		}

		const anchorText = stripHtmlText(inner) || stripHtmlText(full);
		rows.push({
			arquivo,
			dominio: host,
			tipo_link: 'ancora_html',
			acao: 'REMOVER link, preservar texto da âncora',
			detalhe: `${href.slice(0, 100)} → "${anchorText.slice(0, 80)}"`,
		});
		return inner; // unwrap: keep inner HTML/text
	});

	// 2) Markdown links [text](url)
	text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, (full, label, url) => {
		const host = hostFromUrl(url);
		if (!host || isWhitelistedHost(host)) return full;
		if (![...toxicDomains].some((d) => host === d || host.endsWith(`.${d}`))) return full;

		const baseHost = host.replace(/^www\./, '');
		const isSocial = [...SOCIAL_HOSTS].some((s) => baseHost === s || baseHost.endsWith(`.${s}`));
		if (isSocial && !CUPIM_SOCIAL_HINT.test(url) && !CUPIM_SOCIAL_HINT.test(label)) {
			rows.push({
				arquivo,
				dominio: host,
				tipo_link: 'social_markdown',
				acao: 'REMOVER bloco/linha inteira do link social',
				detalhe: url.slice(0, 180),
			});
			return '';
		}

		rows.push({
			arquivo,
			dominio: host,
			tipo_link: 'ancora_markdown',
			acao: 'REMOVER link, preservar texto da âncora',
			detalhe: `${url.slice(0, 100)} → "${label.slice(0, 80)}"`,
		});
		return label;
	});

	// 3) src= de iframes/embeds tóxicos (não maps whitelist)
	text = text.replace(/<iframe\b([^>]*)>[\s\S]*?<\/iframe>/gi, (full, attrs) => {
		const srcMatch = String(attrs).match(/\bsrc\s*=\s*(["'])([^"']*)\1/i);
		if (!srcMatch) return full;
		const src = srcMatch[2];
		const host = hostFromUrl(src);
		if (!host || isWhitelistedHost(host)) return full;
		if (![...toxicDomains].some((d) => host === d || host.endsWith(`.${d}`))) return full;

		const isMaps = /maps\.google|google\.[^/]+\/maps/i.test(src);
		if (isMaps) return full;

		rows.push({
			arquivo,
			dominio: host,
			tipo_link: 'iframe',
			acao: 'REMOVER iframe completo',
			detalhe: src.slice(0, 180),
		});
		return '';
	});

	// Limpa linhas vazias deixadas por remoção de sociais (só excesso extremo)
	text = text.replace(/[ \t]+\n/g, '\n');

	return { text, rows };
}

async function cmdLinksToxicos(apply) {
	const targets = await loadTargetPages();
	const toxicDomains = await loadToxicDomains();

	console.log(`📋 Alvos (página + área): ${targets.length}`);
	console.log(`☠ Domínios tóxicos (audit − whitelist): ${toxicDomains.size}`);
	console.log(`Modo: ${apply ? '--apply (grava + git add)' : 'dry-run (só CSV)'}\n`);

	/** @type {object[]} */
	const report = [];
	let filesChanged = 0;

	for (const target of targets) {
		const raw = await readFile(target.abs, 'utf8');
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			continue;
		}

		// Processa campos de texto ricos
		const fieldKeys = ['content', 'excerpt', 'title'];
		let fileRows = [];
		let mutated = false;

		for (const key of fieldKeys) {
			if (typeof data[key] !== 'string' || !data[key]) continue;
			const { text, rows } = processToxicLinks(data[key], {
				arquivo: target.arquivo,
				cidade_detectada: target.cidade_detectada,
				toxicDomains,
			});
			fileRows = fileRows.concat(rows);
			if (text !== data[key]) {
				data[key] = text;
				mutated = true;
			}
		}

		if (data.seo && typeof data.seo === 'object') {
			for (const key of ['title', 'description']) {
				if (typeof data.seo[key] !== 'string' || !data.seo[key]) continue;
				const { text, rows } = processToxicLinks(data.seo[key], {
					arquivo: target.arquivo,
					cidade_detectada: target.cidade_detectada,
					toxicDomains,
				});
				fileRows = fileRows.concat(rows);
				if (text !== data.seo[key]) {
					data.seo[key] = text;
					mutated = true;
				}
			}
		}

		report.push(...fileRows);

		const actionable = fileRows.some((r) => String(r.acao).startsWith('REMOVER'));
		if (apply && mutated && actionable) {
			const out = `${JSON.stringify(data, null, 2)}\n`;
			await writeFile(target.abs, out, 'utf8');
			gitAdd(target.arquivo);
			filesChanged += 1;
		} else if (mutated && !apply) {
			filesChanged += 1;
		}
	}

	await writeCsv(
		OUT_LINKS,
		['arquivo', 'dominio', 'tipo_link', 'acao', 'detalhe'],
		report,
	);

	const nRemove = report.filter((r) => String(r.acao).startsWith('REMOVER')).length;
	const nSignal = report.filter((r) => String(r.acao).startsWith('SINALIZAR')).length;

	console.log(`Linhas no relatório:     ${report.length}`);
	console.log(`  REMOVER:               ${nRemove}`);
	console.log(`  SINALIZAR (maps):      ${nSignal}`);
	console.log(`Arquivos que mudariam:   ${filesChanged}`);
	console.log(`CSV: ${path.relative(ROOT, OUT_LINKS)}`);
	if (apply) {
		console.log('\n✓ Remoções aplicadas e staged (git add). Sem commit.');
	} else {
		console.log('\nDry-run: nenhum arquivo alterado. Use --apply para gravar.');
	}
}

// ——— revisao-marca ———

function findBrandMentions(raw, arquivo) {
	/** @type {object[]} */
	const hits = [];
	WRONG_BRAND_NAME_RE.lastIndex = 0;
	let match;
	const re = new RegExp(WRONG_BRAND_NAME_RE.source, 'gi');

	while ((match = re.exec(raw)) !== null) {
		const idx = match.index;
		const start = Math.max(0, idx - 100);
		const end = Math.min(raw.length, idx + match[0].length + 100);
		const trecho = stripHtmlText(raw.slice(start, end)).slice(0, 220);
		const window = raw.slice(Math.max(0, idx - 160), Math.min(raw.length, idx + match[0].length + 160));

		// Exige contexto de auto-referência OU aceita se a marca errada aparece
		// como nome próprio em frase institucional (empresa/somos/nossa/referência)
		const hasContext = BRAND_CONTEXT_RE.test(window);
		const hasAllowed = ALLOWED_BRAND_NEARBY.test(window);
		if (!hasContext) continue;
		// Se Cupim Eco já está ao lado, ainda reporta a marca errada (revisão)
		hits.push({
			arquivo,
			marca: match[0],
			trecho,
			tem_cupim_eco_proximo: hasAllowed ? 'sim' : 'nao',
		});
	}

	return hits;
}

async function cmdRevisaoMarca() {
	const targets = await loadTargetPages();
	console.log(`📋 Alvos (página + área): ${targets.length}`);
	console.log('Modo: somente leitura (nunca edita)\n');

	/** @type {object[]} */
	const report = [];
	/** @type {Set<string>} */
	const pagesWithHit = new Set();

	for (const target of targets) {
		const raw = await readFile(target.abs, 'utf8');
		const hits = findBrandMentions(raw, target.arquivo);
		if (hits.length === 0) continue;
		pagesWithHit.add(target.arquivo);
		report.push(...hits);
	}

	await writeCsv(OUT_MARCA, ['arquivo', 'marca', 'trecho', 'tem_cupim_eco_proximo'], report);

	console.log(`Páginas com menção de marca errada (contexto institucional): ${pagesWithHit.size}`);
	console.log(`Trechos listados: ${report.length}`);
	console.log(`CSV: ${path.relative(ROOT, OUT_MARCA)}`);
	console.log('\nNenhuma alteração feita — revise manualmente.');
}

// ——— main ———

async function main() {
	const { cmd, apply } = parseArgs(process.argv.slice(2));

	const usage =
		'Uso:\n' +
		'  node scripts/normalize-content.mjs telefone [--apply]\n' +
		'  node scripts/normalize-content.mjs links-toxicos [--apply]\n' +
		'  node scripts/normalize-content.mjs revisao-marca\n';

	if (!['telefone', 'links-toxicos', 'revisao-marca'].includes(cmd)) {
		console.error(`❌ Sub-comando inválido: ${cmd || '(vazio)'}\n\n${usage}`);
		process.exit(1);
	}

	if (cmd === 'revisao-marca' && apply) {
		console.error('❌ revisao-marca é sempre somente leitura — não use --apply.\n');
		process.exit(1);
	}

	assertCleanGit();

	if (cmd === 'telefone') await cmdTelefone(apply);
	else if (cmd === 'links-toxicos') await cmdLinksToxicos(apply);
	else await cmdRevisaoMarca();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
