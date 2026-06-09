import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeBrandDeep, normalizeBrandText } from './lib/brand-normalize.mjs';
import {
	getRedirectMap,
	rewriteHrefValue,
	rewriteRedirectLinksInText,
} from './lib/rewrite-redirect-links.mjs';

const WP_DIR = path.resolve('src/data/wp');
const redirectMap = getRedirectMap();
const MANIFEST_PATH = path.join(WP_DIR, 'manifest.json');
const SITE_ORIGIN = 'https://cupim.eco.br';

function normalizeSiteUrl(url = '') {
	if (!url) return url;

	return url
		.replace(/https?:\/\/cupim\.eco\.br\/d\//gi, `${SITE_ORIGIN}/`)
		.replace(/https?:\/\/cupim\.eco\.br\/d$/gi, SITE_ORIGIN)
		.replace(/\/d\//g, '/');
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

function normalizeItem(data) {
	let canonical = normalizeSiteUrl(data.seo?.canonical) || pathToCanonical(data.path);
	let link = normalizeSiteUrl(data.link) || pathToCanonical(data.path);

	const canonicalRewrite = rewriteHrefValue(canonical, redirectMap);
	if (canonicalRewrite.changed) canonical = canonicalRewrite.href;

	const linkRewrite = rewriteHrefValue(link, redirectMap);
	if (linkRewrite.changed) link = linkRewrite.href;

	return {
		...data,
		title: normalizeBrandText(data.title),
		excerpt: normalizeBrandText(normalizeHtml(data.excerpt)),
		link,
		content: normalizeBrandText(normalizeHtml(data.content)),
		seo: {
			...data.seo,
			title: normalizeBrandText(data.seo?.title || data.title),
			description: normalizeBrandText(data.seo?.description),
			canonical,
		},
	};
}

async function processManifest() {
	const filePath = MANIFEST_PATH;
	const raw = await readFile(filePath, 'utf8');
	const data = JSON.parse(raw);
	const normalized = normalizeBrandDeep(data);
	const output = `${JSON.stringify(normalized, null, 2)}\n`;

	if (output !== raw) {
		await writeFile(filePath, output);
		return 1;
	}

	return 0;
}

async function processDir(subdir) {
	const dir = path.join(WP_DIR, subdir);
	const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
	let updated = 0;

	for (const file of files) {
		const filePath = path.join(dir, file);
		const raw = await readFile(filePath, 'utf8');
		const data = JSON.parse(raw);
		const normalized = normalizeItem(data);
		const output = `${JSON.stringify(normalized, null, 2)}\n`;

		if (output !== raw) {
			await writeFile(filePath, output);
			updated++;
		}
	}

	return updated;
}

const pagesUpdated = await processDir('pages');
const postsUpdated = await processDir('posts');
const manifestUpdated = await processManifest();

console.log(
	`Normalizado: ${pagesUpdated} páginas, ${postsUpdated} posts, manifest ${manifestUpdated ? 'atualizado' : 'sem alteração'}.`,
);
