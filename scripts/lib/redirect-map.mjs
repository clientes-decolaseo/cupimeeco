import cupimPolicy from '../../src/data/seo/cupim-policy.json' with { type: 'json' };
import dedetizacaoPolicy from '../../src/data/seo/dedetizacao-policy.json' with { type: 'json' };
import deratizacaoPolicy from '../../src/data/seo/deratizacao-policy.json' with { type: 'json' };
import sanitizacaoPolicy from '../../src/data/seo/sanitizacao-policy.json' with { type: 'json' };
import mosquitosPolicy from '../../src/data/seo/mosquitos-policy.json' with { type: 'json' };
import foraAreaPolicy from '../../src/data/seo/fora-area-policy.json' with { type: 'json' };
import duplicatesPolicy from '../../src/data/seo/duplicates-policy.json' with { type: 'json' };
import gsc404Policy from '../../src/data/seo/gsc-404-policy.json' with { type: 'json' };
import hubThinPolicy from '../../src/data/seo/hub-thin-policy.json' with { type: 'json' };
import offtopicPolicy from '../../src/data/seo/offtopic-policy.json' with { type: 'json' };
import cityConsolidatePolicy from '../../src/data/seo/city-consolidate-policy.json' with { type: 'json' };

const POLICY_FILES = [
	cupimPolicy,
	dedetizacaoPolicy,
	deratizacaoPolicy,
	sanitizacaoPolicy,
	mosquitosPolicy,
	foraAreaPolicy,
	duplicatesPolicy,
	hubThinPolicy,
	offtopicPolicy,
	gsc404Policy,
	cityConsolidatePolicy, // por último — consolida city pages (inclui colapso de cadeias)
];

/** Redirects estáticos do astro.config.mjs (fora dos JSON de cluster) */
const STATIC_REDIRECTS = {
	desratizacao: '/deratizacao/',
	fotos: '/',
	'biblioteca-da-universo': '/blog/',
	'glossario-tudo-sobre-descupinizacao': '/blog/',
	'dedetizacao-de-cupins': '/descupinizacao/',
	'dedetizadora-de-cupim': '/descupinizacao/',
	'sanitizacao/regioes': '/sanitizacao/',
	sitemap: '/sitemap-index.xml',
};

export function normalizePathKey(itemPath = '') {
	return itemPath
		.replace(/^\/+|\/+$/g, '')
		.replace(/^d\//, '')
		.toLowerCase();
}

export function normalizeRedirectDestination(destination = '') {
	if (!destination) return '/';
	const withSlash = destination.startsWith('/') ? destination : `/${destination}`;
	// Destinos com extensão de arquivo (raro) não ganham barra final.
	const leaf = withSlash.split('/').filter(Boolean).pop() || '';
	if (hasFileExtension(leaf)) return withSlash;
	return withSlash.endsWith('/') ? withSlash : `${withSlash}/`;
}

/**
 * True se o último segmento do path parece arquivo (ex.: 751775195.shtml, robots.xml).
 * Paths de conteúdo Astro (`/blog/foo`) não têm extensão.
 */
export function hasFileExtension(pathOrLeaf = '') {
	const leaf = String(pathOrLeaf).split('/').filter(Boolean).pop() || '';
	return /\.[a-z0-9]{1,10}$/i.test(leaf);
}

/**
 * Monta o campo `source` de uma regra exata do vercel.json.
 *
 * Causa raiz (NÃO remover este comentário sem reler o histórico):
 * o site usa `trailingSlash: 'always'` no Astro. Em produção, a Vercel/Astro
 * emite um 308 de normalização `/path` → `/path/` ANTES de avaliar as regras
 * de `vercel.json`. Se o `source` estiver sem barra final, a regra nunca
 * casa (a request já chegou como `/path/`) e a URL cai em 404 — mesmo com
 * a policy correta no repo. Por isso geramos UMA única regra, já na forma
 * canônica com `/` no final.
 *
 * Exceção: paths com extensão de arquivo (`.shtml`, `.xml`, …) não passam
 * por essa normalização de trailing slash; o `source` fica sem barra.
 *
 * Não gere pares com/sem barra — só a variante correta.
 *
 * @param {string} pathKey slug normalizado (sem barras nas pontas) ou path
 * @returns {string} source absoluto para vercel.json (ex.: `/foo/` ou `/x.shtml`)
 */
export function formatRedirectSource(pathKey) {
	const key = normalizePathKey(pathKey);
	if (!key) return '/';

	const source = `/${key}`;
	if (hasFileExtension(key)) return source;
	return `${source}/`;
}

/**
 * @returns {Map<string, string>} slug normalizado → destino com barra final
 */
export function buildRedirectMap() {
	const map = new Map();

	for (const [from, to] of Object.entries(STATIC_REDIRECTS)) {
		map.set(normalizePathKey(from), normalizeRedirectDestination(to));
	}

	for (const policy of POLICY_FILES) {
		for (const [from, to] of Object.entries(policy.redirects ?? {})) {
			const key = normalizePathKey(from);
			const destination = normalizeRedirectDestination(to);
			map.set(key, destination);
		}
	}

	// STATIC por último — prioridade sobre policies em caso de colisão
	for (const [from, to] of Object.entries(STATIC_REDIRECTS)) {
		map.set(normalizePathKey(from), normalizeRedirectDestination(to));
	}

	return map;
}

/** Resolve cadeias A → B → C até URL final */
export function resolveRedirectDestination(pathKey, redirectMap, maxHops = 10) {
	let current = normalizePathKey(pathKey);
	let destination = null;

	for (let hop = 0; hop < maxHops; hop++) {
		const next = redirectMap.get(current);
		if (!next) break;
		destination = next;
		current = normalizePathKey(next);
	}

	return destination;
}
