import clustersData from '../data/clusters.json';
import type { BreadcrumbItem, ClusterConfig, ClusterManifestEntry } from '../types/cluster';
import type { WpManifestEntry } from '../types/wordpress';
import { isPageInServiceArea } from './area-atendida';
import { matchesPagePath } from './cluster-page-match';
import { isRedirectedPath } from './seo-policy';
import { getManifest } from './wordpress';

const clusters = clustersData.clusters as ClusterConfig[];

export function getAllClusters(): ClusterConfig[] {
	return clusters;
}

export function isRegionalHubActive(cluster: ClusterConfig): boolean {
	return cluster.hubRegioesAtivo !== false;
}

export function getClustersWithRegionalHub(): ClusterConfig[] {
	return clusters.filter(isRegionalHubActive);
}

export function getClusterById(id: string): ClusterConfig | undefined {
	return clusters.find((cluster) => cluster.id === id);
}

export function getClusterByPilarPath(pilarPath: string): ClusterConfig | undefined {
	const normalized = pilarPath.replace(/\/+$/, '');
	return clusters.find((cluster) => cluster.pilar === normalized);
}

function pageMatchesCluster(path: string, cluster: ClusterConfig): boolean {
	if (!path || path.startsWith('blog/')) return false;
	return matchesPagePath(path, cluster.matchPage);
}

/** @deprecated Use matchesPagePath via pageBelongsToCluster */
export function isCupimLegacyPath(path: string): boolean {
	const cupim = clusters.find((cluster) => cluster.id === 'descupinizacao');
	return cupim ? pageMatchesCluster(path, cupim) : false;
}

/** Slug do hub editorial: `/blog/cupins` → `cupins` */
export function getBlogTopicFromHub(blogHub: string): string | null {
	const match = blogHub.match(/^\/blog\/([^/]+)$/);
	return match?.[1] ?? null;
}

export function getClustersWithBlogHub(): ClusterConfig[] {
	return clusters.filter((cluster) => getBlogTopicFromHub(cluster.blogHub) !== null);
}

export function pageBelongsToCluster(path: string, cluster: ClusterConfig): boolean {
	return pageMatchesCluster(path, cluster);
}

export function postBelongsToCluster(path: string, cluster: ClusterConfig): boolean {
	if (!path.startsWith('blog/')) return false;

	const slug = path.slice('blog/'.length).toLowerCase();
	return cluster.blogSlugIncludes.some((term) => slug.includes(term));
}

export function getClusterForPath(path: string): ClusterConfig | undefined {
	return clusters.find(
		(cluster) => pageBelongsToCluster(path, cluster) || postBelongsToCluster(path, cluster),
	);
}

export function getClusterPages(clusterId: string): ClusterManifestEntry[] {
	const cluster = getClusterById(clusterId);
	if (!cluster) return [];

	return getManifest()
		.pages.filter(
			(entry) =>
				entry.path &&
				!isRedirectedPath(entry.path) &&
				pageBelongsToCluster(entry.path, cluster) &&
				isPageInServiceArea({ path: entry.path, title: entry.title }),
		)
		.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'))
		.map((entry) => ({
			id: entry.id,
			path: entry.path,
			title: entry.title,
			modified: entry.modified,
		}));
}

export function getClusterPosts(clusterId: string): WpManifestEntry[] {
	const cluster = getClusterById(clusterId);
	if (!cluster) return [];

	return getManifest()
		.posts.filter((entry) => postBelongsToCluster(entry.path, cluster))
		.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
}

export function getClusterByBlogTopic(topic: string): ClusterConfig | undefined {
	return clusters.find((cluster) => cluster.blogHub === `/blog/${topic}`);
}

export function buildBreadcrumbs(items: BreadcrumbItem[]): BreadcrumbItem[] {
	return [{ label: 'Início', href: '/' }, ...items];
}

export function breadcrumbsForClusterHub(cluster: ClusterConfig): BreadcrumbItem[] {
	return buildBreadcrumbs([
		{ label: 'Serviços', href: '/servico' },
		{ label: cluster.nome, href: cluster.pilar },
		{ label: 'Regiões atendidas' },
	]);
}

export function breadcrumbsForBlogTopic(cluster: ClusterConfig): BreadcrumbItem[] {
	return buildBreadcrumbs([
		{ label: 'Blog', href: '/blog' },
		{ label: cluster.blogHubTitulo },
	]);
}

export function breadcrumbsForService(cluster: ClusterConfig): BreadcrumbItem[] {
	return buildBreadcrumbs([
		{ label: 'Serviços', href: '/servico' },
		{ label: cluster.nome },
	]);
}

export function breadcrumbsForWpContent(
	path: string,
	title: string,
	type: 'page' | 'post',
): BreadcrumbItem[] {
	const cluster = getClusterForPath(path);
	const items: BreadcrumbItem[] = [];

	if (type === 'post') {
		items.push({ label: 'Blog', href: '/blog' });

		if (cluster) {
			items.push({
				label: cluster.blogHubTitulo,
				href: cluster.blogHub,
			});
		}
	} else if (cluster) {
		items.push({ label: 'Serviços', href: '/servico' });
		items.push({ label: cluster.nome, href: cluster.pilar });
		if (isRegionalHubActive(cluster)) {
			items.push({ label: 'Regiões atendidas', href: cluster.hubRegioes });
		}
	}

	items.push({ label: title });
	return buildBreadcrumbs(items);
}
