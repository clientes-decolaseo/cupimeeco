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
 *   node scripts/normalize-content.mjs marca-padroes
 */
import { spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import cidadesGsp from '../src/data/cidades-gsp.json' with { type: 'json' };

const ROOT = path.resolve('.');
const PRIO_CSV = path.join(ROOT, 'scripts', '.tmp-audit-priorizacao.csv');
const AUDIT_CSV = path.join(ROOT, 'scripts', '.tmp-audit-cidades.csv');
const OUT_TELEFONE = path.join(ROOT, 'scripts', '.tmp-normalizacao-telefone.csv');
const OUT_LINKS = path.join(ROOT, 'scripts', '.tmp-normalizacao-links.csv');
const OUT_MARCA = path.join(ROOT, 'scripts', '.tmp-revisao-marca.csv');
const OUT_PADROES = path.join(ROOT, 'scripts', '.tmp-padroes-marca.csv');

const OFFICIAL_PHONE_DISPLAY = '0800 111 7272';
const OFFICIAL_PHONE_DIGITS = '08001117272';
const OFFICIAL_TEL_HREF = `tel:${OFFICIAL_PHONE_DIGITS}`;

/** Padrão do audit + variante compacta em title/seo: "(11)3211-0000" (sem espaço após DDD). */
const PHONE_RE =
	/(?:0800[\s.\-]?\d{3}[\s.\-]?\d{4})|(?:\(\d{2}\)\s*\d{4,5}[\s.\-]?\d{4})|(?:\(?\d{2}\)?[\s.\-]\d{4,5}[\s.\-]\d{4})|(?:\+?55[\s.\-]?\(?\d{2}\)?[\s.\-]?\d{4,5}[\s.\-]\d{4})/g;

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
	// Ex.: 551108001117272 (55 + DDD + 0800…)
	if (digits.endsWith(OFFICIAL_PHONE_DIGITS)) return true;
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

/** Campos textuais do JSON WP a normalizar (além de content). */
const PHONE_TEXT_FIELDS_TOP = ['title', 'excerpt', 'description', 'caption', 'summary'];
const PHONE_TEXT_FIELDS_SEO = ['title', 'description', 'ogTitle', 'ogDescription', 'twitterDescription'];

/**
 * Substitui telefones não oficiais no texto.
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

	// 2) Campos JSON "telefone"/"phone": "..." (quando o pedaço for o arquivo inteiro)
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

	// 3) Telefones em texto (fora de tel: já tratados)
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

function mergePhoneFound(into, from) {
	for (const [k, n] of from.entries()) {
		into.set(k, (into.get(k) ?? 0) + n);
	}
}

/**
 * Normaliza telefones em content + metadata textual (title, excerpt, seo.*, etc.).
 * @returns {{ data: object, changed: number, found: Map<string, number>, campos: string[], contentChanged: number, metaChanged: number }}
 */
function normalizePhonesInWpJson(data) {
	/** @type {Map<string, number>} */
	const found = new Map();
	/** @type {string[]} */
	const campos = [];
	let changed = 0;
	let contentChanged = 0;
	let metaChanged = 0;

	const applyField = (obj, key, label, isContent = false) => {
		if (!obj || typeof obj[key] !== 'string' || !obj[key]) return;
		const result = normalizePhonesInText(obj[key]);
		if (result.changed === 0) return;
		obj[key] = result.text;
		changed += result.changed;
		if (isContent) contentChanged += result.changed;
		else metaChanged += result.changed;
		mergePhoneFound(found, result.found);
		campos.push(`${label}:${result.changed}`);
	};

	applyField(data, 'content', 'content', true);

	for (const key of PHONE_TEXT_FIELDS_TOP) {
		applyField(data, key, key, false);
	}

	// Campos soltos tipo telefone/phone no root
	for (const key of ['telefone', 'phone', 'tel', 'whatsapp', 'celular']) {
		applyField(data, key, key, false);
	}

	if (data.seo && typeof data.seo === 'object') {
		for (const key of PHONE_TEXT_FIELDS_SEO) {
			applyField(data.seo, key, `seo.${key}`, false);
		}
		for (const key of ['telefone', 'phone', 'tel', 'whatsapp']) {
			applyField(data.seo, key, `seo.${key}`, false);
		}
	}

	return { data, changed, found, campos, contentChanged, metaChanged };
}

async function cmdTelefone(apply) {
	const targets = await loadTargetPages();
	console.log(`📋 Alvos (página + área): ${targets.length}`);
	console.log(`Modo: ${apply ? '--apply (grava + git add)' : 'dry-run (só CSV)'}`);
	console.log('Campos: content + title/excerpt/description + seo.* (+ telefone/phone)\n');

	/** Baseline do dry-run anterior (246 arquivos / 455 ocorrências), se existir */
	let baselineFiles = new Set();
	let baselineOcc = 0;
	if (await pathExists(OUT_TELEFONE)) {
		try {
			const prev = await readCsvRows(OUT_TELEFONE);
			baselineFiles = new Set(prev.map((r) => r.arquivo).filter(Boolean));
			baselineOcc = prev.reduce((s, r) => s + (Number(r.ocorrencias_a_trocar) || 0), 0);
			console.log(
				`Baseline CSV anterior: ${baselineFiles.size} arquivos / ${baselineOcc} ocorrências\n`,
			);
		} catch {
			/* ignore */
		}
	}

	/** @type {Record<string, string>[]} */
	const report = [];
	let filesWithChanges = 0;
	let totalReplacements = 0;
	let totalContent = 0;
	let totalMeta = 0;
	let filesMetaOnly = 0;
	let filesNewVsBaseline = 0;
	let occInNewFiles = 0;
	let occMetaInOldFiles = 0;

	for (const target of targets) {
		const raw = await readFile(target.abs, 'utf8');
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			// Fallback: arquivo não-JSON — trata texto bruto (compat)
			const { text, changed, found } = normalizePhonesInText(raw);
			if (changed === 0) continue;
			filesWithChanges += 1;
			totalReplacements += changed;
			totalContent += changed;
			report.push({
				arquivo: target.arquivo,
				campos: 'raw',
				telefones_encontrados: [...found.entries()].map(([p, n]) => `${p} (×${n})`).join(' | '),
				ocorrencias_a_trocar: String(changed),
				ocorrencias_content: String(changed),
				ocorrencias_metadata: '0',
			});
			if (apply && text !== raw) {
				await writeFile(target.abs, text, 'utf8');
				gitAdd(target.arquivo);
			}
			continue;
		}

		const { data: next, changed, found, campos, contentChanged, metaChanged } =
			normalizePhonesInWpJson(structuredClone(data));
		if (changed === 0) continue;

		filesWithChanges += 1;
		totalReplacements += changed;
		totalContent += contentChanged;
		totalMeta += metaChanged;
		if (metaChanged > 0 && contentChanged === 0) filesMetaOnly += 1;

		const inBaseline = baselineFiles.has(target.arquivo);
		if (!inBaseline) {
			filesNewVsBaseline += 1;
			occInNewFiles += changed;
		} else if (metaChanged > 0) {
			// Em arquivos já listados, ocorrências extras típicas de metadata
			occMetaInOldFiles += metaChanged;
		}

		report.push({
			arquivo: target.arquivo,
			campos: campos.join(' | '),
			telefones_encontrados: [...found.entries()].map(([p, n]) => `${p} (×${n})`).join(' | '),
			ocorrencias_a_trocar: String(changed),
			ocorrencias_content: String(contentChanged),
			ocorrencias_metadata: String(metaChanged),
		});

		if (apply) {
			const out = `${JSON.stringify(next, null, 2)}\n`;
			if (out !== raw) {
				await writeFile(target.abs, out, 'utf8');
				gitAdd(target.arquivo);
			}
		}
	}

	await writeCsv(
		OUT_TELEFONE,
		[
			'arquivo',
			'campos',
			'telefones_encontrados',
			'ocorrencias_a_trocar',
			'ocorrencias_content',
			'ocorrencias_metadata',
		],
		report,
	);

	console.log(`Arquivos com telefone a normalizar: ${filesWithChanges}`);
	console.log(`Ocorrências totais:                 ${totalReplacements}`);
	console.log(`  · em content:                     ${totalContent}`);
	console.log(`  · em metadata (title/excerpt/seo): ${totalMeta}`);
	console.log(`Arquivos só-metadata (sem content): ${filesMetaOnly}`);

	if (baselineFiles.size > 0) {
		const deltaFiles = filesWithChanges - baselineFiles.size;
		const deltaOcc = totalReplacements - baselineOcc;
		console.log('\n=== Comparação com baseline 246/455 ===');
		console.log(`Arquivos agora:     ${filesWithChanges}  (Δ arquivos = ${deltaFiles >= 0 ? '+' : ''}${deltaFiles})`);
		console.log(`Ocorrências agora:  ${totalReplacements}  (Δ ocorrências = ${deltaOcc >= 0 ? '+' : ''}${deltaOcc})`);
		console.log(`Arquivos novos vs baseline:           ${filesNewVsBaseline} (+${occInNewFiles} ocorrências)`);
		console.log(
			`Ocorrências de metadata em arquivos já no baseline: ${occMetaInOldFiles}`,
		);
		console.log(
			`Adicional efetivo (novos arquivos + meta em arquivos antigos): ${filesNewVsBaseline} arquivos / ${occInNewFiles + occMetaInOldFiles} ocorrências`,
		);
	}

	console.log(`\nCSV: ${path.relative(ROOT, OUT_TELEFONE)}`);
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

// ——— marca-padroes ———

function escapeRegExp(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleFromSlug(slug) {
	return String(slug)
		.split('-')
		.filter(Boolean)
		.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
		.join(' ');
}

/** Nomes de município/bairro/alias para substituir por {CIDADE} (mais longos primeiro). */
function buildPlaceNames() {
	/** @type {Set<string>} */
	const names = new Set();

	for (const m of Object.values(cidadesGsp.municipios ?? {})) {
		if (m?.nome) names.add(m.nome);
	}

	for (const alias of Object.keys(cidadesGsp.aliases ?? {})) {
		const a = alias.trim();
		if (a.length < 4) continue;
		if (/^(?:sp|capital)$/i.test(a)) continue;
		names.add(titleFromSlug(a.replace(/\s+/g, '-')));
		// Mantém forma original do alias (ex.: "são paulo", "zona sul")
		names.add(a.replace(/\b\w/g, (c) => c.toUpperCase()));
		names.add(a);
	}

	for (const slug of cidadesGsp.bairrosSaoPaulo ?? []) {
		names.add(titleFromSlug(slug));
	}

	const extras = [
		'Grande São Paulo',
		'grande São Paulo',
		'São Paulo Capital',
		'Zona Norte',
		'Zona Sul',
		'Zona Leste',
		'Zona Oeste',
		'Zona Central',
		'Centro de São Paulo',
		'ABC Paulista',
		'Baixada Santista',
		'Vale do Paraíba',
		'Litoral Norte',
		'Interior de São Paulo',
	];
	for (const e of extras) names.add(e);

	return [...names]
		.filter((n) => n && n.length >= 3)
		.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

const PLACE_NAMES = buildPlaceNames();
const PLACE_NAME_RE = new RegExp(
	`\\b(?:${PLACE_NAMES.map(escapeRegExp).join('|')})\\b`,
	'gi',
);

/**
 * Normaliza trecho: cidades/bairros → {CIDADE}, comprime espaços, lowercase leve
 * só para pontuação/espaços (mantém casing das palavras restantes para legibilidade
 * do padrão, mas unifica whitespace e places).
 */
function normalizeMarcaPattern(trecho) {
	let s = String(trecho ?? '');
	s = s.replace(/\r\n|\r|\n/g, ' ');
	s = s.replace(/\\n/g, ' ');
	// remove ruído HTML residual
	s = s.replace(/<[^>]+>/g, ' ');
	s = s.replace(/&[a-z#0-9]+;/gi, ' ');
	PLACE_NAME_RE.lastIndex = 0;
	s = s.replace(PLACE_NAME_RE, '{CIDADE}');
	// Colapsa placeholders repetidos adjacentes
	s = s.replace(/(?:\{CIDADE\}\s*){2,}/g, '{CIDADE} ');
	s = s.replace(/\s+/g, ' ').trim();
	return s;
}

async function cmdMarcaPadroes() {
	if (!(await pathExists(OUT_MARCA))) {
		console.error(
			`❌ Não encontrei ${path.relative(ROOT, OUT_MARCA)}.\n` +
				`   Rode antes: npm run normalize:marca`,
		);
		process.exit(1);
	}

	const rows = await readCsvRows(OUT_MARCA);
	console.log(`📋 Trechos em revisao-marca: ${rows.length}`);
	console.log('Modo: somente leitura (agrupa padrões — não edita)\n');

	/** @type {Map<string, { count: number; arquivos: Set<string>; exemplo: string }>} */
	const groups = new Map();

	for (const row of rows) {
		const trecho = String(row.trecho ?? '');
		const arquivo = String(row.arquivo ?? '');
		const padrao = normalizeMarcaPattern(trecho);
		if (!padrao) continue;

		let g = groups.get(padrao);
		if (!g) {
			g = { count: 0, arquivos: new Set(), exemplo: trecho };
			groups.set(padrao, g);
		}
		g.count += 1;
		if (arquivo) g.arquivos.add(arquivo);
		// Preferir exemplo um pouco mais longo / completo
		if (trecho.length > g.exemplo.length) g.exemplo = trecho;
	}

	const sorted = [...groups.entries()].sort(
		(a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
	);

	const report = sorted.map(([padrao, g]) => ({
		padrao_normalizado: padrao,
		quantidade: String(g.count),
		arquivos: [...g.arquivos].sort().join(' | '),
		exemplo_real: g.exemplo,
	}));

	await writeCsv(
		OUT_PADROES,
		['padrao_normalizado', 'quantidade', 'arquivos', 'exemplo_real'],
		report,
	);

	const topN = 15;
	const top = sorted.slice(0, topN);
	const topSum = top.reduce((s, [, g]) => s + g.count, 0);
	const total = rows.length;
	const pct = total ? ((100 * topSum) / total).toFixed(1) : '0';

	console.log(`Padrões únicos: ${sorted.length}`);
	console.log(`CSV: ${path.relative(ROOT, OUT_PADROES)}\n`);
	console.log(`=== Top ${topN} padrões por frequência ===\n`);
	top.forEach(([padrao, g], i) => {
		const preview = padrao.length > 110 ? `${padrao.slice(0, 110)}…` : padrao;
		console.log(`${String(i + 1).padStart(2)}. ×${String(g.count).padStart(3)}  ${preview}`);
	});
	console.log(
		`\nTop ${topN} cobrem ${topSum}/${total} trechos (${pct}%). ` +
			`Corrigir só esses padrões resolve a maior fatia do problema.`,
	);
	console.log('\nNenhuma alteração feita.');
}

// ——— main ———

async function main() {
	const { cmd, apply } = parseArgs(process.argv.slice(2));

	const usage =
		'Uso:\n' +
		'  node scripts/normalize-content.mjs telefone [--apply]\n' +
		'  node scripts/normalize-content.mjs links-toxicos [--apply]\n' +
		'  node scripts/normalize-content.mjs revisao-marca\n' +
		'  node scripts/normalize-content.mjs marca-padroes\n';

	if (!['telefone', 'links-toxicos', 'revisao-marca', 'marca-padroes'].includes(cmd)) {
		console.error(`❌ Sub-comando inválido: ${cmd || '(vazio)'}\n\n${usage}`);
		process.exit(1);
	}

	if ((cmd === 'revisao-marca' || cmd === 'marca-padroes') && apply) {
		console.error(`❌ ${cmd} é sempre somente leitura — não use --apply.\n`);
		process.exit(1);
	}

	assertCleanGit();

	if (cmd === 'telefone') await cmdTelefone(apply);
	else if (cmd === 'links-toxicos') await cmdLinksToxicos(apply);
	else if (cmd === 'revisao-marca') await cmdRevisaoMarca();
	else await cmdMarcaPadroes();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
