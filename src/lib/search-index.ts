import manifest from '../data/wp/manifest.json';
import site from '../data/site.json';
import { getAllClusters, isRegionalHubActive } from './clusters';
import { shouldNoindexPath } from './seo-policy';
import { getAllContentPaths } from './wordpress';
import type { WpManifest, WpManifestEntry } from '../types/wordpress';

export type SearchEntryKind = 'pagina' | 'artigo' | 'servico';

export interface SearchEntry {
	title: string;
	href: string;
	kind: SearchEntryKind;
}

function staticEntries(): SearchEntry[] {
	const entries: SearchEntry[] = [
		{ title: `${site.marca.nome} — Início`, href: '/', kind: 'pagina' },
		{ title: 'Serviços', href: '/servico/', kind: 'pagina' },
		{ title: 'Contato', href: '/contato/', kind: 'pagina' },
		{ title: 'Blog', href: '/blog/', kind: 'pagina' },
		{ title: 'Privacidade', href: '/privacidade/', kind: 'pagina' },
		{ title: 'Termos de uso', href: '/termos/', kind: 'pagina' },
	];

	for (const servico of site.servicos) {
		entries.push({
			title: servico.nome,
			href: `${servico.href}/`,
			kind: 'servico',
		});
	}

	for (const cluster of getAllClusters()) {
		entries.push({
			title: cluster.nome,
			href: `${cluster.pilar}/`,
			kind: 'servico',
		});
		if (isRegionalHubActive(cluster)) {
			entries.push({
				title: `${cluster.nome} por região`,
				href: `${cluster.hubRegioes}/`,
				kind: 'pagina',
			});
		}
		entries.push({
			title: cluster.blogHubTitulo,
			href: `${cluster.blogHub}/`,
			kind: 'pagina',
		});
	}

	return entries;
}

function entryKind(entry: WpManifestEntry, postPaths: Set<string>): SearchEntryKind {
	return postPaths.has(entry.path) ? 'artigo' : 'pagina';
}

export function buildSearchIndex(): SearchEntry[] {
	const data = manifest as WpManifest;
	const indexablePaths = new Set(getAllContentPaths());
	const postPaths = new Set(data.posts.map((entry) => entry.path));
	const entries = staticEntries();
	const seen = new Set(entries.map((entry) => entry.href));

	for (const entry of [...data.pages, ...data.posts]) {
		if (!indexablePaths.has(entry.path)) continue;
		if (shouldNoindexPath(entry.path)) continue;

		const href = entry.path ? `/${entry.path}/` : '/';
		if (seen.has(href)) continue;

		seen.add(href);
		entries.push({
			title: entry.seoTitle || entry.title,
			href,
			kind: entryKind(entry, postPaths),
		});
	}

	return entries;
}
