/**
 * Executa (ou simula) o plano em scripts/.tmp-plano-remocao.csv.
 *
 * Padrão: dry-run (não altera nada).
 * Mutação: node scripts/execute-removal-plan.mjs --apply
 *
 * Segurança: aborta se `git status --porcelain` não estiver vazio.
 */
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const PLAN_CSV = path.join(ROOT, 'scripts', '.tmp-plano-remocao.csv');
const ARCHIVE_DIR = path.join(ROOT, 'archive', 'removed-wp-pages');
const REDIRECTS_JSON = path.join(ROOT, 'scripts', 'redirects-cidades.json');
const WORDPRESS_TS = path.join(ROOT, 'src', 'lib', 'wordpress.ts');
const DESTINO_301 = '/descupinizacao/regioes/';

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
		const obj = {};
		headers.forEach((h, i) => {
			obj[h] = cells[i] ?? '';
		});
		return obj;
	});
}

function assertCleanGit() {
	const result = spawnSync('git', ['status', '--porcelain'], {
		cwd: ROOT,
		encoding: 'utf8',
	});

	if (result.status !== 0) {
		console.error('❌ Falha ao rodar `git status --porcelain`.');
		if (result.stderr) console.error(result.stderr);
		process.exit(1);
	}

	const dirty = (result.stdout || '').trim();
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
}

function classifyAction(acao) {
	const a = String(acao ?? '').trim();
	if (a === '410 direto') return '410';
	if (a.startsWith('301')) return '301';
	return 'unknown';
}

function slugKeyFromPlan(slug) {
	return String(slug ?? '')
		.replace(/^\/+|\/+$/g, '')
		.replace(/^d\//, '')
		.toLowerCase();
}

function resolveSourceFile(arquivo) {
	const rel = String(arquivo ?? '').replace(/\\/g, '/');
	if (!rel) return null;
	if (rel.startsWith('src/data/wp/pages/') || rel.startsWith('src/data/wp/posts/')) {
		return path.join(ROOT, rel);
	}
	return null;
}

function gitMv(fromAbs, toAbs) {
	const fromRel = path.relative(ROOT, fromAbs).replace(/\\/g, '/');
	const toRel = path.relative(ROOT, toAbs).replace(/\\/g, '/');
	const result = spawnSync('git', ['mv', fromRel, toRel], {
		cwd: ROOT,
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		throw new Error(
			`git mv falhou: ${fromRel} → ${toRel}\n${result.stderr || result.stdout || ''}`,
		);
	}
}

/**
 * Confirma que o filtro hasWpContentModule existe em wordpress.ts
 * (JSON em archive/removed-wp-pages/ não gera rota).
 */
async function ensureWordpressArchiveFilter() {
	const raw = await readFile(WORDPRESS_TS, 'utf8');
	if (!raw.includes('hasWpContentModule')) {
		throw new Error(
			'Filtro hasWpContentModule ausente em src/lib/wordpress.ts.\n' +
				'  Ele deve filtrar getAllContentPaths / findByPath / getBlogPosts\n' +
				'  para não gerar rotas de JSON arquivados.',
		);
	}
	console.log(
		'✓ Filtro hasWpContentModule() confirmado em src/lib/wordpress.ts\n' +
			'  (getAllContentPaths, findByPath, getBlogPosts).',
	);
	return false;
}

function printInstructions(redirectCount) {
	console.log(`
────────────────────────────────────────────────────────────
Como aplicar os redirects 301 (manual — astro.config NÃO foi editado)
────────────────────────────────────────────────────────────
1. Abra: scripts/redirects-cidades.json (${redirectCount} entradas)

2. Opção A — policy SEO (recomendado neste projeto):
   Mesclar as chaves em src/data/seo/fora-area-policy.json → "redirects"
   (mesmo formato: "slug": "/descupinizacao/regioes/")
   Depois: npm run build  (sync-vercel-redirects.mjs atualiza vercel.json)

3. Opção B — astro.config.mjs → redirects: {
     '/slug-antigo': { status: 301, destination: '/descupinizacao/regioes' },
     ...
   }

4. Rode \`npm run build\` e confira que o site builda sem erros antes de
   commitar. Depois do deploy, resubmeta o sitemap no Search Console e
   use a ferramenta de Remoção de URLs para as páginas mais antigas.
────────────────────────────────────────────────────────────
`);
}

async function main() {
	const { apply } = parseArgs(process.argv.slice(2));
	const mode = apply ? 'APPLY' : 'DRY-RUN';

	console.log(`\n=== execute-removal-plan (${mode}) ===\n`);
	assertCleanGit();
	console.log('✓ git working tree limpo\n');

	if (!(await pathExists(PLAN_CSV))) {
		console.error(
			`❌ Não encontrei ${path.relative(ROOT, PLAN_CSV)}.\n` +
				`   Rode antes: npm run plan:remocao -- --gsc <export-gsc.csv>`,
		);
		process.exit(1);
	}

	const rows = await readCsvRows(PLAN_CSV);
	const to410 = rows.filter((r) => classifyAction(r.acao_sugerida) === '410');
	const to301 = rows.filter((r) => classifyAction(r.acao_sugerida) === '301');
	const unknown = rows.filter((r) => classifyAction(r.acao_sugerida) === 'unknown');

	if (unknown.length) {
		console.warn(`⚠️  ${unknown.length} linha(s) com ação não reconhecida (ignoradas).`);
	}

	console.log(`Plano: ${path.relative(ROOT, PLAN_CSV)}`);
	console.log(`  410 direto (arquivar):     ${to410.length}`);
	console.log(`  301 → ${DESTINO_301}: ${to301.length}`);
	console.log('');

	if (!apply) {
		console.log('── Arquivos que SERIAM movidos para archive/removed-wp-pages/ (410) ──');
		for (const row of to410) {
			console.log(`  ${row.arquivo || '(sem arquivo)'}  ←  ${row.slug}`);
		}
		console.log('\n── Slugs que TERIAM redirect 301 (sem mover arquivo) ──');
		for (const row of to301) {
			console.log(`  ${row.slug}  (${row.arquivo || 'n/a'})`);
		}
		console.log(
			'\nNenhum arquivo foi alterado (dry-run).\n' +
				'Para executar de verdade (com git limpo):\n' +
				'  node scripts/execute-removal-plan.mjs --apply\n',
		);
		return;
	}

	// ——— APPLY ———
	await mkdir(ARCHIVE_DIR, { recursive: true });

	let moved = 0;
	const missing = [];

	for (const row of to410) {
		const src = resolveSourceFile(row.arquivo);
		if (!src || !(await pathExists(src))) {
			missing.push(row.arquivo || row.slug);
			continue;
		}
		const dest = path.join(ARCHIVE_DIR, path.basename(src));
		if (await pathExists(dest)) {
			throw new Error(`Destino já existe (evitando overwrite): ${path.relative(ROOT, dest)}`);
		}
		gitMv(src, dest);
		moved += 1;
	}

	/** @type {Record<string, string>} */
	const redirects = {};
	for (const row of to301) {
		const key = slugKeyFromPlan(row.slug);
		if (!key) continue;
		redirects[key] = DESTINO_301;
	}

	const existing = (await pathExists(REDIRECTS_JSON))
		? JSON.parse(await readFile(REDIRECTS_JSON, 'utf8'))
		: {};
	const merged = {
		...existing,
		...redirects,
		_meta: {
			generatedAt: new Date().toISOString(),
			destinoPadrao: DESTINO_301,
			nota: 'Gerado por execute-removal-plan.mjs — mesclar manualmente na policy SEO ou astro redirects. Não edita astro.config.mjs.',
		},
	};
	// keep _meta last visually by rewriting
	const { _meta, ...slugMap } = merged;
	await writeFile(
		REDIRECTS_JSON,
		`${JSON.stringify({ ...slugMap, _meta }, null, 2)}\n`,
		'utf8',
	);

	await ensureWordpressArchiveFilter();

	console.log('\n=== Resultado --apply ===\n');
	console.log(`Arquivos movidos (git mv → archive/removed-wp-pages/): ${moved}`);
	if (missing.length) {
		console.log(`Arquivos do plano não encontrados (pulados): ${missing.length}`);
		for (const m of missing.slice(0, 15)) console.log(`  - ${m}`);
		if (missing.length > 15) console.log(`  … +${missing.length - 15} outros`);
	}
	console.log(`Redirects JSON: ${path.relative(ROOT, REDIRECTS_JSON)} (${Object.keys(redirects).length} slugs)`);

	printInstructions(Object.keys(redirects).length);

	console.log(
		'Lembrete: Rode `npm run build` e confira que o site builda sem erros antes de commitar. ' +
			'Depois do deploy, resubmeta o sitemap no Search Console e use a ferramenta de Remoção de URLs ' +
			'para as páginas mais antigas.\n',
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
