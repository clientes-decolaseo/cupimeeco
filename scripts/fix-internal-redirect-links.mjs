import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildRedirectMap } from './lib/redirect-map.mjs';
import { rewriteHrefValue, rewriteRedirectLinksInText } from './lib/rewrite-redirect-links.mjs';

const WP_DIR = path.resolve('src/data/wp');

function rewriteUrlField(url, redirectMap) {
	if (!url) return { value: url, changed: false };

	const { href, changed } = rewriteHrefValue(url, redirectMap);
	return { value: href, changed };
}

function rewriteItem(data, redirectMap) {
	let replacements = 0;
	const next = { ...data };

	if (data.content) {
		const { text, replacements: n } = rewriteRedirectLinksInText(data.content, redirectMap);
		next.content = text;
		replacements += n;
	}

	if (data.excerpt) {
		const { text, replacements: n } = rewriteRedirectLinksInText(data.excerpt, redirectMap);
		next.excerpt = text;
		replacements += n;
	}

	if (data.link) {
		const { value, changed } = rewriteUrlField(data.link, redirectMap);
		if (changed) {
			next.link = value;
			replacements++;
		}
	}

	if (data.seo?.canonical) {
		const { value, changed } = rewriteUrlField(data.seo.canonical, redirectMap);
		if (changed) {
			next.seo = { ...data.seo, canonical: value };
			replacements++;
		}
	}

	return { data: next, replacements };
}

async function processDir(subdir, redirectMap) {
	const dir = path.join(WP_DIR, subdir);
	const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
	let filesUpdated = 0;
	let totalReplacements = 0;

	for (const file of files) {
		const filePath = path.join(dir, file);
		const raw = await readFile(filePath, 'utf8');
		const data = JSON.parse(raw);
		const { data: rewritten, replacements } = rewriteItem(data, redirectMap);

		if (replacements === 0) continue;

		await writeFile(filePath, `${JSON.stringify(rewritten, null, 2)}\n`);
		filesUpdated++;
		totalReplacements += replacements;
	}

	return { filesUpdated, totalReplacements };
}

const redirectMap = buildRedirectMap();
console.log(`Mapa de redirects: ${redirectMap.size} rotas\n`);

const pages = await processDir('pages', redirectMap);
const posts = await processDir('posts', redirectMap);

console.log(
	`Páginas: ${pages.filesUpdated} arquivos, ${pages.totalReplacements} links corrigidos`,
);
console.log(
	`Posts: ${posts.filesUpdated} arquivos, ${posts.totalReplacements} links corrigidos`,
);
console.log(
	`\nTotal: ${pages.filesUpdated + posts.filesUpdated} arquivos, ${pages.totalReplacements + posts.totalReplacements} links`,
);
