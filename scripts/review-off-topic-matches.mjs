/**
 * Revisão visual de matches off-topic (contexto ao redor dos termos).
 *
 * Lê off-topic-content-report.csv; para cada linha com tem_noindex=false,
 * abre o arquivo de origem e extrai ~15 palavras antes/depois de cada
 * ocorrência dos termos em termos_matched.
 *
 * Uso:
 *   node scripts/review-off-topic-matches.mjs
 *
 * Saída: off-topic-context-review.md (somente leitura dos fontes / CSV).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const CSV_IN = path.join(ROOT, 'off-topic-content-report.csv');
const MD_OUT = path.join(ROOT, 'off-topic-context-review.md');

const CONTEXT_WORDS = 15;
/** Limite de snippets por termo por arquivo (evita MD gigante). */
const MAX_SNIPPETS_PER_TERM = 8;

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

function rowsToObjects(matrix) {
	if (matrix.length === 0) return [];
	const headers = matrix[0].map((h) => String(h).trim());
	return matrix.slice(1).map((cells) => {
		const obj = {};
		for (let i = 0; i < headers.length; i++) obj[headers[i]] = cells[i] ?? '';
		return obj;
	});
}

function normalizeForMatch(text) {
	return String(text ?? '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/['’`]/g, '');
}

function stripHtml(html) {
	return String(html ?? '')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Carrega texto pesquisável do arquivo (título + corpo + path/slug).
 * @returns {Promise<{ plain: string, sourceNote: string }>}
 */
async function loadSearchableText(relPath) {
	const abs = path.join(ROOT, relPath);
	const ext = path.extname(abs).toLowerCase();

	try {
		const raw = await readFile(abs, 'utf8');

		if (ext === '.json') {
			const data = JSON.parse(raw);
			const parts = [
				data.title,
				data.seoTitle,
				data.seo?.title,
				data.excerpt,
				data.content,
				data.path,
				data.slug,
			]
				.filter(Boolean)
				.map((p) => (typeof p === 'string' && p.includes('<') ? stripHtml(p) : String(p)));
			return {
				plain: parts.join(' \n '),
				sourceNote: 'wp-json (title/excerpt/content/path)',
			};
		}

		// .astro / .md / .mdx — remove frontmatter e tags simples
		const withoutFm = raw.replace(/^---[\s\S]*?---\s*/, '');
		return {
			plain: stripHtml(withoutFm),
			sourceNote: ext.slice(1) || 'text',
		};
	} catch (err) {
		return {
			plain: '',
			sourceNote: `erro ao ler: ${err?.message || err}`,
		};
	}
}

/**
 * Encontra ocorrências do termo no texto (match normalizado) e devolve
 * snippets com ~CONTEXT_WORDS palavras antes/depois no texto original.
 */
function findTermContexts(plainText, term) {
	const needle = normalizeForMatch(term);
	if (!needle || !plainText) return [];

	const words = plainText.split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];

	/** Índices de palavra onde o termo começa (pode cruzar palavras: "caixa de água"). */
	const snippets = [];
	const needleWords = needle.split(/\s+/).filter(Boolean);
	const needleCompact = needle.replace(/[\s-]+/g, '');

	for (let i = 0; i < words.length; i++) {
		if (snippets.length >= MAX_SNIPPETS_PER_TERM) break;

		let matched = false;
		let matchSpan = 1;

		// 1) termo multi-palavra alinhado a tokens consecutivos
		if (needleWords.length > 1) {
			const slice = words.slice(i, i + needleWords.length);
			if (slice.length === needleWords.length) {
				const joined = normalizeForMatch(slice.join(' '));
				if (joined === normalizeForMatch(needleWords.join(' '))) {
					matched = true;
					matchSpan = needleWords.length;
				}
			}
		}

		// 2) termo (possivelmente com hífen) contido numa palavra
		if (!matched) {
			const wNorm = normalizeForMatch(words[i]);
			if (wNorm.includes(needle) || wNorm.replace(/-/g, '').includes(needleCompact)) {
				matched = true;
				matchSpan = 1;
			}
		}

		// 3) janela compacta só para termos compostos (espaço/hífen), ex.: "caixa d'água"
		const isCompound = needleWords.length > 1 || needle.includes('-');
		if (!matched && isCompound && needleCompact.length >= 4) {
			for (let span = 2; span <= 4; span++) {
				const slice = words.slice(i, i + span);
				if (slice.length < span) break;
				const compact = normalizeForMatch(slice.join(' ')).replace(/[\s-]+/g, '');
				if (compact === needleCompact || compact.includes(needleCompact)) {
					matched = true;
					matchSpan = span;
					break;
				}
			}
		}

		if (!matched) continue;

		const start = Math.max(0, i - CONTEXT_WORDS);
		const end = Math.min(words.length, i + matchSpan + CONTEXT_WORDS);
		const before = words.slice(start, i).join(' ');
		const hit = words.slice(i, i + matchSpan).join(' ');
		const after = words.slice(i + matchSpan, end).join(' ');

		const snippet = [
			start > 0 ? '…' : '',
			before,
			`**${hit}**`,
			after,
			end < words.length ? '…' : '',
		]
			.filter(Boolean)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();

		snippets.push(snippet);
		i += matchSpan - 1;
	}

	return snippets;
}

function mdEscapeTitle(text) {
	return String(text ?? '').replace(/\r?\n/g, ' ').trim();
}

async function main() {
	const matrix = parseCsv(await readFile(CSV_IN, 'utf8'));
	const rows = rowsToObjects(matrix).filter(
		(r) => String(r.tem_noindex).trim().toLowerCase() === 'false',
	);

	console.log(
		`review-off-topic-matches — ${rows.length} arquivo(s) com tem_noindex=false\n`,
	);

	const md = [];
	md.push('# Revisão de contexto — conteúdo off-topic');
	md.push('');
	md.push(
		`Gerado por \`scripts/review-off-topic-matches.mjs\`. Somente leitura. Contexto: ~${CONTEXT_WORDS} palavras antes/depois de cada termo.`,
	);
	md.push('');
	md.push(`Arquivos sem noindex: **${rows.length}**`);
	md.push('');

	let filesWithSnippets = 0;
	let filesWithoutBodyHit = 0;
	let totalSnippets = 0;

	for (const row of rows) {
		const arquivo = String(row.arquivo || '').trim();
		const titulo = mdEscapeTitle(row.titulo);
		const termos = String(row.termos_matched || '')
			.split('|')
			.map((t) => t.trim())
			.filter(Boolean);

		const { plain, sourceNote } = await loadSearchableText(arquivo);

		console.log('─'.repeat(72));
		console.log(`arquivo: ${arquivo}`);
		console.log(`titulo:  ${titulo || '(sem título)'}`);
		console.log(`termos:  ${termos.join(' | ')}`);
		console.log(`fonte:   ${sourceNote}`);

		md.push(`## \`${arquivo}\``);
		md.push('');
		md.push(`- **Título:** ${titulo || '*(sem título)*'}`);
		md.push(`- **URL:** \`${row.url_path || ''}\``);
		md.push(`- **Termos:** ${termos.map((t) => `\`${t}\``).join(', ')}`);
		md.push(`- **Fonte do texto:** ${sourceNote}`);
		md.push('');

		let fileHadSnippet = false;

		for (const term of termos) {
			const contexts = findTermContexts(plain, term);
			console.log(`  [${term}] ${contexts.length} ocorrência(s) no corpo/metadados`);

			md.push(`### Termo: \`${term}\``);
			md.push('');

			if (contexts.length === 0) {
				md.push(
					'_Nenhuma ocorrência no corpo/metadados carregados — match pode ter vindo só do path/slug/nome do arquivo._',
				);
				md.push('');
				console.log('    (sem trecho no corpo — provável match só no path/slug)');
				continue;
			}

			fileHadSnippet = true;
			for (const [idx, snippet] of contexts.entries()) {
				totalSnippets++;
				console.log(`    ${idx + 1}. ${snippet.replace(/\*\*/g, '')}`);
				md.push(`${idx + 1}. ${snippet}`);
				md.push('');
			}
		}

		if (fileHadSnippet) filesWithSnippets++;
		else filesWithoutBodyHit++;

		md.push('---');
		md.push('');
	}

	await writeFile(MD_OUT, `${md.join('\n')}\n`, 'utf8');

	console.log('\n' + '─'.repeat(72));
	console.log(`Exportado: ${path.relative(ROOT, MD_OUT)}`);
	console.log(`  arquivos: ${rows.length}`);
	console.log(`  com trecho no corpo: ${filesWithSnippets}`);
	console.log(`  só path/slug (sem trecho): ${filesWithoutBodyHit}`);
	console.log(`  snippets totais: ${totalSnippets}`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
