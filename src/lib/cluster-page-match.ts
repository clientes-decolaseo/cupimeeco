import type { ClusterPageMatch } from '../types/cluster';

/** Regras compartilhadas com scripts/lib/cluster-page-match.mjs e audit:seo */
export function matchesPagePath(path: string, match: ClusterPageMatch): boolean {
	if (match.excludePrefixes?.some((prefix) => path.startsWith(prefix))) {
		return false;
	}

	if (match.excludeSlugPatterns?.some((pattern) => path.toLowerCase().includes(pattern.toLowerCase()))) {
		return false;
	}

	if (match.prefixes?.some((prefix) => path.startsWith(prefix))) {
		return true;
	}

	if (match.pathIncludes?.some((fragment) => path.includes(fragment))) {
		return true;
	}

	if (match.slugPatterns?.some((pattern) => new RegExp(pattern, 'i').test(path))) {
		return true;
	}

	if (match.anyPrefix && path.startsWith(match.anyPrefix)) {
		return true;
	}

	return false;
}
