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
const OUT_TELEFONE_V2 = path.join(ROOT, 'scripts', '.tmp-normalizacao-telefone-v2.csv');
const OUT_TELEFONES_UNICOS = path.join(ROOT, 'scripts', '.tmp-telefones-unicos.json');
const OUT_LINKS = path.join(ROOT, 'scripts', '.tmp-normalizacao-links.csv');
const OUT_MARCA = path.join(ROOT, 'scripts', '.tmp-revisao-marca.csv');
const OUT_PADROES = path.join(ROOT, 'scripts', '.tmp-padroes-marca.csv');

const OFFICIAL_PHONE_DISPLAY = '0800 111 7272';
const OFFICIAL_PHONE_DIGITS = '08001117272';
const OFFICIAL_TEL_DIGITS = OFFICIAL_PHONE_DIGITS;

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

/** Forma canônica exata — não precisa substituir. */
function isExactOfficialForm(phone) {
	const t = String(phone ?? '').trim();
	if (t === OFFICIAL_PHONE_DISPLAY) return true;
	if (t === OFFICIAL_PHONE_DIGITS) return true;
	if (t === `tel:${OFFICIAL_PHONE_DIGITS}`) return true;
	return normalizePhoneDigits(t) === OFFICIAL_PHONE_DIGITS;
}

/** Qualquer variante do 0800 oficial (com 55, zero faltando, etc.). */
function isOfficialPhone(phone) {
	const digits = normalizePhoneDigits(phone);
	if (!digits) return false;
	if (digits.includes(OFFICIAL_PHONE_DIGITS)) return true;
	// 8001117272 (faltou o 0 inicial do 0800)
	if (digits.endsWith('8001117272')) return true;
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

// ——— telefone (lista fechada + substituição literal) ———

/**
 * Telefones BR (mesma lógica do audit-city-pages.mjs):
 * fixo (DD)+8 dígitos e celular (DD)+9 dígitos (em geral começando com 9).
 */
const PHONE_RE =
	/(?:0800[\s.\-]?\d{3}[\s.\-]?\d{4})|(?:\(\d{2}\)\s*\d{4,5}[\s.\-]?\d{4})|(?:\(?\d{2}\)?[\s.\-]\d{4,5}[\s.\-]\d{4})|(?:\+?55[\s.\-]?\(?\d{2}\)?[\s.\-]?\d{4,5}[\s.\-]?\d{4})|(?:\+?55\d{10,11})/g;

/**
 * Agrega telefones únicos da coluna `telefones` do audit (Etapa 4).
 * Salva em scripts/.tmp-telefones-unicos.json
 * Passe force=true para regenerar mesmo se o arquivo já existir.
 * @returns {Promise<{ numero: string, ocorrencias_paginas: number }[]>}
 */
async function loadOrBuildUniquePhones(force = false) {
	if (!force && (await pathExists(OUT_TELEFONES_UNICOS))) {
		try {
			const data = JSON.parse(await readFile(OUT_TELEFONES_UNICOS, 'utf8'));
			if (Array.isArray(data) && data.length > 0) {
				console.log(
					`📞 Lista de telefones: ${path.relative(ROOT, OUT_TELEFONES_UNICOS)} (${data.length} únicos)\n`,
				);
				return data;
			}
		} catch {
			/* regenera abaixo */
		}
	}

	if (!(await pathExists(AUDIT_CSV))) {
		console.error(
			`❌ Não encontrei ${path.relative(ROOT, AUDIT_CSV)} nem ${path.relative(ROOT, OUT_TELEFONES_UNICOS)}.\n` +
				`   Rode antes: npm run audit:cidades`,
		);
		process.exit(1);
	}

	const rows = await readCsvRows(AUDIT_CSV);
	/** @type {Map<string, number>} */
	const freq = new Map();

	for (const row of rows) {
		const cell = String(row.telefones ?? '');
		const seenInPage = new Set();
		for (const part of cell.split('|')) {
			const numero = part.trim();
			if (!numero) continue;
			if (seenInPage.has(numero)) continue;
			seenInPage.add(numero);
			freq.set(numero, (freq.get(numero) ?? 0) + 1);
		}
	}

	const list = [...freq.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([numero, ocorrencias_paginas]) => ({ numero, ocorrencias_paginas }));

	await writeFile(OUT_TELEFONES_UNICOS, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
	console.log(
		`📞 Telefones únicos regenerados do audit: ${list.length} → ${path.relative(ROOT, OUT_TELEFONES_UNICOS)}\n`,
	);
	return list;
}

/**
 * Variações de formatação para DDD + assinante (8 ou 9 dígitos).
 * @param {(s: string) => void} add
 * @param {string} ddd
 * @param {string} sub assinante (8=fixo, 9=celular)
 */
function addDddSubscriberVariations(add, ddd, sub) {
	if (!ddd || !sub || (sub.length !== 8 && sub.length !== 9)) return;
	const p1 = sub.length === 9 ? sub.slice(0, 5) : sub.slice(0, 4);
	const p2 = sub.length === 9 ? sub.slice(5) : sub.slice(4);

	const baseForms = [
		`(${ddd}) ${p1}-${p2}`,
		`(${ddd})${p1}-${p2}`,
		`(${ddd}) ${p1}${p2}`,
		`(${ddd})${p1}${p2}`,
		`(${ddd}) ${p1} ${p2}`,
		`(${ddd})-${p1}-${p2}`,
		`(${ddd}).${p1}.${p2}`,
		`${ddd} ${p1}-${p2}`,
		`${ddd} ${p1} ${p2}`,
		`${ddd}${p1}-${p2}`,
		`${ddd}.${p1}.${p2}`,
		`${ddd}-${p1}-${p2}`,
		`${ddd}${p1}${p2}`,
		`${p1}-${p2}`,
		`${p1} ${p2}`,
		`${p1}${p2}`,
		`+55${ddd}${p1}${p2}`,
		`+55 ${ddd} ${p1}-${p2}`,
		`+55 (${ddd}) ${p1}-${p2}`,
		`+55(${ddd})${p1}-${p2}`,
		`+55(${ddd}) ${p1}-${p2}`,
		`55${ddd}${p1}${p2}`,
		`55 ${ddd} ${p1}-${p2}`,
		`tel:${ddd}${p1}${p2}`,
		`tel:+55${ddd}${p1}${p2}`,
		`tel:55${ddd}${p1}${p2}`,
		`tel:+55${ddd}${p1}-${p2}`,
		`tel:(${ddd})${p1}-${p2}`,
		`tel:(${ddd}) ${p1}-${p2}`,
	];

	for (const form of baseForms) {
		add(form);
		// Separadores tipográficos comuns em HTML/WP
		add(form.replace(/ /g, '\u00a0'));
		add(form.replace(/ /g, '\u202f'));
		add(form.replace(/-/g, '\u2011'));
		add(form.replace(/-/g, '\u2010'));
		add(form.replace(/ /g, '\u00a0').replace(/-/g, '\u2011'));
		add(form.replace(/ /g, '\u202f').replace(/-/g, '\u2011'));
	}
}

/**
 * Gera variações literais plausíveis de escrita a partir dos dígitos.
 * Cobre fixo (8) e celular (9) com/sem espaço, parênteses e hífen.
 * Ordenadas da mais longa para a mais curta (substituição segura).
 */
function generatePhoneVariations(numeroOriginal) {
	const original = String(numeroOriginal ?? '').trim();
	const digits = normalizePhoneDigits(original);
	/** @type {Set<string>} */
	const out = new Set();
	if (!digits || digits.length < 8) return [];

	const add = (s) => {
		const t = String(s ?? '').trim();
		if (t.length >= 7) out.add(t);
		// também versão com espaço normal se veio com NBSP
		if (t.includes('\u00a0')) out.add(t.replace(/\u00a0/g, ' '));
	};

	add(original);
	if (original.includes('\u00a0')) add(original.replace(/\u00a0/g, ' '));

	let local = digits;
	if (local.startsWith('55') && local.length >= 12) local = local.slice(2);

	// Variante do 0800 oficial (ex.: 5508001117272, 558001117272):
	// só literais dessa forma — não reinterpretar como fixo DD+NNNN.
	if (isOfficialPhone(original) && !isExactOfficialForm(original)) {
		add(digits);
		add(original);
		if (local.startsWith('0800') && local.length === 11) {
			const rest = local.slice(4);
			add(local);
			add(`0800 ${rest.slice(0, 3)} ${rest.slice(3)}`);
			add(`0800${rest}`);
			add(`0800-${rest.slice(0, 3)}-${rest.slice(3)}`);
			add(`+55${local}`);
			add(`55${local}`);
			add(`tel:${local}`);
			add(`tel:+55${local}`);
			add(`tel:55${local}`);
		} else {
			// Forma truncada (ex.: 558001117272) — só o literal completo, sem stem curto
			add(`+${digits}`);
			add(`tel:${digits}`);
			add(`tel:+${digits}`);
		}
		return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
	}

	// 0800 (não-oficial / outros 0800)
	if (local.startsWith('0800') && local.length === 11) {
		const rest = local.slice(4); // 7 dígitos
		const a = rest.slice(0, 3);
		const b = rest.slice(3);
		add(`0800 ${a} ${b}`);
		add(`0800${a}${b}`);
		add(`0800-${a}-${b}`);
		add(`0800.${a}.${b}`);
		add(`0800 ${a}${b}`);
		add(`0800-${a}${b}`);
		add(local);
		add(`+55${local}`);
		add(`55${local}`);
		add(`tel:${local}`);
		add(`tel:+55${local}`);
		add(`tel:55${local}`);
		return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
	}

	// Fixo 10 dígitos (DD + 8) ou celular 11 dígitos (DD + 9)
	if (local.length === 10 || (local.length === 11 && !local.startsWith('0800'))) {
		const ddd = local.slice(0, 2);
		const sub = local.slice(2);
		addDddSubscriberVariations(add, ddd, sub);
	}

	// Também: dígitos crus com/sem 55
	add(digits);
	add(local);
	if (!digits.startsWith('55')) add(`55${local}`);

	return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Substitui literais de telefone numa string.
 * Em contexto tel: → 08001117272; senão → 0800 111 7272.
 * @returns {{ text: string, hits: { numero_original: string, variacao: string, count: number }[] }}
 */
function replacePhonesLiteralInString(text, replacementPlan) {
	let out = text;
	/** @type {{ numero_original: string, variacao: string, count: number }[]} */
	const hits = [];

	for (const item of replacementPlan) {
		const { numero, variations } = item;
		for (const variation of variations) {
			if (!variation || !out.includes(variation)) continue;

			// Conta ocorrências antes
			let count = 0;
			let idx = 0;
			while ((idx = out.indexOf(variation, idx)) !== -1) {
				count += 1;
				idx += variation.length;
			}
			if (count === 0) continue;

			// Substituição contextual: se a variação já começa com tel:, só dígitos oficiais
			if (/^tel:/i.test(variation)) {
				out = out.split(variation).join(`tel:${OFFICIAL_TEL_DIGITS}`);
			} else {
				// tel: imediatamente antes da variação (sem ser parte da variação)
				const telPrefix = `tel:${variation}`;
				if (out.includes(telPrefix)) {
					const telCount = out.split(telPrefix).length - 1;
					out = out.split(telPrefix).join(`tel:${OFFICIAL_TEL_DIGITS}`);
					hits.push({
						numero_original: numero,
						variacao: telPrefix,
						count: telCount,
					});
					// recontar o que sobrou da variação solta
					count = 0;
					idx = 0;
					while ((idx = out.indexOf(variation, idx)) !== -1) {
						count += 1;
						idx += variation.length;
					}
					if (count === 0) continue;
				}
				out = out.split(variation).join(OFFICIAL_PHONE_DISPLAY);
			}

			hits.push({ numero_original: numero, variacao: variation, count });
		}
	}

	return { text: out, hits };
}

/**
 * Percorre recursivamente todos os campos string do JSON.
 * @returns {{ data: any, hits: { campo: string, numero_original: string, variacao: string, count: number }[], changed: boolean }}
 */
function replacePhonesInJsonTree(data, replacementPlan, basePath = '') {
	/** @type {{ campo: string, numero_original: string, variacao: string, count: number }[]} */
	const hits = [];
	let changed = false;

	const walk = (node, path) => {
		if (typeof node === 'string') {
			const { text, hits: localHits } = replacePhonesLiteralInString(node, replacementPlan);
			if (localHits.length > 0) {
				changed = true;
				for (const h of localHits) {
					hits.push({ campo: path || '(root)', ...h });
				}
			}
			return text;
		}
		if (Array.isArray(node)) {
			return node.map((item, i) => walk(item, path ? `${path}[${i}]` : `[${i}]`));
		}
		if (node && typeof node === 'object') {
			/** @type {Record<string, unknown>} */
			const out = Array.isArray(node) ? [] : { ...node };
			for (const [key, value] of Object.entries(node)) {
				out[key] = walk(value, path ? `${path}.${key}` : key);
			}
			return out;
		}
		return node;
	};

	const next = walk(data, basePath);
	return { data: next, hits, changed };
}

/**
 * Após simular apply: busca variações dos telefones da lista que ainda restariam.
 * Também normaliza espaços/hífens tipográficos antes de procurar.
 */
function findRemainingPhoneSnippets(text, phoneList, replacementPlanByNumero) {
	/** @type {{ numero: string, variacao: string, trecho: string }[]} */
	const leftovers = [];
	const normText = text
		.replace(/[\u00a0\u202f\u2007\u2009]/g, ' ')
		.replace(/[\u2010\u2011\u2012\u2013\u2212]/g, '-');

	for (const entry of phoneList) {
		if (isOfficialPhone(entry.numero)) continue;

		const digits = normalizePhoneDigits(entry.numero);
		let local = digits;
		if (local.startsWith('55') && local.length >= 12) local = local.slice(2);

		const all = replacementPlanByNumero.get(entry.numero) ?? generatePhoneVariations(entry.numero);
		const toCheck = all.filter((v) => {
			if (!v || v.length < 8) return false;
			if (isExactOfficialForm(v)) return false;
			if (v === OFFICIAL_PHONE_DISPLAY || v === OFFICIAL_PHONE_DIGITS) return false;
			if (v === `tel:${OFFICIAL_PHONE_DIGITS}`) return false;
			const vd = normalizePhoneDigits(v.replace(/^tel:/i, ''));
			if (v === entry.numero) return true;
			if (/^tel:/i.test(v)) return true;
			if (/\(\d{2}\)/.test(v)) return true;
			if (vd === local || vd === digits || vd === `55${local}`) return true;
			if (local.length >= 10 && vd.length >= 10 && vd.includes(local)) return true;
			return false;
		});

		for (const variation of toCheck) {
			const forms = [
				variation,
				variation.replace(/[\u00a0\u202f]/g, ' ').replace(/[\u2010\u2011]/g, '-'),
			];
			for (const form of forms) {
				for (const hay of [text, normText]) {
					let idx = 0;
					while ((idx = hay.indexOf(form, idx)) !== -1) {
						const start = Math.max(0, idx - 40);
						const end = Math.min(hay.length, idx + form.length + 40);
						leftovers.push({
							numero: entry.numero,
							variacao: form,
							trecho: hay.slice(start, end).replace(/\s+/g, ' '),
						});
						idx += form.length;
						if (leftovers.length > 500) return leftovers;
					}
				}
			}
		}
	}
	return leftovers;
}

async function cmdTelefone(apply) {
	const targets = await loadTargetPages();
	const phoneList = await loadOrBuildUniquePhones(true);

	console.log(`📋 Alvos (página + área): ${targets.length}`);
	console.log(`Modo: ${apply ? '--apply (grava + git add)' : 'dry-run (lista fechada)'}`);
	console.log('Estratégia: substituição LITERAL por variações dos telefones únicos do audit\n');

	/** Planos de substituição (pula oficiais) */
	const replacementPlan = [];
	/** @type {Map<string, string[]>} */
	const planByNumero = new Map();

	for (const entry of phoneList) {
		// Só pula a forma canônica; variantes do 0800 ainda são normalizadas para o padrão
		if (isExactOfficialForm(entry.numero)) continue;
		const variations = generatePhoneVariations(entry.numero);
		const filtered = variations.filter(
			(v) => !isExactOfficialForm(v) && v !== OFFICIAL_PHONE_DISPLAY,
		);
		if (filtered.length === 0) continue;
		replacementPlan.push({ numero: entry.numero, variations: filtered });
		planByNumero.set(entry.numero, filtered);
	}

	// Ordena variações globais: processar números com variações mais longas primeiro
	// (já ordenado dentro de cada numero; entre numeros, prioriza o primeiro hit)
	console.log(`Telefones a normalizar (não oficiais): ${replacementPlan.length}`);
	const totalVars = replacementPlan.reduce((s, p) => s + p.variations.length, 0);
	console.log(`Variações literais geradas: ${totalVars}\n`);

	/** @type {Record<string, string>[]} */
	const report = [];
	let filesChanged = 0;
	let totalHits = 0;

	/** Para verificação pós dry-run */
	/** @type {{ arquivo: string, numero: string, variacao: string, trecho: string }[]} */
	const uncovered = [];

	for (const target of targets) {
		const raw = await readFile(target.abs, 'utf8');
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			console.warn(`  ⚠ JSON inválido, pulando: ${target.arquivo}`);
			continue;
		}

		const { data: next, hits, changed } = replacePhonesInJsonTree(
			structuredClone(data),
			replacementPlan,
		);

		if (changed && hits.length > 0) {
			filesChanged += 1;
			for (const h of hits) {
				totalHits += h.count;
				report.push({
					arquivo: target.arquivo,
					numero_original: h.numero_original,
					variacao: h.variacao,
					campo: h.campo,
					ocorrencias: String(h.count),
				});
			}

			if (apply) {
				const out = `${JSON.stringify(next, null, 2)}\n`;
				await writeFile(target.abs, out, 'utf8');
				gitAdd(target.arquivo);
			}
		}

		// Verificação: simula o texto pós-apply (árvore next) e procura restos
		const probeText = JSON.stringify(changed ? next : data);
		const left = findRemainingPhoneSnippets(probeText, phoneList, planByNumero);
		for (const L of left) {
			uncovered.push({ arquivo: target.arquivo, ...L });
		}
	}

	await writeCsv(
		OUT_TELEFONE_V2,
		['arquivo', 'numero_original', 'variacao', 'campo', 'ocorrencias'],
		report,
	);

	console.log(`Arquivos com substituição: ${filesChanged}`);
	console.log(`Ocorrências substituídas:  ${totalHits}`);
	console.log(`CSV: ${path.relative(ROOT, OUT_TELEFONE_V2)}`);

	// Dedup uncovered por numero+variacao+trecho
	const seenUnc = new Set();
	const uncoveredUnique = [];
	for (const u of uncovered) {
		const key = `${u.numero}||${u.variacao}||${u.trecho}`;
		if (seenUnc.has(key)) continue;
		seenUnc.add(key);
		uncoveredUnique.push(u);
	}

	console.log(`\n=== Verificação pós-substituição (lista dos ${phoneList.length}) ===`);
	if (uncoveredUnique.length === 0) {
		console.log('✓ ZERO ocorrências relevantes restantes nos arquivos-alvo após o apply simulado.');
	} else {
		console.log(
			`⚠ ATENÇÃO: ${uncoveredUnique.length} ocorrência(s) de variação não coberta (ou remanescente):\n`,
		);
		for (const u of uncoveredUnique.slice(0, 40)) {
			console.log('ATENÇÃO: variação não coberta');
			console.log(`  numero lista: ${u.numero}`);
			console.log(`  variacao:     ${u.variacao}`);
			console.log(`  arquivo:      ${u.arquivo}`);
			console.log(`  trecho:       ${u.trecho}`);
			console.log('');
		}
		if (uncoveredUnique.length > 40) {
			console.log(`  … +${uncoveredUnique.length - 40} outras`);
		}
	}

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
