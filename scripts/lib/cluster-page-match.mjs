/**
 * Espelha src/lib/cluster-page-match.ts — manter sincronizado ao alterar regras.
 * Usa matchPage de src/data/clusters.json.
 */
import clustersData from '../../src/data/clusters.json' with { type: 'json' };

export function matchesPagePath(path, match) {
	if (match.excludePrefixes?.some((prefix) => path.startsWith(prefix))) {
		return false;
	}

	if (
		match.excludeSlugPatterns?.some((pattern) =>
			path.toLowerCase().includes(pattern.toLowerCase()),
		)
	) {
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

export function pageBelongsToClusterId(path, clusterId) {
	const cluster = clustersData.clusters.find((entry) => entry.id === clusterId);
	if (!cluster || !path || path.startsWith('blog/')) return false;
	return matchesPagePath(path, cluster.matchPage);
}
