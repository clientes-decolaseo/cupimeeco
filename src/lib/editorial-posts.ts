import type { WpContent, WpManifestEntry } from '../types/wordpress';

const editorialModules = import.meta.glob<{ default: WpContent }>(
	'../data/editorial/posts/*.json',
	{ eager: true },
);

const editorialByPath = new Map<string, WpContent>();
const editorialById = new Map<number, WpContent>();

for (const module of Object.values(editorialModules)) {
	const post = module.default;
	editorialByPath.set(post.path, post);
	editorialById.set(post.id, post);
}

export function getEditorialPosts(): WpContent[] {
	return [...editorialByPath.values()];
}

export function getEditorialManifestEntries(): WpManifestEntry[] {
	return getEditorialPosts().map((post) => ({
		id: post.id,
		slug: post.slug,
		path: post.path,
		title: post.title,
		modified: post.modified,
		link: post.link,
		seoTitle: post.seo.title || post.title,
	}));
}

export function findEditorialByPath(itemPath: string): WpContent | undefined {
	return editorialByPath.get(itemPath);
}

export function loadEditorialById(id: number): WpContent | undefined {
	return editorialById.get(id);
}

export function isEditorialPostId(id: number): boolean {
	return editorialById.has(id);
}
