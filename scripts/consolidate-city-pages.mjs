/**
 * Consolida páginas city (decisao_final=consolidar) → /areas-de-atendimento/
 *
 * Uso:
 *   node scripts/consolidate-city-pages.mjs           # dry-run (padrão)
 *   node scripts/consolidate-city-pages.mjs --apply   # policy + git mv + sync + audits
 *
 * Nunca deleta conteúdo — só git mv para archive/city-pages-consolidadas/
 */
import { spawnSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cidadesGsp from '../src/data/cidades-gsp.json' with { type: 'json' };
import { normalizePathKey, normalizeRedirectDestination } from './lib/redirect-map.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_CSV = path.join(ROOT, 'city-pages-audit.csv');
const POLICY_PATH = path.join(ROOT, 'src', 'data', 'seo', 'city-consolidate-policy.json');
const DIRECTORY_PATH = path.join(ROOT, 'src', 'data', 'seo', 'city-consolidate-directory.json');
const ARCHIVE_DIR = path.join(ROOT, 'archive', 'city-pages-consolidadas');
const WP_PAGES = path.join(ROOT, 'src', 'data', 'wp', 'pages');
const WP_POSTS = path.join(ROOT, 'src', 'data', 'wp', 'posts');
const SRC_PAGES = path.join(ROOT, 'src', 'pages');
const DEST = '/areas-de-atendimento/';

function parseArgs(argv) {
	return {
		apply: argv.includes('--apply') || argv.includes('--write'),
		writeDirectory: argv.includes('--write-directory'),
		help: argv.includes('--help') || argv.includes('-h'),
	};
}

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

function slugify(text) {
	return String(text)
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function titleCaseFromSlug(slug) {
	return String(slug)
		.split('-')
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

/** Prefix → hub de serviço */
function serviceHubFromPath(pathKey) {
	const leaf = pathKey.split('/').pop() || pathKey;
	if (/cupim|descupiniza/i.test(leaf)) return '/descupinizacao/';
	if (/deratiza|desratiza|rato/i.test(leaf)) return '/deratizacao/';
	if (/sanitiza/i.test(leaf)) return '/sanitizacao/';
	if (/mosquito/i.test(leaf)) return '/controle-de-mosquitos/';
	return '/dedetizacao/';
}

function serviceClusterLabel(href) {
	const map = {
		'/descupinizacao/': 'descupinizacao',
		'/dedetizacao/': 'dedetizacao',
		'/deratizacao/': 'deratizacao',
		'/sanitizacao/': 'sanitizacao',
		'/controle-de-mosquitos/': 'mosquitos',
	};
	return map[href] || 'dedetizacao';
}

const municipios = cidadesGsp.municipios ?? {};
const aliases = cidadesGsp.aliases ?? {};
const bairrosSaoPaulo = new Set(cidadesGsp.bairrosSaoPaulo ?? []);
const regioes = [...(cidadesGsp.regioes ?? [])].sort((a, b) => (a.ordem ?? 99) - (b.ordem ?? 99));
const regioesMap = new Map(regioes.map((r) => [r.id, r]));

function extractLocationFromPath(itemPath) {
	const segment = itemPath.split('/').pop() ?? itemPath;
	const match = segment.match(
		/(?:descupinizacao|descupinizadora|dedetizacao|desinsetizacao|dedetizadora-de-cupim|dedetizadora-de-rato|dedetizadora-de-mosquito|dedetizadora-em|dedetizadora-de-barata|dedetizadora-de-formiga|dedetizadora-de-pulga|dedetizadora-de-escorpiao|desratizacao|desratizadora|sanitizacao|controle-de-mosquito|empresa-de-descupinizacao|empresa-de-dedetizacao|limpeza|desentupidora|hidrojateamento|controle-de-cupim|melhor-veneno-para-cupim|matar-cupim)(?:-em|-no|-na|-de)?-(.+)$/i,
	);
	return match ? match[1].replace(/-\d+$/, '') : null;
}

function resolveMunicipioSlug(slug) {
	if (municipios[slug]) return slug;
	if (bairrosSaoPaulo.has(slug)) return 'sao-paulo';
	const aliasKey = slug.replace(/-/g, ' ');
	if (aliases[aliasKey]) return aliases[aliasKey];
	if (aliases[slug]) return aliases[slug];
	return null;
}

function resolveCity(pathKey) {
	const pathSlug = extractLocationFromPath(pathKey) || pathKey.split('/').pop() || pathKey;
	const municipioSlug = resolveMunicipioSlug(pathSlug);

	if (municipioSlug && municipios[municipioSlug]) {
		return {
			id: municipioSlug,
			nome: municipios[municipioSlug].nome,
			regiaoId: municipios[municipioSlug].regiao,
		};
	}

	if (bairrosSaoPaulo.has(pathSlug)) {
		return {
			id: pathSlug,
			nome: titleCaseFromSlug(pathSlug),
			regiaoId: 'regiao-sp',
		};
	}

	if (/zona-(norte|sul|leste|oeste)/i.test(pathSlug) || pathSlug.includes('centro')) {
		return {
			id: pathSlug,
			nome: titleCaseFromSlug(pathSlug),
			regiaoId: 'regiao-sp',
		};
	}

	return {
		id: slugify(pathSlug) || 'desconhecida',
		nome: titleCaseFromSlug(pathSlug) || 'Localidade',
		regiaoId: 'fora',
	};
}

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
	/** @type {Map<string, { kind: string, abs: string, rel: string, id?: string }>} */
	const index = new Map();

	async function indexWp(dir, kind) {
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
			index.set(key, {
				kind,
				abs,
				rel: path.relative(ROOT, abs).replace(/\\/g, '/'),
				id: String(data.id ?? name.replace(/\.json$/, '')),
			});
		}
	}

	await indexWp(WP_PAGES, 'wp-page');
	await indexWp(WP_POSTS, 'wp-post');

	for (const abs of await walkFiles(SRC_PAGES, new Set(['.astro', '.md', '.mdx']))) {
		const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
		if (!rel.startsWith('src/pages/')) continue;
		const key = normalizePathKey(
			rel
				.replace(/^src\/pages\//, '')
				.replace(/\.(astro|md|mdx)$/i, '')
				.replace(/\/index$/i, ''),
		);
		if (!key || index.has(key)) continue;
		index.set(key, { kind: 'static', abs, rel });
	}

	return index;
}

function archiveTarget(hit) {
	if (hit.kind === 'wp-page' || hit.kind === 'wp-post') {
		const base = hit.id ? `${hit.id}.json` : path.basename(hit.abs);
		return path.join(ARCHIVE_DIR, base).replace(/\\/g, '/');
	}
	// estáticos: preserva path relativo sob archive
	const rel = hit.rel.replace(/^src\/pages\//, '');
	return path.join(ARCHIVE_DIR, 'static', rel).replace(/\\/g, '/');
}

/**
 * @returns {Promise<{
 *   items: object[],
 *   redirects: Record<string, string>,
 *   directory: object,
 *   missing: string[],
 * }>}
 */
async function planConsolidation() {
	const matrix = parseCsv(await readFile(AUDIT_CSV, 'utf8'));
	const headers = matrix[0].map((h) => String(h).trim());
	const col = Object.fromEntries(headers.map((h, i) => [h, i]));

	const consolidarUrls = matrix
		.slice(1)
		.filter((cells) => String(cells[col.decisao_final] ?? '').trim().toLowerCase() === 'consolidar')
		.map((cells) => String(cells[col.url] ?? '').trim())
		.filter(Boolean);

	const index = await buildPathIndex();
	/** @type {object[]} */
	const items = [];
	/** @type {string[]} */
	const missing = [];
	/** @type {Record<string, string>} */
	const redirects = {};

	/** @type {Map<string, { id: string, nome: string, regiaoId: string, hubs: Map<string, number> }>} */
	const cities = new Map();

	for (const url of consolidarUrls) {
		const key = normalizePathKey(url);
		redirects[key] = DEST;

		const hit = index.get(key);
		if (!hit) {
			missing.push(url);
			items.push({
				url,
				key,
				file: null,
				archiveTo: null,
				city: resolveCity(key),
				serviceHref: serviceHubFromPath(key),
			});
			continue;
		}

		const city = resolveCity(key);
		const serviceHref = serviceHubFromPath(key);
		const existing = cities.get(city.id);
		if (existing) {
			existing.hubs.set(serviceHref, (existing.hubs.get(serviceHref) || 0) + 1);
		} else {
			cities.set(city.id, {
				id: city.id,
				nome: city.nome,
				regiaoId: city.regiaoId,
				hubs: new Map([[serviceHref, 1]]),
			});
		}

		items.push({
			url,
			key,
			file: hit.rel,
			archiveTo: path.relative(ROOT, archiveTarget(hit)).replace(/\\/g, '/'),
			abs: hit.abs,
			archiveAbs: archiveTarget(hit),
			city,
			serviceHref,
		});
	}

	const cityList = [...cities.values()].map((c) => {
		let bestHref = '/dedetizacao/';
		let bestCount = -1;
		for (const [href, count] of c.hubs) {
			if (count > bestCount) {
				bestCount = count;
				bestHref = href;
			}
		}
		const regiao = regioesMap.get(c.regiaoId);
		return {
			id: c.id,
			nome: c.nome,
			regiaoId: c.regiaoId,
			regiaoLabel: regiao?.label ?? 'Outras localidades',
			regiaoOrdem: regiao?.ordem ?? 99,
			serviceHref: bestHref,
			serviceCluster: serviceClusterLabel(bestHref),
		};
	});

	cityList.sort(
		(a, b) =>
			a.regiaoOrdem - b.regiaoOrdem ||
			a.nome.localeCompare(b.nome, 'pt-BR') ||
			a.id.localeCompare(b.id),
	);

	/** @type {Map<string, object>} */
	const byRegion = new Map();
	for (const city of cityList) {
		if (!byRegion.has(city.regiaoId)) {
			byRegion.set(city.regiaoId, {
				regiaoId: city.regiaoId,
				regiaoLabel: city.regiaoLabel,
				regiaoOrdem: city.regiaoOrdem,
				cities: [],
			});
		}
		byRegion.get(city.regiaoId).cities.push({
			id: city.id,
			nome: city.nome,
			serviceHref: city.serviceHref,
			serviceCluster: city.serviceCluster,
		});
	}

	const regions = [...byRegion.values()].sort((a, b) => a.regiaoOrdem - b.regiaoOrdem);

	const directory = {
		generatedAt: new Date().toISOString(),
		destination: DEST,
		stats: {
			redirects: Object.keys(redirects).length,
			cities: cityList.length,
			regions: regions.length,
			filesToMove: items.filter((i) => i.file).length,
			missingFiles: missing.length,
		},
		regions,
	};

	return { items, redirects, directory, missing, consolidarCount: consolidarUrls.length };
}

async function applyGitMoves(items) {
	await mkdir(ARCHIVE_DIR, { recursive: true });
	let moved = 0;
	/** @type {string[]} */
	const errors = [];

	for (const item of items) {
		if (!item.abs || !item.archiveAbs) continue;
		await mkdir(path.dirname(item.archiveAbs), { recursive: true });
		const fromRel = path.relative(ROOT, item.abs).replace(/\\/g, '/');
		const toRel = path.relative(ROOT, item.archiveAbs).replace(/\\/g, '/');
		const result = spawnSync('git', ['mv', '--', fromRel, toRel], {
			cwd: ROOT,
			encoding: 'utf8',
		});
		if (result.status !== 0) {
			try {
				const { rename } = await import('node:fs/promises');
				await rename(item.abs, item.archiveAbs);
				spawnSync('git', ['add', '-A', '--', fromRel, toRel], {
					cwd: ROOT,
					encoding: 'utf8',
				});
				moved += 1;
			} catch (err) {
				errors.push(`${fromRel}: ${result.stderr || err}`);
			}
			continue;
		}
		moved += 1;
	}

	return { moved, errors };
}

function runNode(relScript, args = []) {
	const result = spawnSync(process.execPath, [path.join(ROOT, relScript), ...args], {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: 'inherit',
	});
	return result.status === 0;
}

async function writePolicy(redirects) {
	const sorted = Object.fromEntries(
		Object.entries(redirects)
			.map(([k, v]) => [normalizePathKey(k), normalizeRedirectDestination(v)])
			.sort(([a], [b]) => a.localeCompare(b)),
	);
	const policy = {
		generatedAt: new Date().toISOString(),
		cluster: 'city-consolidate',
		stats: { redirects: Object.keys(sorted).length },
		redirects: sorted,
		noindex: [],
	};
	await writeFile(POLICY_PATH, `${JSON.stringify(policy, null, '\t')}\n`, 'utf8');
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(
			'Uso:\n' +
				'  node scripts/consolidate-city-pages.mjs                  # dry-run\n' +
				'  node scripts/consolidate-city-pages.mjs --write-directory # só JSON do hub\n' +
				'  node scripts/consolidate-city-pages.mjs --apply         # policy + git mv + sync + audits\n',
		);
		return;
	}

	console.log('consolidate-city-pages');
	console.log(
		`Modo: ${args.apply ? '--apply' : args.writeDirectory ? '--write-directory' : '--dry-run'}\n`,
	);

	const plan = await planConsolidation();
	const movable = plan.items.filter((i) => i.file);

	console.log(`URLs consolidar (CSV):     ${plan.consolidarCount}`);
	console.log(`Redirects planejados:      ${Object.keys(plan.redirects).length}`);
	console.log(`Arquivos a mover (git mv): ${movable.length}`);
	console.log(`URL sem arquivo:           ${plan.missing.length}`);
	console.log(`Cidades no diretório:      ${plan.directory.stats.cities}`);
	console.log(`Regiões:                   ${plan.directory.stats.regions}`);
	console.log(`Destino:                   ${DEST}\n`);

	if (args.writeDirectory && !args.apply) {
		await writeFile(DIRECTORY_PATH, `${JSON.stringify(plan.directory, null, '\t')}\n`, 'utf8');
		console.log(`✓ Gravado ${path.relative(ROOT, DIRECTORY_PATH)}`);
		return;
	}

	console.log('=== Amostra redirects (10) ===');
	for (const [from, to] of Object.entries(plan.redirects).slice(0, 10)) {
		console.log(`  /${from}/ → ${to}`);
	}

	console.log('\n=== Amostra git mv (10) ===');
	for (const item of movable.slice(0, 10)) {
		console.log(`  ${item.file} → ${item.archiveTo}`);
	}

	console.log('\n=== Regiões (contagem de cidades) ===');
	for (const region of plan.directory.regions) {
		console.log(`  ${region.regiaoLabel}: ${region.cities.length}`);
	}

	if (plan.missing.length) {
		console.log('\n=== Sem arquivo (ainda assim entram no redirect) ===');
		for (const u of plan.missing.slice(0, 20)) console.log(`  · ${u}`);
		if (plan.missing.length > 20) console.log(`  … +${plan.missing.length - 20}`);
	}

	if (!args.apply) {
		console.log('\nDry-run: nada gravado / movido. Use --apply para executar.');
		return;
	}

	console.log('\nAplicando…');
	await writePolicy(plan.redirects);
	await writeFile(DIRECTORY_PATH, `${JSON.stringify(plan.directory, null, '\t')}\n`, 'utf8');
	console.log('Policy + directory gravados (wiring já está nos imports).');

	const { moved, errors } = await applyGitMoves(movable);
	console.log(`git mv: ${moved} arquivos`);
	if (errors.length) {
		console.error('Erros de move:');
		for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
		process.exitCode = 1;
		return;
	}

	console.log('\nRodando sync-vercel-redirects.mjs --write…\n');
	if (!runNode('scripts/sync-vercel-redirects.mjs', ['--write'])) {
		console.error('sync falhou');
		process.exitCode = 1;
		return;
	}

	console.log('\nRodando audit-pest-type-mismatch.mjs…\n');
	if (!runNode('scripts/audit-pest-type-mismatch.mjs')) {
		console.error('pest mismatch audit falhou');
		process.exitCode = 1;
		return;
	}

	console.log('\nRodando detect-redirect-loops.mjs…\n');
	if (!runNode('scripts/detect-redirect-loops.mjs')) {
		console.error('detect loops falhou');
		process.exitCode = 1;
		return;
	}

	console.log('\n✓ Apply concluído.');
	console.log(`  Policy: ${path.relative(ROOT, POLICY_PATH)}`);
	console.log(`  Directory: ${path.relative(ROOT, DIRECTORY_PATH)}`);
	console.log(`  Archive: ${path.relative(ROOT, ARCHIVE_DIR)}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
