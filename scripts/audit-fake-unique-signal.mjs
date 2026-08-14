/**
 * Audita falso-positivos de tem_conteudo_unico causados pelo sinal "bairro"
 * (frase de template: "no bairro ou seja todo que tem cupins…").
 *
 * Não altera scripts originais, CSV de audit nem policies.
 *
 * Uso:
 *   node scripts/audit-fake-unique-signal.mjs
 *
 * Saída: fake-unique-signal-report.csv
 */
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import cidadesGsp from '../src/data/cidades-gsp.json' with { type: 'json' };

const ROOT = path.resolve('.');
const AUDIT_CSV = path.join(ROOT, 'city-pages-audit.csv');
const OUT_CSV = path.join(ROOT, 'fake-unique-signal-report.csv');
const WP_PAGES = path.join(ROOT, 'src', 'data', 'wp', 'pages');
const WP_POSTS = path.join(ROOT, 'src', 'data', 'wp', 'posts');
const SRC_PAGES = path.join(ROOT, 'src', 'pages');
const SRC_CONTENT = path.join(ROOT, 'src', 'content');

/** Mesma heurística de audit-city-landing-quality.mjs */
const OFFICIAL_PHONE_DIGITS = '08001117272';
const PHONE_RE =
	/(?:0800[\s.\-]?\d{3}[\s.\-]?\d{4})|(?:\(\d{2}\)\s*\d{4,5}[\s.\-]?\d{4})|(?:\+?55[\s.\-]?\(?\d{2}\)?[\s.\-]?\d{4,5}[\s.\-]?\d{4})/gi;
const PRICE_AMOUNT_RE =
	/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*(?:\/\s*(?:m2|m²|visita|ponto))?|\b\d{2,4}\s*reais\b/gi;
const TESTIMONIAL_RE =
	/\b(?:depoimento\s+d[eo]|cliente\s+[A-ZÀ-Ú][a-zà-ú]{2,}\s*:|avaliou[- ]nos|"[^"]{25,100}"\s*[-—–]\s*[A-ZÀ-Ú][a-zà-ú]+)/gi;
const BAIRRO_HINT_RE =
	/\b(?:no\s+bairro\s+[A-ZÀ-Ú][A-Za-zÀ-ú\s]{2,40}|bairro\s+[A-ZÀ-Ú][A-Za-zÀ-ú\s]{2,30}\s+em\s+)/gi;

/**
 * Frase-template (e variações) que a regex de bairro captura por engano.
 * Ex.: "no bairro ou seja todo que tem cupins não tem valor"
 * (vírgula opcional; flag i faz [A-Z] da BAIRRO_HINT_RE casar em "ou".)
 */
const TEMPLATE_BAIRRO_RE =
	/\bno\s+bairro\s*,?\s*ou\s+seja\b[\s\S]{0,120}?(?:cupins?|valor|pre[cç]o|tem\s+valor)/i;
const TEMPLATE_SNIPPET_RE = /\bno\s+bairro\s*,?\s*ou\s+seja\b/i;

async function pathExists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
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
	if (cell.length || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

function csvEscape(value) {
	const str = String(value ?? '');
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

function normalizePathKey(raw) {
	let s = String(raw ?? '').trim();
	if (!s) return '';
	try {
		if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
	} catch {
		/* keep */
	}
	return s
		.split(/[?#]/)[0]
		.replace(/^\/+|\/+$/g, '')
		.toLowerCase();
}

function slugify(value = '') {
	return String(value)
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function stripHtml(html) {
	let s = String(html ?? '');
	s = s.replace(/<(header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
	s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
	s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
	s = s.replace(/<!--[\s\S]*?-->/g, ' ');
	s = s.replace(/<[^>]+>/g, ' ');
	s = s
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&#8211;/g, '–')
		.replace(/&#8212;/g, '—')
		.replace(/&[a-z#0-9]+;/gi, ' ');
	return s.replace(/\s+/g, ' ').trim();
}

function extractFrontmatterBody(raw) {
	const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!m) return { body: raw };
	return { body: m[2] };
}

/** Lista de bairros conhecidos (mesma fonte de area-atendida.ts). */
function buildKnownBairroNames() {
	/** @type {Map<string, string>} slug → nome original */
	const bySlug = new Map();
	for (const b of cidadesGsp.bairrosSaoPaulo ?? []) {
		const name = String(b).trim();
		if (!name) continue;
		bySlug.set(slugify(name), name);
		// também aceita espaços no texto
		bySlug.set(slugify(name.replace(/-/g, ' ')), name);
	}
	return bySlug;
}

const KNOWN_BAIRROS = buildKnownBairroNames();
/** Nomes capitalizados para match no texto (mais longos primeiro). */
const KNOWN_BAIRRO_DISPLAY = [...new Set(cidadesGsp.bairrosSaoPaulo ?? [])]
	.map((b) =>
		String(b)
			.split(/[-\s]+/)
			.map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ''))
			.join(' ')
			.trim(),
	)
	.filter((n) => n.length >= 3)
	.sort((a, b) => b.length - a.length);

async function walkFiles(dir, exts, acc = []) {
	if (!(await pathExists(dir))) return acc;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
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

async function buildPathIndex() {
	/** @type {Map<string, { kind: string, abs: string }>} */
	const index = new Map();

	async function indexWp(dir) {
		if (!(await pathExists(dir))) return;
		for (const name of await readdir(dir)) {
			if (!name.endsWith('.json')) continue;
			const abs = path.join(dir, name);
			let data;
			try {
				data = JSON.parse(await readFile(abs, 'utf8'));
			} catch {
				continue;
			}
			const key = normalizePathKey(data.path || data.slug || '');
			if (!key) continue;
			index.set(key, { kind: 'wp-json', abs });
		}
	}

	await indexWp(WP_PAGES);
	await indexWp(WP_POSTS);

	for (const abs of [
		...(await walkFiles(SRC_PAGES, new Set(['.astro', '.md', '.mdx']))),
		...(await walkFiles(SRC_CONTENT, new Set(['.md', '.mdx']))),
	]) {
		const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
		let key = '';
		if (rel.startsWith('src/pages/')) {
			key = rel
				.replace(/^src\/pages\//, '')
				.replace(/\.(astro|md|mdx)$/i, '')
				.replace(/\/index$/i, '');
		} else if (rel.startsWith('src/content/')) {
			key = rel.replace(/^src\/content\//, '').replace(/\.(md|mdx)$/i, '');
		}
		key = normalizePathKey(key);
		if (!key || index.has(key)) continue;
		index.set(key, {
			kind: path.extname(abs).toLowerCase() === '.astro' ? 'astro' : 'md',
			abs,
		});
	}

	return index;
}

async function loadPlain(hit) {
	const raw = await readFile(hit.abs, 'utf8');
	if (hit.kind === 'wp-json') {
		const data = JSON.parse(raw);
		return stripHtml([data.content, data.excerpt].filter(Boolean).join('\n'));
	}
	const { body } = extractFrontmatterBody(raw);
	return stripHtml(body);
}

function hasNonOfficialPhone(plain) {
	for (const m of plain.matchAll(PHONE_RE)) {
		const digits = m[0].replace(/\D/g, '');
		if (!digits) continue;
		if (digits.includes(OFFICIAL_PHONE_DIGITS) || digits.endsWith('8001117272')) continue;
		return true;
	}
	return false;
}

function hasPrice(plain) {
	PRICE_AMOUNT_RE.lastIndex = 0;
	return PRICE_AMOUNT_RE.test(plain);
}

function hasTestimonial(plain) {
	TESTIMONIAL_RE.lastIndex = 0;
	return TESTIMONIAL_RE.test(plain);
}

/**
 * Classifica matches de BAIRRO_HINT_RE: template vs bairro real.
 * Falso-positivo = há match de template (ou frase-template no texto) e
 * nenhum match de bairro real (nome da lista / capitalizado ≠ "Ou seja").
 * @returns {{ hasBairroHint: boolean, fakePositive: boolean, hasRealBairro: boolean }}
 */
function classifyBairroSignals(plain) {
	BAIRRO_HINT_RE.lastIndex = 0;
	const matches = [...plain.matchAll(BAIRRO_HINT_RE)].map((m) => m[0].trim());
	const hasTemplatePhrase = TEMPLATE_BAIRRO_RE.test(plain);

	let hasTemplateMatch = hasTemplatePhrase;
	/** @type {string[]} */
	const realSnippets = [];

	for (const snip of matches) {
		if (TEMPLATE_SNIPPET_RE.test(snip) || /bairro\s*,?\s*ou\s+seja/i.test(snip)) {
			hasTemplateMatch = true;
			continue;
		}

		// Nome conhecido da lista dentro do trecho do HINT
		let known = false;
		for (const display of KNOWN_BAIRRO_DISPLAY) {
			const re = new RegExp(
				`\\b${display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
				'i',
			);
			if (re.test(snip)) {
				known = true;
				realSnippets.push(snip);
				break;
			}
		}
		if (known) continue;

		// "no bairro Nome…" com Nome capitalizado, sem "ou seja"
		if (
			/\bno\s+bairro\s+[A-ZÀ-ÚÁÉÍÓÚÂÊÔÃÕÇ]/.test(snip) &&
			!/ou\s+seja/i.test(snip)
		) {
			realSnippets.push(snip);
			continue;
		}
		if (
			/\bbairro\s+[A-ZÀ-ÚÁÉÍÓÚÂÊÔÃÕÇ].*\sem\s+/i.test(snip) &&
			!/ou\s+seja/i.test(snip)
		) {
			realSnippets.push(snip);
		}
	}

	const hasBairroHint = matches.length > 0 || hasTemplatePhrase;
	const hasRealBairro = realSnippets.length > 0;
	// Coluna pedida: o sinal de bairro (quando existe) é o falso-positivo de template
	const fakePositive = hasTemplateMatch && !hasRealBairro;

	return {
		hasBairroHint,
		fakePositive,
		hasRealBairro,
	};
}

async function main() {
	console.log('audit-fake-unique-signal — somente relatório\n');

	const matrix = parseCsv(await readFile(AUDIT_CSV, 'utf8'));
	const headers = matrix[0].map((h) => String(h).trim());
	const col = Object.fromEntries(headers.map((h, i) => [h, i]));

	const allRows = matrix.slice(1).map((cells) => ({
		url: String(cells[col.url] ?? '').trim(),
		unico: String(cells[col.tem_conteudo_unico] ?? '').trim().toLowerCase() === 'true',
		decisao: String(cells[col.decisao_final] ?? '').trim(),
	}));

	const total = allRows.length;
	const uniqueRows = allRows.filter((r) => r.unico);
	console.log(`city-pages-audit.csv: ${total} linhas`);
	console.log(`tem_conteudo_unico=true: ${uniqueRows.length}`);
	console.log(`Bairros conhecidos (lista): ${KNOWN_BAIRRO_DISPLAY.length}\n`);

	const index = await buildPathIndex();
	console.log(`Índice de arquivos: ${index.size}\n`);

	/** @type {object[]} */
	const report = [];
	let missing = 0;
	let onlyFakeBairro = 0;
	let fakeBairroWithOther = 0;
	let realBairroOrOther = 0;

	for (const row of uniqueRows) {
		const hit = index.get(normalizePathKey(row.url));
		if (!hit) {
			missing += 1;
			report.push({
				url: row.url,
				decisao_final_atual: row.decisao || '',
				sinal_bairro_e_falso_positivo: '',
				tem_outro_sinal_real: '',
				nota: 'arquivo_nao_encontrado',
			});
			continue;
		}

		const plain = await loadPlain(hit);
		const bairro = classifyBairroSignals(plain);
		const outro =
			hasPrice(plain) || hasNonOfficialPhone(plain) || hasTestimonial(plain);

		const sinalFake = bairro.fakePositive;

		report.push({
			url: row.url,
			decisao_final_atual: row.decisao || '',
			sinal_bairro_e_falso_positivo: sinalFake ? 'true' : 'false',
			tem_outro_sinal_real: outro ? 'true' : 'false',
			nota: sinalFake
				? outro
					? 'fake_bairro+outro_sinal'
					: 'apenas_fake_bairro'
				: bairro.hasRealBairro
					? 'bairro_real'
					: outro
						? 'outro_sinal_sem_fake_bairro'
						: 'unico_sem_sinal_reclassificado',
		});

		if (sinalFake && !outro) {
			onlyFakeBairro += 1;
		} else if (sinalFake && outro) {
			fakeBairroWithOther += 1;
		} else {
			realBairroOrOther += 1;
		}
	}

	const outHeaders = [
		'url',
		'decisao_final_atual',
		'sinal_bairro_e_falso_positivo',
		'tem_outro_sinal_real',
	];
	const csv = [
		outHeaders.join(','),
		...report.map((r) => outHeaders.map((h) => csvEscape(r[h])).join(',')),
	].join('\n');
	await writeFile(OUT_CSV, `${csv}\n`, 'utf8');

	console.log(`→ ${path.relative(ROOT, OUT_CSV)} (${report.length} linhas)`);
	console.log(`Arquivo não encontrado: ${missing}`);
	console.log('');
	console.log('Resumo (entre tem_conteudo_unico=true):');
	console.log(`  apenas fake-bairro (candidatas a consolidar): ${onlyFakeBairro}`);
	console.log(`  fake-bairro + outro sinal real:               ${fakeBairroWithOther}`);
	console.log(`  bairro real e/ou outro sinal / resto:         ${realBairroOrOther}`);
	console.log('');
	console.log(
		`>>> Das ${total} páginas do audit, ${onlyFakeBairro} têm APENAS o sinal de bairro falso-positivo`,
	);
	console.log('    (tem_conteudo_unico=true, sem preço/telefone/depoimento reais).');
	console.log('Policies e city-pages-audit.csv NÃO alterados.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
