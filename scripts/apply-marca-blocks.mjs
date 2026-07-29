/**
 * Aplica blocos de texto Cupim Eco nos padrões de marca errada (Universo etc.).
 *
 * Uso:
 *   node scripts/apply-marca-blocks.mjs          # dry-run (padrão)
 *   node scripts/apply-marca-blocks.mjs --apply  # grava + git add
 *
 * Entradas:
 *   scripts/.tmp-padroes-marca.csv
 *   scripts/.tmp-audit-cidades.csv  (cidade_detectada)
 *
 * Saídas:
 *   scripts/.tmp-marca-diff.txt
 *   scripts/.tmp-marca-nao-aplicado.csv
 *
 * Guardrails: git working tree limpo obrigatório; --apply explícito.
 */
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const PADROES_CSV = path.join(ROOT, 'scripts', '.tmp-padroes-marca.csv');
const AUDIT_CSV = path.join(ROOT, 'scripts', '.tmp-audit-cidades.csv');
const OUT_DIFF = path.join(ROOT, 'scripts', '.tmp-marca-diff.txt');
const OUT_NAO = path.join(ROOT, 'scripts', '.tmp-marca-nao-aplicado.csv');

/** Associação pedida pelo usuário (1-based no CSV por frequência). */
const USER_RANK_MAP = {
	A: [1, 7],
	B: [2, 3],
	C: [4],
	D: [5],
	E: [6],
	F: [8],
	G: [9, 10],
	H: [11],
	I: [12],
};

/**
 * Fingerprints do texto ANTIGO (padrão), porque a ordenação #1… do CSV
 * por frequência NÃO bate com A=legalizada / B=fossa etc.
 * Ex.: no CSV atual #1=fossa e #4=LEGALIZADA.
 */
const BLOCK_FINGERPRINT = {
	A: /100%\s*LEGALIZADA|DEDETIZADORA\s+100%\s*LEGALIZADA/i,
	B: /(?:limpeza\s+de\s+fossa|limpa\s+fossa|fossa)\s+[ée]\s+um\s+servi[cç]o\s+preventivo/i,
	C: /(?:disp[oõ]e\s+de\s+uma\s+equipe\s+t[ée]cnica\s+altamente\s+especializada|Fundada\s+em\s+2004,\s+a\s+Universo)/i,
	D: /pre[cç]o\s+acess[ií]vel/i,
	E: /moradores\s+de\s+\{CIDADE\}/i,
	F: /principais\s+diferenciais/i,
	G: /(?:marimbondos|(?:per)?nilongos|caramujos).{0,120}(?:Universo|pragas\s+urbanas)/i,
	H: /CLIENTES\s+QUE\s+ATENDEMOS/i,
	I: /empresa\s+especializada\s+em\s+controle\s+de\s+pragas\s+urbanas/i,
};

/** Texto novo por bloco (com {CIDADE} onde aplicável). */
const BLOCK_TEXT = {
	A: 'A Cupim Eco é uma dedetizadora 100% legalizada. Ao contratar nossos serviços, você pode ficar totalmente tranquilo quanto à procedência dos produtos utilizados e à qualificação da nossa equipe técnica.',
	B: 'A limpeza de fossa é um serviço preventivo, essencial para evitar problemas futuros de saturação e mau funcionamento do sistema. A Cupim Eco realiza esse serviço com equipe especializada e equipamentos adequados.',
	C: 'Há mais de 30 anos no mercado de controle de pragas e desentupimento, a Cupim Eco conta com uma equipe técnica altamente especializada, seguindo padrões rígidos de segurança e qualidade em todos os atendimentos.',
	D: 'Com preço acessível e total comprometimento, a Cupim Eco trabalha com qualidade na execução e prestação de todos os seus serviços.',
	E: 'Para os moradores de {CIDADE}, a Cupim Eco conta com uma equipe capacitada e treinada, pronta para eliminar o problema com eficiência e segurança.',
	F: 'A qualidade, o comprometimento e a eficácia dos serviços são certamente alguns dos principais diferenciais da Cupim Eco.',
	G: 'A Cupim Eco atende ao controle de cupins, pulgas, carrapatos, marimbondos, escorpiões, baratas, formigas, pernilongos, morcegos, caramujos, ratos, pombos e outras pragas urbanas, com soluções seguras e eficazes.',
	H: 'Clientes que atendemos: a Cupim Eco tem o orgulho de oferecer soluções de controle de pragas personalizadas para residências, empresas, condomínios e órgãos públicos.',
	I: 'A Cupim Eco é uma empresa especializada em controle de pragas urbanas, desenvolvendo soluções eficientes para cada tipo de necessidade.',
};

const FIELD_KEYS = ['content', 'excerpt', 'title'];
const SEO_KEYS = ['title', 'description'];

function parseArgs(argv) {
	return { apply: argv.includes('--apply') };
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
	if (process.env.NORMALIZE_ALLOW_DIRTY === '1') {
		console.log('⚠ NORMALIZE_ALLOW_DIRTY=1 — pulando checagem de working tree limpo\n');
		return;
	}
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

function csvEscape(value) {
	const str = String(value ?? '');
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

/** Parser CSV com campos entre aspas (vírgulas internas). */
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
	if (rows.length === 0) return [];
	const headers = rows[0].map((h) => String(h).trim());
	return rows
		.slice(1)
		.filter((r) => r.some((x) => String(x ?? '').trim()))
		.map((cols) => {
			/** @type {Record<string, string>} */
			const o = {};
			headers.forEach((h, i) => {
				o[h] = cols[i] ?? '';
			});
			return o;
		});
}

function escapeRegExp(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function decodeHtmlEntity(entity) {
	const named = {
		'&nbsp;': ' ',
		'&amp;': '&',
		'&quot;': '"',
		'&apos;': "'",
		'&lt;': '<',
		'&gt;': '>',
		'&aacute;': 'á',
		'&Aacute;': 'Á',
		'&eacute;': 'é',
		'&Eacute;': 'É',
		'&iacute;': 'í',
		'&Iacute;': 'Í',
		'&oacute;': 'ó',
		'&Oacute;': 'Ó',
		'&uacute;': 'ú',
		'&Uacute;': 'Ú',
		'&atilde;': 'ã',
		'&Atilde;': 'Ã',
		'&otilde;': 'õ',
		'&Otilde;': 'Õ',
		'&ccedil;': 'ç',
		'&Ccedil;': 'Ç',
		'&agrave;': 'à',
		'&Agrave;': 'À',
		'&acirc;': 'â',
		'&Acirc;': 'Â',
		'&ecirc;': 'ê',
		'&Ecirc;': 'Ê',
		'&ocirc;': 'ô',
		'&Ocirc;': 'Ô',
	};
	const lower = entity.toLowerCase();
	for (const [k, v] of Object.entries(named)) {
		if (k.toLowerCase() === lower) return v;
	}
	const num = entity.match(/^&#(\d+);$/);
	if (num) return String.fromCharCode(Number(num[1]));
	const hex = entity.match(/^&#x([0-9a-f]+);$/i);
	if (hex) return String.fromCharCode(parseInt(hex[1], 16));
	return ' ';
}

/**
 * Mapa plainIndex → htmlIndex (somente chars “visíveis”).
 * Tags HTML são puladas; entidades viram o caractere correspondente.
 */
function buildPlainIndexMap(html) {
	const plainChars = [];
	const htmlIndexOfPlain = [];
	let i = 0;
	const s = String(html ?? '');
	while (i < s.length) {
		if (s[i] === '<') {
			const close = s.indexOf('>', i + 1);
			if (close === -1) break;
			i = close + 1;
			continue;
		}
		if (s[i] === '&') {
			const semi = s.indexOf(';', i + 1);
			if (semi !== -1 && semi - i < 12) {
				const decoded = decodeHtmlEntity(s.slice(i, semi + 1));
				for (const ch of decoded) {
					plainChars.push(ch);
					htmlIndexOfPlain.push(i);
				}
				i = semi + 1;
				continue;
			}
		}
		plainChars.push(s[i]);
		htmlIndexOfPlain.push(i);
		i += 1;
	}
	return {
		plain: plainChars.join(''),
		htmlIndexOfPlain,
	};
}

function collapseWs(s) {
	return String(s ?? '')
		.replace(/\r\n|\r|\n/g, ' ')
		.replace(/\\n/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Remove detritos de HTML cortado no meio no início/fim do padrão. */
function cleanPatternDebris(padrao) {
	let s = collapseWs(padrao);
	s = s.replace(/^(?:[a-z0-9#;"'=%:\s.\\\/_-]{0,50}>)/i, '');
	s = s.replace(/^(?:\/?(?:strong|span|p|h\d|div|em|b|i)>)+/i, '');
	s = s.replace(/^(?:rong>|trong>|strong>|span>|p>)/i, '');
	s = s.replace(/<\/?[a-z][^>]*>/gi, ' ');
	s = collapseWs(s);
	// Início truncado no meio da palavra: "alidade, o comprometimento" / "atos, marimbondos"
	s = s.replace(/^[a-zà-ú]{1,16}(?:,|\s)+/iu, '');
	// corta token truncado no final (ex.: "mercado, pos")
	s = s.replace(/\s+[A-Za-zÀ-ú]{1,3}$/u, '');
	return s.trim();
}

/**
 * Núcleo buscável: preferir padrão limpo; se curto, cair no exemplo_real limpo.
 * Para padrões muito longos/truncados, usa janela estável no meio (âncora).
 */
function searchableCore(padrao, exemplo) {
	let core = cleanPatternDebris(padrao);
	if (core.length < 40) {
		core = cleanPatternDebris(String(exemplo ?? '').replace(/\\n/g, ' '));
	}
	// Âncoras mais estáveis quando o trecho do CSV começa/termina cortado
	const anchors = [
		/comprometimento e a efic[aá]cia dos servi[cç]os[\s\S]{0,80}?principais diferenciais da Universo/i,
		/CLIENTES QUE ATENDEMOS[\s\S]{0,120}?Universo tem o orgulho/i,
		/empresa especializada em controle de pragas urbanas[\s\S]{0,80}?Universo desenvolve/i,
		/100%\s*LEGALIZADA[\s\S]{0,160}?contratando a Universo/i,
	];
	for (const re of anchors) {
		const m = core.match(re) || String(exemplo ?? '').match(re);
		if (m && m[0].length >= 36) return collapseWs(m[0]);
	}
	return core;
}

/**
 * Regex flexível a partir do padrão limpo ({CIDADE} → qualquer topônimo curto).
 */
function patternToSearchRegex(cleanedPattern) {
	const core = cleanPatternDebris(cleanedPattern);
	if (core.length < 36) return null;

	const parts = core.split('{CIDADE}');
	const body = parts
		.map((p) =>
			escapeRegExp(p)
				.replace(/\\ /g, '\\s+')
				.replace(/\s+/g, '\\s+'),
		)
		.join('.{2,48}?');

	try {
		return new RegExp(body, 'iu');
	} catch {
		return null;
	}
}

/**
 * Localiza match no HTML via texto visível; estende até fim de frase se o
 * padrão estiver truncado. Retorna índices HTML [start, end) ou null.
 */
function findVisibleSpanInHtml(html, cleanedPattern) {
	const re = patternToSearchRegex(cleanedPattern);
	if (!re) return null;

	const { plain, htmlIndexOfPlain } = buildPlainIndexMap(html);
	re.lastIndex = 0;
	const match = re.exec(plain);
	if (!match || match.index == null) return null;

	let plainStart = match.index;
	let plainEnd = match.index + match[0].length;

	// Expande adiante até pontuação de frase se o padrão parece truncado
	const looksTruncated = !/[.!?…]"?$/.test(match[0].trim());
	if (looksTruncated) {
		const ahead = plain.slice(plainEnd, plainEnd + 420);
		const stop = ahead.search(/[.!?…](?:\s|$)/);
		if (stop >= 0) plainEnd += stop + 1;
	}

	// Expande atrás se começa minúsculo (corte no meio)
	if (/^[\s,;:a-zà-ú]/.test(match[0]) && plainStart > 0) {
		const before = plain.slice(Math.max(0, plainStart - 220), plainStart);
		const lastStop = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '));
		if (lastStop >= 0) {
			plainStart = plainStart - (before.length - lastStop - 2);
		}
	}

	plainStart = Math.max(0, Math.min(plainStart, htmlIndexOfPlain.length - 1));
	plainEnd = Math.max(plainStart + 1, Math.min(plainEnd, htmlIndexOfPlain.length));

	const htmlStart = htmlIndexOfPlain[plainStart];
	const lastPlain = Math.min(plainEnd - 1, htmlIndexOfPlain.length - 1);
	const htmlEnd = htmlIndexOfPlain[lastPlain] + 1;

	if (htmlStart == null || htmlEnd == null || htmlEnd <= htmlStart) return null;

	return {
		htmlStart,
		htmlEnd,
		matchedPlain: plain.slice(plainStart, plainEnd),
	};
}

function resolveNewText(blockId, cidade) {
	const raw = BLOCK_TEXT[blockId] ?? '';
	const city = String(cidade || '').trim() || 'São Paulo';
	return raw.replaceAll('{CIDADE}', city);
}

/**
 * Associa padrões do CSV a blocos A–I (rank pedido + fingerprint semântico).
 * @param {Record<string, string>[]} padroes
 */
function assignPatternsToBlocks(padroes) {
	/** @type {Map<string, { blockId: string, rank: number, padrao: string, arquivos: string[], exemplo: string }[]>} */
	const byBlock = new Map(Object.keys(BLOCK_TEXT).map((id) => [id, []]));
	/** @type {Set<number>} */
	const usedRanks = new Set();
	const notes = [];

	function push(blockId, rank, row) {
		if (usedRanks.has(rank)) return;
		usedRanks.add(rank);
		byBlock.get(blockId).push({
			blockId,
			rank,
			padrao: String(row.padrao_normalizado ?? ''),
			arquivos: String(row.arquivos ?? '')
				.split('|')
				.map((s) => s.trim())
				.filter(Boolean),
			exemplo: String(row.exemplo_real ?? ''),
		});
	}

	// 1) ranks pedidos — só se o fingerprint bater
	for (const [blockId, ranks] of Object.entries(USER_RANK_MAP)) {
		const fp = BLOCK_FINGERPRINT[blockId];
		for (const rank of ranks) {
			const row = padroes[rank - 1];
			if (!row) {
				notes.push(`BLOCO_${blockId}: rank #${rank} inexistente no CSV`);
				continue;
			}
			const padrao = String(row.padrao_normalizado ?? '');
			if (fp.test(padrao)) {
				push(blockId, rank, row);
			} else {
				notes.push(
					`BLOCO_${blockId}: pedido #${rank} NÃO bate fingerprint ` +
						`(prévia: "${padrao.slice(0, 70)}…") — usando scan semântico`,
				);
			}
		}
	}

	// 2) completa com fingerprints nos top 25 (cobre variantes #5/#6 fossa, #4/#10 legalizada…)
	const TOP = Math.min(25, padroes.length);
	for (let i = 0; i < TOP; i++) {
		const rank = i + 1;
		if (usedRanks.has(rank)) continue;
		const row = padroes[i];
		const padrao = String(row.padrao_normalizado ?? '');
		for (const [blockId, fp] of Object.entries(BLOCK_FINGERPRINT)) {
			if (fp.test(padrao)) {
				push(blockId, rank, row);
				notes.push(`BLOCO_${blockId}: +padrão #${rank} via fingerprint`);
				break;
			}
		}
	}

	return { byBlock, notes };
}

async function loadCidadeByArquivo() {
	/** @type {Map<string, string>} */
	const map = new Map();
	if (!(await pathExists(AUDIT_CSV))) return map;
	const rows = parseCsv(await readFile(AUDIT_CSV, 'utf8'));
	for (const row of rows) {
		const arq = String(row.arquivo ?? '').replace(/\\/g, '/');
		if (!arq) continue;
		map.set(arq, String(row.cidade_detectada ?? '').trim());
	}
	return map;
}

function collectFieldRefs(data) {
	/** @type {{ path: string, get: () => string, set: (v: string) => void }[]} */
	const refs = [];
	for (const key of FIELD_KEYS) {
		if (typeof data[key] === 'string' && data[key]) {
			refs.push({
				path: key,
				get: () => data[key],
				set: (v) => {
					data[key] = v;
				},
			});
		}
	}
	if (data.seo && typeof data.seo === 'object') {
		for (const key of SEO_KEYS) {
			if (typeof data.seo[key] === 'string' && data.seo[key]) {
				refs.push({
					path: `seo.${key}`,
					get: () => data.seo[key],
					set: (v) => {
						data.seo[key] = v;
					},
				});
			}
		}
	}
	return refs;
}

async function main() {
	const { apply } = parseArgs(process.argv.slice(2));
	assertCleanGit();

	if (!(await pathExists(PADROES_CSV))) {
		console.error(
			`❌ Não encontrei ${path.relative(ROOT, PADROES_CSV)}.\n` +
				`   Rode antes: npm run normalize:marca-padroes`,
		);
		process.exit(1);
	}

	const padroes = parseCsv(await readFile(PADROES_CSV, 'utf8'));
	const cidadeByArquivo = await loadCidadeByArquivo();
	const { byBlock, notes } = assignPatternsToBlocks(padroes);

	console.log(`Modo: ${apply ? '--apply (grava + git add)' : 'dry-run (só diff/CSV)'}\n`);
	console.log('Associação bloco → padrões (# por frequência no CSV):');
	for (const [blockId, items] of byBlock) {
		const ranks = items.map((x) => `#${x.rank}`).join(', ') || '(nenhum)';
		const nFiles = new Set(items.flatMap((x) => x.arquivos)).size;
		console.log(`  BLOCO_${blockId}: ${ranks}  (${nFiles} arquivos únicos listados)`);
	}
	if (notes.length) {
		console.log('\nNotas de mapeamento:');
		for (const n of notes.slice(0, 30)) console.log(`  · ${n}`);
		if (notes.length > 30) console.log(`  · … +${notes.length - 30}`);
	}
	console.log('');

	/** @type {string[]} */
	const diffLines = [];
	/** @type {{ arquivo: string, bloco: string, padrao_rank: string, motivo: string }[]} */
	const naoAplicado = [];
	/** @type {Map<string, number>} */
	const wouldChangeByBlock = new Map(Object.keys(BLOCK_TEXT).map((k) => [k, 0]));
	/** @type {Set<string>} */
	const filesWouldChange = new Set();
	let filesWritten = 0;

	// Dedup: mesmo arquivo + mesmo trecho HTML não aplica 2×
	/** @type {Map<string, { data: any, abs: string, changed: boolean, diffs: string[] }>} */
	const fileState = new Map();

	for (const [blockId, items] of byBlock) {
		for (const item of items) {
			for (const arquivo of item.arquivos) {
				const rel = arquivo.replace(/\\/g, '/');
				const abs = path.join(ROOT, rel);
				if (!(await pathExists(abs))) {
					naoAplicado.push({
						arquivo: rel,
						bloco: blockId,
						padrao_rank: String(item.rank),
						motivo: 'arquivo_nao_encontrado',
					});
					continue;
				}

				let state = fileState.get(rel);
				if (!state) {
					const raw = await readFile(abs, 'utf8');
					let data;
					try {
						data = JSON.parse(raw);
					} catch {
						naoAplicado.push({
							arquivo: rel,
							bloco: blockId,
							padrao_rank: String(item.rank),
							motivo: 'json_invalido',
						});
						continue;
					}
					state = { data, abs, changed: false, diffs: [] };
					fileState.set(rel, state);
				}

				const cidade = cidadeByArquivo.get(rel) || '';
				const newText = resolveNewText(blockId, cidade);
				const cleaned = searchableCore(item.padrao, item.exemplo);
				const refs = collectFieldRefs(state.data);

				let applied = false;
				let lastReason = 'trecho_nao_encontrado';

				for (const ref of refs) {
					const html = ref.get();
					const found = findVisibleSpanInHtml(html, cleaned);
					if (!found) continue;

					const before = found.matchedPlain;
					const after = newText;
					const nextHtml =
						html.slice(0, found.htmlStart) + after + html.slice(found.htmlEnd);

					if (nextHtml === html) {
						lastReason = 'sem_mudanca';
						continue;
					}

					ref.set(nextHtml);
					state.changed = true;
					applied = true;

					const diffEntry =
						`--- ${rel} | BLOCO_${blockId} | padrão #${item.rank} | campo ${ref.path}\n` +
						`ANTES (${Math.min(200, before.length)}): ${before.slice(0, 200)}\n` +
						`DEPOIS (${Math.min(200, after.length)}): ${after.slice(0, 200)}\n`;
					state.diffs.push(diffEntry);
					break; // um replace por padrão/arquivo
				}

				if (!applied) {
					naoAplicado.push({
						arquivo: rel,
						bloco: blockId,
						padrao_rank: String(item.rank),
						motivo: lastReason,
					});
				}
			}
		}
	}

	// Contabiliza e grava
	for (const [rel, state] of fileState) {
		if (!state.changed) continue;
		filesWouldChange.add(rel);
		for (const d of state.diffs) {
			const m = d.match(/BLOCO_([A-I])/);
			if (m) wouldChangeByBlock.set(m[1], (wouldChangeByBlock.get(m[1]) ?? 0) + 1);
			diffLines.push(d);
		}

		if (apply) {
			const out = `${JSON.stringify(state.data, null, 2)}\n`;
			await writeFile(state.abs, out, 'utf8');
			gitAdd(rel);
			filesWritten += 1;
		}
	}

	await mkdir(path.dirname(OUT_DIFF), { recursive: true });
	await writeFile(
		OUT_DIFF,
		diffLines.length
			? `${diffLines.join('\n')}\n`
			: '(nenhuma substituição candidata)\n',
		'utf8',
	);

	const naoHeader = ['arquivo', 'bloco', 'padrao_rank', 'motivo'];
	const naoCsv = [
		naoHeader.join(','),
		...naoAplicado.map((r) => naoHeader.map((h) => csvEscape(r[h])).join(',')),
	];
	await writeFile(OUT_NAO, `${naoCsv.join('\n')}\n`, 'utf8');

	console.log('=== Resumo ===\n');
	console.log(`Arquivos únicos que ${apply ? 'foram' : 'seriam'} alterados: ${filesWouldChange.size}`);
	console.log('Por bloco (ocorrências aplicadas/candidatas):');
	for (const id of Object.keys(BLOCK_TEXT)) {
		console.log(`  BLOCO_${id}: ${wouldChangeByBlock.get(id) ?? 0}`);
	}
	console.log(`Não aplicados: ${naoAplicado.length}  → ${path.relative(ROOT, OUT_NAO)}`);
	console.log(`Diff: ${path.relative(ROOT, OUT_DIFF)}`);
	if (apply) {
		console.log(`\n✓ Gravados e staged (git add): ${filesWritten}. Sem commit.`);
	} else {
		console.log('\nDry-run: nenhum arquivo de conteúdo alterado. Use --apply para gravar.');
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
