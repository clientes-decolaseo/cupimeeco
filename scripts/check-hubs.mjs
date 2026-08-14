/**
 * Checagem de hubs finos (poucos spokes vivos).
 *
 * Hubs cobertos (via src/data/clusters.json):
 *   - blog hubs: /blog/{topico}
 *   - hubs regionais ativos: {pilar}/regioes
 *
 * Spoke "vivo" = existe no manifesto/editorial, não redireciona,
 * não está noindex (policy ou seo.robots), e (páginas) está na área atendida.
 *
 * Uso:
 *   node scripts/check-hubs.mjs              # aviso no terminal (exit 0)
 *   node scripts/check-hubs.mjs --enforce    # grava noindex em hub-thin-policy.json
 *   npm run check:hubs
 *   npm run check:hubs:enforce
 *
 * No build: prebuild roda --enforce para que BioLayout/sitemap leiam a policy.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import clustersData from '../src/data/clusters.json' with { type: 'json' };
import manifest from '../src/data/wp/manifest.json' with { type: 'json' };
import cupimPolicy from '../src/data/seo/cupim-policy.json' with { type: 'json' };
import dedetizacaoPolicy from '../src/data/seo/dedetizacao-policy.json' with { type: 'json' };
import deratizacaoPolicy from '../src/data/seo/deratizacao-policy.json' with { type: 'json' };
import sanitizacaoPolicy from '../src/data/seo/sanitizacao-policy.json' with { type: 'json' };
import mosquitosPolicy from '../src/data/seo/mosquitos-policy.json' with { type: 'json' };
import foraAreaPolicy from '../src/data/seo/fora-area-policy.json' with { type: 'json' };
import duplicatesPolicy from '../src/data/seo/duplicates-policy.json' with { type: 'json' };
import gsc404Policy from '../src/data/seo/gsc-404-policy.json' with { type: 'json' };
import { matchesPagePath } from './lib/cluster-page-match.mjs';
import { buildRedirectMap, normalizePathKey } from './lib/redirect-map.mjs';
import { isPageInServiceArea } from './lib/resolve-city.mjs';

const ROOT = path.resolve('.');
const POLICY_OUT = path.join(ROOT, 'src', 'data', 'seo', 'hub-thin-policy.json');
const WP_PAGES_DIR = path.join(ROOT, 'src', 'data', 'wp', 'pages');
const WP_POSTS_DIR = path.join(ROOT, 'src', 'data', 'wp', 'posts');
const EDITORIAL_DIR = path.join(ROOT, 'src', 'data', 'editorial', 'posts');

const MIN_LIVE_SPOKES = 3;

const POLICY_NOINDEX = new Set(
	[
		cupimPolicy,
		dedetizacaoPolicy,
		deratizacaoPolicy,
		sanitizacaoPolicy,
		mosquitosPolicy,
		foraAreaPolicy,
		duplicatesPolicy,
		gsc404Policy,
	].flatMap((p) => (p.noindex ?? []).map((x) => normalizePathKey(x))),
);

function parseArgs(argv) {
	const args = { enforce: false, help: false };
	for (const a of argv) {
		if (a === '--enforce') args.enforce = true;
		else if (a === '--help' || a === '-h') args.help = true;
	}
	return args;
}

function normalizeHubPath(hubPath) {
	const withSlash = hubPath.startsWith('/') ? hubPath : `/${hubPath}`;
	return withSlash.replace(/\/+$/, '') || '/';
}

function pathKeyFromHub(hubPath) {
	return normalizePathKey(hubPath);
}

function isRegionalHubActive(cluster) {
	return cluster.hubRegioesAtivo !== false;
}

function postBelongsToCluster(entryPath, cluster) {
	if (!entryPath.startsWith('blog/')) return false;
	const slug = entryPath.slice('blog/'.length).toLowerCase();
	return (cluster.blogSlugIncludes ?? []).some((term) => slug.includes(term));
}

function pageBelongsToCluster(entryPath, cluster) {
	if (!entryPath || entryPath.startsWith('blog/')) return false;
	return matchesPagePath(entryPath, cluster.matchPage);
}

const redirectMap = buildRedirectMap();

function isRedirected(entryPath) {
	return redirectMap.has(normalizePathKey(entryPath));
}

/** Cache id → seo.robots (true = noindex Yoast). */
const robotsCache = new Map();

async function loadWpRobots(type, id) {
	const key = `${type}:${id}`;
	if (robotsCache.has(key)) return robotsCache.get(key);

	const file = path.join(type === 'page' ? WP_PAGES_DIR : WP_POSTS_DIR, `${id}.json`);
	try {
		const data = JSON.parse(await readFile(file, 'utf8'));
		const noindex = Boolean(data?.seo?.robots);
		robotsCache.set(key, noindex);
		return noindex;
	} catch {
		robotsCache.set(key, true); // arquivo ausente ⇒ trata como não publicado
		return true;
	}
}

async function loadEditorialPosts() {
	const files = await readdir(EDITORIAL_DIR);
	const posts = [];
	for (const file of files) {
		if (!file.endsWith('.json')) continue;
		const data = JSON.parse(await readFile(path.join(EDITORIAL_DIR, file), 'utf8'));
		posts.push({
			id: data.id,
			path: data.path,
			title: data.title,
			seoRobots: Boolean(data?.seo?.robots),
			editorial: true,
		});
	}
	return posts;
}

function isPolicyNoindex(entryPath) {
	return POLICY_NOINDEX.has(normalizePathKey(entryPath));
}

/**
 * Conta spokes vivos de um hub de blog (posts do cluster).
 */
async function countBlogSpokes(cluster, editorialPosts) {
	const live = [];
	const candidates = [
		...manifest.posts.map((p) => ({ ...p, editorial: false })),
		...editorialPosts,
	];

	for (const entry of candidates) {
		if (!entry.path || !postBelongsToCluster(entry.path, cluster)) continue;
		if (isRedirected(entry.path)) continue;
		if (isPolicyNoindex(entry.path)) continue;

		if (entry.editorial) {
			if (entry.seoRobots) continue;
		} else {
			const robots = await loadWpRobots('post', entry.id);
			if (robots) continue;
		}

		live.push(entry.path);
	}

	return live;
}

/**
 * Conta spokes vivos de um hub regional (landings do cluster na área).
 */
async function countRegioesSpokes(cluster) {
	const live = [];

	for (const entry of manifest.pages) {
		if (!entry.path || !pageBelongsToCluster(entry.path, cluster)) continue;
		if (isRedirected(entry.path)) continue;
		if (!isPageInServiceArea(entry)) continue;
		if (isPolicyNoindex(entry.path)) continue;

		const robots = await loadWpRobots('page', entry.id);
		if (robots) continue;

		live.push(entry.path);
	}

	return live;
}

async function collectHubReports(editorialPosts) {
	const hubs = [];

	for (const cluster of clustersData.clusters) {
		if (cluster.blogHub) {
			const spokes = await countBlogSpokes(cluster, editorialPosts);
			hubs.push({
				type: 'blog',
				clusterId: cluster.id,
				path: normalizeHubPath(cluster.blogHub),
				active: true,
				liveSpokes: spokes.length,
				thin: spokes.length < MIN_LIVE_SPOKES,
				spokeSample: spokes.slice(0, 5),
			});
		}

		if (cluster.hubRegioes) {
			const active = isRegionalHubActive(cluster);
			if (!active) {
				hubs.push({
					type: 'regioes',
					clusterId: cluster.id,
					path: normalizeHubPath(cluster.hubRegioes),
					active: false,
					liveSpokes: 0,
					thin: false,
					spokeSample: [],
					skipped: 'hubRegioesAtivo=false (nao publicado como hub)',
				});
				continue;
			}

			const spokes = await countRegioesSpokes(cluster);
			hubs.push({
				type: 'regioes',
				clusterId: cluster.id,
				path: normalizeHubPath(cluster.hubRegioes),
				active: true,
				liveSpokes: spokes.length,
				thin: spokes.length < MIN_LIVE_SPOKES,
				spokeSample: spokes.slice(0, 5),
			});
		}
	}

	return hubs;
}

async function writePolicy(hubs) {
	const thinActive = hubs.filter((h) => h.active && h.thin);
	const payload = {
		generatedAt: new Date().toISOString(),
		minLiveSpokes: MIN_LIVE_SPOKES,
		noindex: thinActive.map((h) => pathKeyFromHub(h.path)),
		hubs: hubs.map(({ spokeSample, ...rest }) => rest),
	};

	await writeFile(POLICY_OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
	return payload;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(
			'Uso: node scripts/check-hubs.mjs [--enforce]\n\n' +
				'  (padrão)   Lista hubs e avisa se liveSpokes < 3\n' +
				'  --enforce  Grava src/data/seo/hub-thin-policy.json (noindex dos hubs finos)\n',
		);
		return;
	}

	console.log(`check-hubs — mínimo ${MIN_LIVE_SPOKES} spokes vivos por hub\n`);

	const editorialPosts = await loadEditorialPosts();
	const hubs = await collectHubReports(editorialPosts);
	const active = hubs.filter((h) => h.active);
	const thin = active.filter((h) => h.thin);

	for (const hub of hubs) {
		const status = !hub.active
			? 'SKIP'
			: hub.thin
				? 'AVISO'
				: 'OK';
		const extra = hub.skipped ? ` — ${hub.skipped}` : '';
		console.log(
			`[${status}] ${hub.path}  (${hub.type}/${hub.clusterId})  spokes=${hub.liveSpokes}${extra}`,
		);
		if (hub.active && hub.thin) {
			console.log(
				`         → hub fino (<${MIN_LIVE_SPOKES} spokes vivos); considerar noindex até haver conteúdo suficiente`,
			);
		}
	}

	console.log('');

	if (args.enforce) {
		const policy = await writePolicy(hubs);
		console.log(
			`--enforce: gravou ${POLICY_OUT}\n` +
				`  noindex hubs: ${policy.noindex.length ? policy.noindex.join(', ') : '(nenhum)'}`,
		);
	} else if (thin.length > 0) {
		console.log(
			`AVISO: ${thin.length} hub(s) com menos de ${MIN_LIVE_SPOKES} spokes vivos.\n` +
				`  Rode com --enforce (ou npm run check:hubs:enforce / prebuild) para aplicar noindex.`,
		);
	} else {
		console.log('Todos os hubs ativos têm spokes suficientes.');
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
