import cupimPolicy from '../../src/data/seo/cupim-policy.json' with { type: 'json' };
import dedetizacaoPolicy from '../../src/data/seo/dedetizacao-policy.json' with { type: 'json' };
import deratizacaoPolicy from '../../src/data/seo/deratizacao-policy.json' with { type: 'json' };
import sanitizacaoPolicy from '../../src/data/seo/sanitizacao-policy.json' with { type: 'json' };
import mosquitosPolicy from '../../src/data/seo/mosquitos-policy.json' with { type: 'json' };
import foraAreaPolicy from '../../src/data/seo/fora-area-policy.json' with { type: 'json' };
import duplicatesPolicy from '../../src/data/seo/duplicates-policy.json' with { type: 'json' };

const POLICY_FILES = [
	cupimPolicy,
	dedetizacaoPolicy,
	deratizacaoPolicy,
	sanitizacaoPolicy,
	mosquitosPolicy,
	foraAreaPolicy,
	duplicatesPolicy,
];

/** Redirects estáticos do astro.config.mjs (fora dos JSON de cluster) */
const STATIC_REDIRECTS = {
	desratizacao: '/deratizacao/',
	fotos: '/',
	'biblioteca-da-universo': '/blog/',
	'glossario-tudo-sobre-descupinizacao': '/blog/',
	'dedetizacao-de-cupins': '/descupinizacao/',
	'dedetizadora-de-cupim': '/descupinizacao/',
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
	return withSlash.endsWith('/') ? withSlash : `${withSlash}/`;
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

			if (map.has(key) && map.get(key) !== destination) {
				// Política de cluster prevalece sobre redirect estático duplicado
			}

			map.set(key, destination);
		}
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
