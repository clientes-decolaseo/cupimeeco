import cupimPolicy from '../data/seo/cupim-policy.json';
import dedetizacaoPolicy from '../data/seo/dedetizacao-policy.json';
import deratizacaoPolicy from '../data/seo/deratizacao-policy.json';
import foraAreaPolicy from '../data/seo/fora-area-policy.json';
import duplicatesPolicy from '../data/seo/duplicates-policy.json';
import sanitizacaoPolicy from '../data/seo/sanitizacao-policy.json';
import mosquitosPolicy from '../data/seo/mosquitos-policy.json';

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
const noindexPaths = new Set<string>();
const redirectSources = new Set<string>();

for (const policy of POLICIES) {
	for (const [from, to] of Object.entries(policy.redirects)) {
		redirects[from] = to;
		redirectSources.add(from);
	}

	for (const path of policy.noindex ?? []) {
		noindexPaths.add(path);
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
	return redirectSources.has(itemPath);
}

export function getRedirectDestination(itemPath: string): string | undefined {
	const destination = redirects[itemPath];
	if (!destination) return undefined;

	return destination.endsWith('/') ? destination : `${destination}/`;
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
