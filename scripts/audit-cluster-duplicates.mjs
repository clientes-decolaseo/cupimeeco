import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import manifest from '../src/data/wp/manifest.json' with { type: 'json' };
import { extractLocationFromPath, isPageInServiceArea } from './lib/resolve-city.mjs';
import { pageBelongsToClusterId } from './lib/cluster-page-match.mjs';
import { getClusterPreferPathScore } from './lib/cluster-prefer-path.mjs';

const OUT_DIR = path.resolve('src/data/seo');
const SERVICO_HOME = '/servico/';

const BLOG_OFF_TOPIC =
	/(vazamento|hidra|encanador|desentupidor|impermeabil|caixa-dagua|hidrojateamento)/i;

const CLUSTER_CONFIGS = [
	{
		id: 'descupinizacao',
		policyFile: 'cupim-policy.json',
		htaccessLabel: 'CUPIM',
		pilar: '/descupinizacao',
		hubRegioes: '/descupinizacao/regioes',
		isPage: (p) => pageBelongsToClusterId(p, 'descupinizacao'),
		locationPattern:
			/^(?:descupinizacao|descupinizadora|dedetizadora-de-cupim|dedetizacao-de-cupim|dedetizacao-de-cupins|dedetizacao-cupim|empresa-de-descupinizacao)(?:-em|-no|-na|-de)?-(.+)$/i,
		preferPath: (p) => getClusterPreferPathScore('descupinizacao', p),
		redirectToPilar: new Set([
			'dedetizacao-de-cupins',
			'dedetizacao-cupim-sp-preco',
			'servicos-de-dedetizacao-de-cupins',
			'sao-sebastiao-sp/dedetizacao-de-cupins',
			'descupinizacao-como-funciona',
			'descupinizacao-sp-preco',
			'descupinizadora-em-sao-paulo',
			'dedetizadora-de-cupim-em-sao-paulo',
			'dedetizadora-de-cupim-na-zona-norte-sp',
			'dedetizadora-de-cupim-na-zona-sul-sp',
			'dedetizadora-de-cupim-na-zona-oeste-sp',
			'dedetizadora-de-cupim-na-zona-norte',
			'dedetizadora-de-cupim-na-zona-sul',
			'dedetizadora-de-cupim-no-litoral',
			'dedetizadora-de-cupim-no-rj',
			'dedetizadora-de-cupim-em-pernambuco',
			'dedetizadora-de-cupim-em-mato-grosso',
			'dedetizadora-de-cupim-em-sergipe',
			'dedetizadora-de-cupim-em-palmas',
			'dedetizadora-de-cupim-em-aracaju',
		]),
	},
	{
		id: 'dedetizacao',
		policyFile: 'dedetizacao-policy.json',
		htaccessLabel: 'DEDETIZACAO',
		pilar: '/dedetizacao',
		hubRegioes: '/dedetizacao/regioes',
		isPage: (p) => pageBelongsToClusterId(p, 'dedetizacao'),
		locationPattern:
			/^(?:dedetizadora-em|dedetizadora-de-barata|dedetizadora-de-formiga|dedetizadora-de-pulga|dedetizadora-de-carrapato|dedetizadora-de-escorpiao|empresa-de-dedetizacao|dedetizadora)(?:-em|-na|-no|-de)?-(.+)$/i,
		preferPath: (p) => getClusterPreferPathScore('dedetizacao', p),
		redirectToPilar: new Set([
			'dedetizadora-em-sao-paulo',
			'dedetizadora-em-sp',
			'dedetizadora-na-zona-norte',
			'dedetizadora-na-zona-sul',
			'dedetizadora-na-zona-oeste',
			'dedetizadora-em-florianopolis',
			'dedetizadora-em-curitiba',
			'dedetizadora-em-joinville',
			'dedetizadora-em-salvador',
			'dedetizadora-em-fortaleza',
			'dedetizadora-em-belo-horizonte',
			'dedetizadora-em-porto-alegre',
			'dedetizadora-em-recife',
			'dedetizadora-em-manaus',
			'dedetizadora-em-brasilia',
		]),
	},
	{
		id: 'deratizacao',
		policyFile: 'deratizacao-policy.json',
		htaccessLabel: 'DERATIZACAO',
		pilar: '/deratizacao',
		hubRegioes: '/deratizacao/regioes',
		isPage: (p) => pageBelongsToClusterId(p, 'deratizacao'),
		locationPattern:
			/^(?:dedetizadora-de-rato|desratizacao|desratizadora|desratiz)(?:-em|-na|-no|-de)?-(.+)$/i,
		preferPath: (p) => getClusterPreferPathScore('deratizacao', p),
		redirectToPilar: new Set([
			'desratizacao',
			'desratizacao-em-sao-paulo',
			'desratizadora-em-sao-paulo',
			'dedetizadora-de-rato-em-sao-paulo',
			'dedetizadora-de-rato-em-florianopolis',
			'dedetizadora-de-rato-em-curitiba',
			'dedetizadora-de-rato-em-joinville',
			'dedetizadora-de-rato-em-salvador',
			'dedetizadora-de-rato-em-fortaleza',
			'dedetizadora-de-rato-em-recife',
			'dedetizadora-de-rato-em-porto-alegre',
		]),
	},
	{
		id: 'sanitizacao',
		policyFile: 'sanitizacao-policy.json',
		htaccessLabel: 'SANITIZACAO',
		pilar: '/sanitizacao',
		hubRegioes: '/sanitizacao/regioes',
		isPage: (p) => pageBelongsToClusterId(p, 'sanitizacao'),
		locationPattern: /^sanitizacao(?:-em|-na|-no)?-(.+)$/i,
		preferPath: (p) => getClusterPreferPathScore('sanitizacao', p),
		redirectToPilar: new Set(),
	},
	{
		id: 'mosquitos',
		policyFile: 'mosquitos-policy.json',
		htaccessLabel: 'MOSQUITOS',
		pilar: '/controle-de-mosquitos',
		hubRegioes: '/controle-de-mosquitos/regioes',
		isPage: (p) => pageBelongsToClusterId(p, 'mosquitos'),
		locationPattern: /^(?:dedetizadora-de-mosquito|controle-de-mosquito)(?:-em|-na|-no)?-(.+)$/i,
		preferPath: (p) => getClusterPreferPathScore('mosquitos', p),
		redirectToPilar: new Set(),
	},
];

function normTitle(t) {
	return t
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9\s]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function pickCanonicalPage(entries, config) {
	return [...entries].sort((a, b) => {
		const score = (entry) => {
			let s = config.preferPath(entry.path);
			if (/-\d+$/.test(entry.path)) s += 10;
			if (entry.path.includes('/')) s += 8;
			return s;
		};

		const diff = score(a) - score(b);
		if (diff !== 0) return diff;
		return new Date(b.modified).getTime() - new Date(a.modified).getTime();
	})[0];
}

function extractLocationSlug(itemPath, pattern) {
	const base = itemPath.split('/').pop() ?? itemPath;
	const match = base.match(pattern);
	return match ? match[1].replace(/-\d+$/, '') : null;
}

function auditCluster(config) {
	const pages = manifest.pages.filter((e) => e.path && config.isPage(e.path));
	const redirects = new Map();
	const byBase = new Map();

	for (const page of pages) {
		const segment = page.path.split('/').pop() ?? page.path;
		const base = segment.replace(/-\d+$/, '');

		if (!byBase.has(base)) byBase.set(base, []);
		byBase.get(base).push(page);
	}

	for (const [, entries] of byBase) {
		if (entries.length < 2) continue;

		const canonical = pickCanonicalPage(entries, config);

		for (const entry of entries) {
			if (entry.path === canonical.path) continue;
			redirects.set(entry.path, `/${canonical.path}/`);
		}
	}

	const byLocation = new Map();

	for (const page of pages) {
		const loc = extractLocationSlug(page.path, config.locationPattern);
		if (!loc) continue;
		if (!byLocation.has(loc)) byLocation.set(loc, []);
		byLocation.get(loc).push(page);
	}

	for (const [, entries] of byLocation) {
		if (entries.length < 2) continue;

		const canonical = pickCanonicalPage(entries, config);

		for (const entry of entries) {
			if (entry.path === canonical.path) continue;
			if (!redirects.has(entry.path)) {
				redirects.set(entry.path, `/${canonical.path}/`);
			}
		}
	}

	for (const pathKey of config.redirectToPilar) {
		if (pages.some((p) => p.path === pathKey)) {
			redirects.set(pathKey, `${config.pilar}/`);
		}
	}

	for (const page of pages) {
		if (page.path.includes('/')) {
			redirects.set(page.path, `${config.hubRegioes}/`);
		}
	}

	for (const page of pages) {
		if (!isPageInServiceArea(page)) {
			redirects.set(page.path, `${config.pilar}/`);
		}
	}

	const byTitle = new Map();

	for (const page of pages) {
		const key = normTitle(page.title);
		if (!key) continue;
		if (!byTitle.has(key)) byTitle.set(key, []);
		byTitle.get(key).push(page);
	}

	for (const [, entries] of byTitle) {
		if (entries.length < 2) continue;

		const canonical = pickCanonicalPage(entries, config);

		for (const entry of entries) {
			if (entry.path === canonical.path) continue;
			if (!redirects.has(entry.path)) {
				redirects.set(entry.path, `/${canonical.path}/`);
			}
		}
	}

	return {
		pages,
		redirects,
		policy: {
			generatedAt: new Date().toISOString(),
			cluster: config.id,
			stats: {
				pages: pages.length,
				redirects: redirects.size,
			},
			redirects: Object.fromEntries(
				[...redirects.entries()].sort(([a], [b]) => a.localeCompare(b)),
			),
			noindex: [],
		},
	};
}

function updateHtaccessBlock(htaccess, label, redirects) {
	const rules = [...redirects.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([from, to]) => {
			const target = to.endsWith('/') ? to : `${to}/`;
			return `\tRewriteRule ^${from}/?$ ${target} [R=301,L]`;
		})
		.join('\n');

	const block = `# BEGIN ${label} REDIRECTS (npm run audit:seo)\n${rules}\n\t# END ${label} REDIRECTS`;
	const begin = `# BEGIN ${label} REDIRECTS`;
	const end = `# END ${label} REDIRECTS`;

	if (htaccess.includes(begin)) {
		return htaccess.replace(new RegExp(`# BEGIN ${label} REDIRECTS[\\s\\S]*?# END ${label} REDIRECTS\\n?`), `${block}\n`);
	}

	return htaccess.replace(/(\t# END CUPIM REDIRECTS\n)/, `$1\n${block}\n`);
}

function pilarForPath(itemPath) {
	if (pageBelongsToClusterId(itemPath, 'descupinizacao')) {
		return '/descupinizacao/';
	}

	if (pageBelongsToClusterId(itemPath, 'deratizacao')) {
		return '/deratizacao/';
	}

	if (pageBelongsToClusterId(itemPath, 'dedetizacao')) {
		return '/dedetizacao/';
	}

	if (pageBelongsToClusterId(itemPath, 'sanitizacao')) {
		return '/sanitizacao/';
	}

	if (pageBelongsToClusterId(itemPath, 'mosquitos')) {
		return '/controle-de-mosquitos/';
	}

	return SERVICO_HOME;
}

mkdirSync(OUT_DIR, { recursive: true });

const allRedirects = new Map();
const blogNoindex = new Set();
const outOfAreaRedirects = new Map();

for (const post of manifest.posts) {
	if (!post.path.startsWith('blog/')) continue;
	const slug = post.path.slice('blog/'.length);
	if (BLOG_OFF_TOPIC.test(slug)) blogNoindex.add(post.path);
}

let htaccess = readFileSync(path.resolve('public/.htaccess'), 'utf8');

for (const config of CLUSTER_CONFIGS) {
	const { pages, redirects, policy } = auditCluster(config);

	for (const [from, to] of redirects) {
		if (allRedirects.has(from) && allRedirects.get(from) !== to) {
			console.warn(`Conflito de redirect: ${from}`);
		}

		allRedirects.set(from, to);
	}

	if (config.id === 'descupinizacao') {
		policy.noindex = [...blogNoindex].sort();
	}

	const outPath = path.join(OUT_DIR, config.policyFile);
	writeFileSync(outPath, `${JSON.stringify(policy, null, 2)}\n`);

	htaccess = updateHtaccessBlock(htaccess, config.htaccessLabel, redirects);

	console.log(
		`${config.id}: ${pages.length} páginas → ${redirects.size} redirects 301 → ${config.policyFile}`,
	);
}

/** Slugs com sufixo numérico (-2, -3) quando a versão sem sufixo existe */
function auditNumericSuffixDuplicates(existingRedirects) {
	const redirects = new Map();
	const pagesByPath = new Map(
		manifest.pages.filter((p) => p.path).map((p) => [p.path, p]),
	);

	for (const page of manifest.pages) {
		if (!page.path || existingRedirects.has(page.path)) continue;

		const segment = page.path.split('/').pop() ?? page.path;
		if (!/-\d+$/.test(segment)) continue;

		const baseSegment = segment.replace(/-\d+$/, '');
		const parentPrefix = page.path.includes('/')
			? page.path.slice(0, page.path.length - segment.length)
			: '';
		const canonicalPath = `${parentPrefix}${baseSegment}`;

		if (canonicalPath === page.path || !pagesByPath.has(canonicalPath)) continue;

		redirects.set(page.path, `/${canonicalPath}/`);
	}

	return redirects;
}

for (const page of manifest.pages) {
	if (!page.path || allRedirects.has(page.path)) continue;

	const hasGeo = extractLocationFromPath(page.path) || /\b(?:em|na|no)\s+/i.test(page.title);

	if (hasGeo && !isPageInServiceArea(page)) {
		outOfAreaRedirects.set(page.path, pilarForPath(page.path));
	}
}

const numericSuffixRedirects = auditNumericSuffixDuplicates(allRedirects);

for (const [from, to] of numericSuffixRedirects) {
	if (!allRedirects.has(from)) {
		allRedirects.set(from, to);
	}
}

function updateHtaccessOutOfArea(htaccessContent, redirects) {
	const rules = [...redirects.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([from, to]) => {
			const target = to.endsWith('/') ? to : `${to}/`;
			return `\tRewriteRule ^${from}/?$ ${target} [R=301,L]`;
		})
		.join('\n');

	const block = `# BEGIN FORA AREA ATENDIDA (npm run audit:seo)\n${rules}\n\t# END FORA AREA ATENDIDA`;
	const begin = '# BEGIN FORA AREA ATENDIDA';

	if (htaccessContent.includes(begin)) {
		return htaccessContent.replace(
			/# BEGIN FORA AREA ATENDIDA[\s\S]*?# END FORA AREA ATENDIDA\n?/,
			`${block}\n`,
		);
	}

	return htaccessContent.replace(
		/(\t# END DERATIZACAO REDIRECTS\n)/,
		`$1\n${block}\n`,
	);
}

for (const [from, to] of outOfAreaRedirects) {
	if (!allRedirects.has(from)) {
		allRedirects.set(from, to);
	}
}

htaccess = updateHtaccessOutOfArea(htaccess, outOfAreaRedirects);

function updateHtaccessDuplicates(htaccessContent, redirects) {
	const rules = [...redirects.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([from, to]) => {
			const target = to.endsWith('/') ? to : `${to}/`;
			return `\tRewriteRule ^${from}/?$ ${target} [R=301,L]`;
		})
		.join('\n');

	const block = `# BEGIN DUPLICATAS NUMERICAS (npm run audit:seo)\n${rules}\n\t# END DUPLICATAS NUMERICAS`;
	const begin = '# BEGIN DUPLICATAS NUMERICAS';

	if (!rules) {
		if (htaccessContent.includes(begin)) {
			return htaccessContent.replace(
				/# BEGIN DUPLICATAS NUMERICAS[\s\S]*?# END DUPLICATAS NUMERICAS\n?/,
				'',
			);
		}
		return htaccessContent;
	}

	if (htaccessContent.includes(begin)) {
		return htaccessContent.replace(
			/# BEGIN DUPLICATAS NUMERICAS[\s\S]*?# END DUPLICATAS NUMERICAS\n?/,
			`${block}\n`,
		);
	}

	return htaccessContent.replace(
		/(\t# END FORA AREA ATENDIDA\n)/,
		`$1\n${block}\n`,
	);
}

htaccess = updateHtaccessDuplicates(htaccess, numericSuffixRedirects);

const duplicatesPolicy = {
	generatedAt: new Date().toISOString(),
	stats: { redirects: numericSuffixRedirects.size },
	redirects: Object.fromEntries(
		[...numericSuffixRedirects.entries()].sort(([a], [b]) => a.localeCompare(b)),
	),
	noindex: [],
};

writeFileSync(
	path.join(OUT_DIR, 'duplicates-policy.json'),
	`${JSON.stringify(duplicatesPolicy, null, 2)}\n`,
);

const outOfAreaPolicy = {
	generatedAt: new Date().toISOString(),
	stats: { redirects: outOfAreaRedirects.size },
	redirects: Object.fromEntries(
		[...outOfAreaRedirects.entries()].sort(([a], [b]) => a.localeCompare(b)),
	),
	noindex: [],
};

writeFileSync(
	path.join(OUT_DIR, 'fora-area-policy.json'),
	`${JSON.stringify(outOfAreaPolicy, null, 2)}\n`,
);

writeFileSync(path.resolve('public/.htaccess'), htaccess);

console.log(`\nDuplicatas numéricas (-2, -3…): ${numericSuffixRedirects.size} redirects`);
console.log(`Total redirects cluster: ${allRedirects.size - outOfAreaRedirects.size - numericSuffixRedirects.size}`);
console.log(`Fora da área atendida: ${outOfAreaRedirects.size} redirects`);
console.log(`Blog noindex: ${blogNoindex.size}`);
