import type { BlogPostSummary, WpContent, WpManifest, WpManifestEntry } from '../types/wordpress';
import type { ClusterConfig } from '../types/cluster';
import manifest from '../data/wp/manifest.json';
import {
	getClusterForPath,
	getClusterPosts,
	pageBelongsToCluster,
	postBelongsToCluster,
} from './clusters';
import { isRedirectedPath } from './seo-policy';
import { isExcludedFromWpCatchAll } from './static-routes';
import { normalizeBrandText, normalizeSiteUrl, normalizeWpHtml, pathToCanonical } from './wp-urls';

const pageModules = import.meta.glob<{ default: WpContent }>('../data/wp/pages/*.json');
const postModules = import.meta.glob<{ default: WpContent }>('../data/wp/posts/*.json');

export const BLOG_POSTS_PER_PAGE = 12;

export function getManifest(): WpManifest {
	return manifest as WpManifest;
}

export function findByPath(itemPath: string): {
	type: 'page' | 'post';
	entry: WpManifestEntry;
} | undefined {
	const data = getManifest();
	const page = data.pages.find((entry) => entry.path === itemPath);

	if (page) return { type: 'page', entry: page };

	const post = data.posts.find((entry) => entry.path === itemPath);

	if (post) return { type: 'post', entry: post };

	return undefined;
}

export function getHomePage(): WpManifestEntry | undefined {
	return getManifest().pages.find((entry) => entry.path === '');
}

export function getAllContentPaths(): string[] {
	const data = getManifest();

	return [...data.pages, ...data.posts]
		.map((entry) => entry.path)
		.filter(
			(itemPath) =>
				itemPath && !isExcludedFromWpCatchAll(itemPath) && !isRedirectedPath(itemPath),
		);
}

export function getBlogPosts(): WpManifestEntry[] {
	return [...getManifest().posts].sort(
		(a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime(),
	);
}

export function postUrl(path: string): string {
	return `/${path}/`;
}

export function normalizeWpContent(content: WpContent): WpContent {
	const canonical =
		normalizeSiteUrl(content.seo.canonical) ||
		pathToCanonical(content.path);

	return {
		...content,
		title: normalizeBrandText(content.title),
		excerpt: normalizeBrandText(content.excerpt),
		link: normalizeSiteUrl(content.link) || pathToCanonical(content.path),
		content: normalizeBrandText(normalizeWpHtml(content.content)),
		seo: {
			...content.seo,
			title: normalizeBrandText(content.seo.title || content.title),
			description: normalizeBrandText(content.seo.description),
			canonical,
		},
	};
}

export interface RelatedContentItem {
	id: number;
	path: string;
	title: string;
	excerpt: string;
	type: 'page' | 'post';
	/** Rótulo exibido no card (ex.: nome da cidade) */
	tipoLabel?: string;
}

export async function getRelatedContent(
	currentPath: string,
	limit = 4,
): Promise<RelatedContentItem[]> {
	const cluster = getClusterForPath(currentPath);
	const data = getManifest();
	const candidates: WpManifestEntry[] = [];

		if (cluster) {
			candidates.push(
				...data.posts.filter(
					(entry) =>
						entry.path !== currentPath &&
						!isRedirectedPath(entry.path) &&
						postBelongsToCluster(entry.path, cluster),
				),
			);

		if (currentPath.startsWith('blog/')) {
			candidates.push(
				...data.pages
					.filter(
						(entry) =>
							entry.path !== currentPath &&
							entry.path.length > 0 &&
							!isRedirectedPath(entry.path) &&
							pageBelongsToCluster(entry.path, cluster),
					)
					.slice(0, 2),
			);
		}
	} else {
		const slugPart = currentPath.split('/').pop() ?? '';

		candidates.push(
			...data.posts.filter((entry) => {
				if (entry.path === currentPath) return false;
				return entry.path.includes(slugPart.slice(0, 8));
			}),
		);
	}

	const unique = new Map<number, WpManifestEntry>();

	for (const entry of candidates) {
		if (!unique.has(entry.id)) unique.set(entry.id, entry);
	}

	const sorted = [...unique.values()].slice(0, limit);

	return Promise.all(
		sorted.map(async (entry) => {
			const type = data.posts.some((post) => post.id === entry.id) ? 'post' : 'page';
			const content = await loadContentById(type, entry.id);

			return {
				id: entry.id,
				path: entry.path,
				title: content.title,
				excerpt: formatExcerpt(content.excerpt || content.seo.description),
				type,
			};
		}),
	);
}

export async function getFeaturedPostsForCluster(
	cluster: ClusterConfig,
	limit = 3,
): Promise<RelatedContentItem[]> {
	const entries = getClusterPosts(cluster.id).slice(0, limit);

	return Promise.all(
		entries.map(async (entry) => {
			const content = await loadContentById('post', entry.id);

			return {
				id: entry.id,
				path: entry.path,
				title: content.title,
				excerpt: formatExcerpt(content.excerpt || content.seo.description),
				type: 'post' as const,
			};
		}),
	);
}

function decodeHtmlEntities(text: string): string {
	const named: Record<string, string> = {
		'&amp;': '&',
		'&quot;': '"',
		'&apos;': "'",
		'&lt;': '<',
		'&gt;': '>',
		'&nbsp;': ' ',
		'&hellip;': '…',
	};

	let decoded = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
	decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
		String.fromCharCode(parseInt(code, 16)),
	);

	for (const [entity, char] of Object.entries(named)) {
		decoded = decoded.replaceAll(entity, char);
	}

	return decoded;
}

function formatExcerpt(text: string, maxLength = 160): string {
	const clean = decodeHtmlEntities(text)
		.replace(/\[\s*…\s*\]|\[\s*\.\.\.\s*\]/g, '')
		.trim();

	if (!clean) return '';

	if (clean.length <= maxLength) return clean;

	return `${clean.slice(0, maxLength).replace(/\s+\S*$/, '')}…`;
}

async function entryToBlogSummary(entry: WpManifestEntry): Promise<BlogPostSummary> {
	const content = await loadContentById('post', entry.id);

	return {
		id: entry.id,
		path: entry.path,
		title: content.title,
		modified: entry.modified,
		excerpt: formatExcerpt(content.excerpt || content.seo.description),
		image: content.seo.ogImage || '',
		imageAlt: content.title,
	};
}

export async function getBlogPostsSummary(): Promise<BlogPostSummary[]> {
	const entries = getBlogPosts();
	return Promise.all(entries.map(entryToBlogSummary));
}

export async function getBlogPostsSummaryPage(page: number): Promise<BlogPostSummary[]> {
	const entries = getBlogPosts();
	const start = (page - 1) * BLOG_POSTS_PER_PAGE;

	return Promise.all(
		entries.slice(start, start + BLOG_POSTS_PER_PAGE).map(entryToBlogSummary),
	);
}

export async function getBlogPostsSummaryForCluster(clusterId: string): Promise<BlogPostSummary[]> {
	const entries = getClusterPosts(clusterId);
	return Promise.all(entries.map(entryToBlogSummary));
}

export async function loadContentById(
	type: 'page' | 'post',
	id: number,
): Promise<WpContent> {
	const modules = type === 'page' ? pageModules : postModules;
	const key = `../data/wp/${type === 'page' ? 'pages' : 'posts'}/${id}.json`;
	const loader = modules[key];

	if (!loader) {
		throw new Error(`Conteúdo não encontrado: ${type}/${id}`);
	}

	const module = await loader();
	return normalizeWpContent(module.default);
}
