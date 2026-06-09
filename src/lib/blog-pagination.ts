import { BLOG_POSTS_PER_PAGE, getBlogPosts } from './wordpress';

export { BLOG_POSTS_PER_PAGE };

export function getBlogPostCount(): number {
	return getBlogPosts().length;
}

export function getBlogPageCount(): number {
	const total = getBlogPostCount();
	return Math.max(1, Math.ceil(total / BLOG_POSTS_PER_PAGE));
}

export function blogPagePath(page: number): string {
	if (page <= 1) return '/blog/';
	return `/blog/page/${page}/`;
}

export function parseBlogPageParam(value: string): number | null {
	const page = Number.parseInt(value, 10);
	if (!Number.isFinite(page) || page < 1) return null;
	return page;
}

export function getBlogPaginationHeadLinks(
	currentPage: number,
	totalPages: number,
	origin: string,
): { prev?: string; next?: string } {
	return {
		prev: currentPage > 1 ? new URL(blogPagePath(currentPage - 1), origin).href : undefined,
		next:
			currentPage < totalPages
				? new URL(blogPagePath(currentPage + 1), origin).href
				: undefined,
	};
}
