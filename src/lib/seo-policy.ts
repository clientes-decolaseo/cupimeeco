import cupimPolicy from '../data/seo/cupim-policy.json';
import dedetizacaoPolicy from '../data/seo/dedetizacao-policy.json';
import deratizacaoPolicy from '../data/seo/deratizacao-policy.json';
import foraAreaPolicy from '../data/seo/fora-area-policy.json';
import duplicatesPolicy from '../data/seo/duplicates-policy.json';
import sanitizacaoPolicy from '../data/seo/sanitizacao-policy.json';
import mosquitosPolicy from '../data/seo/mosquitos-policy.json';
import cidadesRedirectsJson from '../../scripts/redirects-cidades.json';

export interface SeoPolicyResult {
	redirectTo?: string;
	noindex: boolean;
}

interface ClusterPolicyFile {
	redirects: Record<string, string>;
	noindex: string[];
	stats?: Record<string, number>;
}

const POLICIES: ClusterPolicyFile[] = [
	cupimPolicy,
	dedetizacaoPolicy,
	deratizacaoPolicy,
	sanitizacaoPolicy,
	mosquitosPolicy,
	foraAreaPolicy,
	duplicatesPolicy,
];

const redirects: Record<string, string> = {};
const redirectsByKey = new Map<string, string>();
const noindexPaths = new Set<string>();
const redirectSources = new Set<string>();

function normalizePathKey(itemPath: string): string {
	return itemPath.replace(/^\/+|\/+$/g, '').toLowerCase();
}

function normalizeDestination(destination: string): string {
	return destination.endsWith('/') ? destination : `${destination}/`;
}

for (const policy of POLICIES) {
	for (const [from, to] of Object.entries(policy.redirects)) {
		redirects[from] = to;
		redirectsByKey.set(normalizePathKey(from), to);
		redirectSources.add(from);
	}

	for (const path of policy.noindex ?? []) {
		noindexPaths.add(path);
	}
}

// 301 de cidades (scripts/redirects-cidades.json) — exclui path da geração estática
for (const [from, to] of Object.entries(cidadesRedirectsJson as Record<string, unknown>)) {
	if (from === '_meta' || from.startsWith('_')) continue;
	if (typeof to !== 'string') continue;
	const source = normalizePathKey(from);
	if (!source) continue;
	if (!redirectsByKey.has(source)) {
		redirects[source] = to;
		redirectsByKey.set(source, to);
		redirectSources.add(source);
	}
}

export function getSeoPolicyStats() {
	return {
		redirects: redirectSources.size,
		noindex: noindexPaths.size,
		clusters: {
			descupinizacao: cupimPolicy.stats,
			dedetizacao: dedetizacaoPolicy.stats,
			deratizacao: deratizacaoPolicy.stats,
			sanitizacao: sanitizacaoPolicy.stats,
			mosquitos: mosquitosPolicy.stats,
		},
	};
}

export function isRedirectedPath(itemPath: string): boolean {
	return redirectSources.has(itemPath) || redirectsByKey.has(normalizePathKey(itemPath));
}

export function getRedirectDestination(itemPath: string): string | undefined {
	const key = normalizePathKey(itemPath);
	let destination = redirects[itemPath] ?? redirectsByKey.get(key);

	if (!destination && key.endsWith('/embed')) {
		destination = redirectsByKey.get(key.replace(/\/embed$/, ''));
	}

	if (!destination) return undefined;

	return normalizeDestination(destination);
}

export function shouldNoindexPath(itemPath: string, wpRobotsNoindex = false): boolean {
	return wpRobotsNoindex || noindexPaths.has(itemPath);
}

export function getSeoPolicy(itemPath: string, wpRobotsNoindex = false): SeoPolicyResult {
	const redirectTo = getRedirectDestination(itemPath);

	return {
		redirectTo,
		noindex: !redirectTo && shouldNoindexPath(itemPath, wpRobotsNoindex),
	};
}

export function getAllRedirectsForConfig(): Record<string, { status: 301; destination: string }> {
	const entries: Record<string, { status: 301; destination: string }> = {};

	for (const [from, to] of Object.entries(redirects)) {
		const destination = to.replace(/\/+$/, '') || '/';
		entries[`/${from}`] = { status: 301, destination };
	}

	return entries;
}

export function getAllRedirectSources(): Set<string> {
	return redirectSources;
}

export function getAllNoindexPaths(): Set<string> {
	return noindexPaths;
}
