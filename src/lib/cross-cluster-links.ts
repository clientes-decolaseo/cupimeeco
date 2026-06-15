import type { ClusterManifestEntry } from '../types/cluster';
import { resolveCityFromPage } from './area-atendida';
import { getClusterPreferPathScore } from './cluster-prefer-path';
import {
	getAllClusters,
	getClusterById,
	getClusterForPath,
	getClusterPages,
	pageBelongsToCluster,
} from './clusters';

export interface CrossClusterServiceLink {
	clusterId: string;
	servico: string;
	cidade: string;
	href: string;
	label: string;
	pageTitle: string;
}

function preferPathScore(clusterId: string, path: string): number {
	return getClusterPreferPathScore(clusterId, path);
}

function pickCanonicalPage(
	entries: ClusterManifestEntry[],
	clusterId: string,
): ClusterManifestEntry | undefined {
	if (entries.length === 0) return undefined;

	return [...entries].sort((a, b) => {
		const score = (path: string) => {
			let value = preferPathScore(clusterId, path);
			if (/-\d+$/.test(path)) value += 10;
			if (path.includes('/')) value += 8;
			return value;
		};

		const diff = score(a.path) - score(b.path);
		if (diff !== 0) return diff;

		return new Date(b.modified).getTime() - new Date(a.modified).getTime();
	})[0];
}

function findCanonicalPageForCity(clusterId: string, cityId: string): ClusterManifestEntry | undefined {
	const cluster = getClusterById(clusterId);
	if (!cluster) return undefined;

	const cityPages = getClusterPages(clusterId).filter((page) => {
		const city = resolveCityFromPage(page);
		return city.atendida && city.id === cityId;
	});

	return pickCanonicalPage(cityPages, clusterId);
}

export function getCrossClusterServiceLinks(path: string, title: string): CrossClusterServiceLink[] {
	const cluster = getClusterForPath(path);
	if (!cluster || !pageBelongsToCluster(path, cluster)) return [];

	const city = resolveCityFromPage({ path, title });
	if (!city.atendida) return [];

	const links: CrossClusterServiceLink[] = [];

	for (const other of getAllClusters()) {
		if (other.id === cluster.id) continue;

		const canonical = findCanonicalPageForCity(other.id, city.id);
		if (!canonical || canonical.path === path) continue;

		links.push({
			clusterId: other.id,
			servico: other.nome,
			cidade: city.nome,
			href: `/${canonical.path}/`,
			label: `${other.nome} em ${city.nome}`,
			pageTitle: canonical.title,
		});
	}

	return links;
}
