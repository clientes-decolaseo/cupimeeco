import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const WP_BASE = 'https://cupins.eco.br/d';
const API = `${WP_BASE}/wp-json/wp/v2`;
const OUT_DIR = path.resolve('src/data/wp');
const PER_PAGE = 100;
const DELAY_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripHtml(html = '') {
	return html
		.replace(/<[^>]+>/g, ' ')
		.replace(/&hellip;|&#8230;/g, '…')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractPath(link) {
	const prefix = `${WP_BASE}/`;
	if (!link.startsWith(prefix)) return link;

	const relative = link.slice(prefix.length).replace(/\/+$/, '');
	return relative;
}

const SITE_ORIGIN = 'https://cupins.eco.br';

function normalizeSiteUrl(url = '') {
	if (!url) return url;

	return url
		.replace(/https?:\/\/cupim\.eco\.br\/d\//gi, `${SITE_ORIGIN}/`)
		.replace(/https?:\/\/cupim\.eco\.br\/d$/gi, SITE_ORIGIN);
}

function normalizeHtml(html = '') {
	return html
		.replace(/https?:\/\/cupim\.eco\.br\/d\//gi, `${SITE_ORIGIN}/`)
		.replace(/href="\/d\//gi, 'href="/')
		.replace(/href='\/d\//gi, "href='/");
}

function pathToCanonical(itemPath) {
	const clean = itemPath.replace(/^\/+|\/+$/g, '');
	return clean ? `${SITE_ORIGIN}/${clean}/` : `${SITE_ORIGIN}/`;
}

function mapSeo(yoast = {}, itemPath = '') {
	const ogImage = yoast.og_image?.[0]?.url ?? '';
	const canonical =
		normalizeSiteUrl(yoast.canonical ?? '') || pathToCanonical(itemPath);

	return {
		title: yoast.title ?? '',
		description: yoast.description ?? '',
		canonical,
		ogImage,
		robots: yoast.robots?.index === 'noindex',
	};
}

function mapItem(item, type) {
	const yoast = item.yoast_head_json ?? {};
	const itemPath = extractPath(item.link);

	return {
		id: item.id,
		type,
		slug: item.slug,
		path: itemPath,
		title: stripHtml(item.title?.rendered ?? ''),
		excerpt: stripHtml(item.excerpt?.rendered ?? ''),
		content: normalizeHtml(item.content?.rendered ?? ''),
		date: item.date,
		modified: item.modified,
		link: normalizeSiteUrl(item.link) || pathToCanonical(itemPath),
		parent: item.parent ?? 0,
		featuredMedia: item.featured_media ?? 0,
		categories: item.categories ?? [],
		tags: item.tags ?? [],
		seo: mapSeo(yoast, itemPath),
	};
}

async function fetchPage(url, retries = 3) {
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const response = await fetch(url);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ao buscar ${url}`);
			}

			const total = Number(response.headers.get('x-wp-total') ?? 0);
			const totalPages = Number(response.headers.get('x-wp-totalpages') ?? 0);
			const data = await response.json();

			return { data, total, totalPages };
		} catch (error) {
			if (attempt === retries) throw error;
			await sleep(DELAY_MS * attempt * 2);
		}
	}

	throw new Error(`Falha ao buscar ${url}`);
}

async function fetchAll(endpoint, type) {
	const firstUrl = `${API}/${endpoint}?per_page=${PER_PAGE}&page=1&status=publish&_fields=id,slug,link,title,content,excerpt,date,modified,parent,featured_media,categories,tags,yoast_head_json`;
	const first = await fetchPage(firstUrl);
	const allItems = [...first.data];

	console.log(`→ ${type}: ${first.total} itens (${first.totalPages} páginas na API)`);

	for (let page = 2; page <= first.totalPages; page++) {
		await sleep(DELAY_MS);
		const url = `${API}/${endpoint}?per_page=${PER_PAGE}&page=${page}&status=publish&_fields=id,slug,link,title,content,excerpt,date,modified,parent,featured_media,categories,tags,yoast_head_json`;
		const { data } = await fetchPage(url);
		allItems.push(...data);
		console.log(`  ✓ ${type} página ${page}/${first.totalPages}`);
	}

	return allItems.map((item) => mapItem(item, type));
}

async function saveJson(filePath, data) {
	await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
	console.log('Iniciando importação WordPress → Astro');
	console.log(`Origem: ${WP_BASE}`);

	await mkdir(path.join(OUT_DIR, 'pages'), { recursive: true });
	await mkdir(path.join(OUT_DIR, 'posts'), { recursive: true });

	const [pages, posts] = await Promise.all([
		fetchAll('pages', 'page'),
		fetchAll('posts', 'post'),
	]);

	const pathsSeen = new Set();
	const duplicates = [];

	for (const item of [...pages, ...posts]) {
		if (pathsSeen.has(item.path)) {
			duplicates.push(item);
		} else {
			pathsSeen.add(item.path);
		}
	}

	if (duplicates.length > 0) {
		console.warn(`⚠ ${duplicates.length} paths duplicados detectados (mantendo o primeiro)`);
	}

	const uniquePages = [];
	const uniquePosts = [];
	const usedPaths = new Set();

	for (const item of pages) {
		if (usedPaths.has(item.path)) continue;
		usedPaths.add(item.path);
		uniquePages.push(item);
	}

	for (const item of posts) {
		if (usedPaths.has(item.path)) continue;
		usedPaths.add(item.path);
		uniquePosts.push(item);
	}

	for (const item of uniquePages) {
		await saveJson(path.join(OUT_DIR, 'pages', `${item.id}.json`), item);
	}

	for (const item of uniquePosts) {
		await saveJson(path.join(OUT_DIR, 'posts', `${item.id}.json`), item);
	}

	const manifest = {
		importedAt: new Date().toISOString(),
		source: WP_BASE,
		totals: {
			pages: uniquePages.length,
			posts: uniquePosts.length,
		},
		pages: uniquePages.map(({ id, slug, path: itemPath, title, modified, link, seo }) => ({
			id,
			slug,
			path: itemPath,
			title,
			modified,
			link,
			seoTitle: seo.title,
		})),
		posts: uniquePosts.map(({ id, slug, path: itemPath, title, modified, link, seo }) => ({
			id,
			slug,
			path: itemPath,
			title,
			modified,
			link,
			seoTitle: seo.title,
		})),
	};

	await saveJson(path.join(OUT_DIR, 'manifest.json'), manifest);

	console.log('\nImportação concluída!');
	console.log(`  Páginas: ${uniquePages.length}`);
	console.log(`  Posts:   ${uniquePosts.length}`);
	console.log(`  Total:   ${uniquePages.length + uniquePosts.length}`);
	console.log(`  Manifest: src/data/wp/manifest.json`);
}

main().catch((error) => {
	console.error('Erro na importação:', error);
	process.exit(1);
});
