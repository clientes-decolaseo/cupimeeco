import { compareCityOrder, resolveCityFromPage } from './area-atendida';
import { getClusterForPath, getClusterPages } from './clusters';
import { findByPath, type RelatedContentItem } from './wordpress';

function stripExcerpt(text: string, maxLength = 140): string {
	const clean = text
		.replace(/<[^>]+>/g, ' ')
		.replace(/\[\s*…\s*\]|\[\s*\.\.\.\s*\]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

	if (!clean) return '';
	if (clean.length <= maxLength) return clean;

	return `${clean.slice(0, maxLength).replace(/\s+\S*$/, '')}…`;
}

/** Páginas locais do mesmo cluster — prioriza mesma cidade, depois mesma região. */
export function getRelatedClusterPages(
	currentPath: string,
	currentTitle: string,
	limit = 4,
): RelatedContentItem[] {
	const cluster = getClusterForPath(currentPath);
	if (!cluster || currentPath.startsWith('blog/')) return [];

	const currentCity = resolveCityFromPage({ path: currentPath, title: currentTitle });
	const pages = getClusterPages(cluster.id).filter((page) => page.path !== currentPath);

	if (pages.length === 0) return [];

	const scored = pages.map((page) => {
		const city = resolveCityFromPage({ path: page.path, title: page.title });
		let priority = 2;

		if (currentCity.atendida && city.id === currentCity.id) {
			priority = 0;
		} else if (currentCity.atendida && city.regiaoId === currentCity.regiaoId) {
			priority = 1;
		}

		return { page, city, priority };
	});

	scored.sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		const byCity = compareCityOrder(a.city.id, b.city.id);
		if (byCity !== 0) return byCity;
		return a.page.title.localeCompare(b.page.title, 'pt-BR');
	});

	return scored.slice(0, limit).map(({ page, city }) => {
		const manifestEntry = findByPath(page.path);
		const excerpt = manifestEntry?.entry.excerpt ?? '';

		return {
			id: page.id,
			path: page.path,
			title: page.title,
			excerpt: stripExcerpt(excerpt),
			type: 'page' as const,
			tipoLabel: city.atendida ? city.nome : 'Localidade',
		};
	});
}
