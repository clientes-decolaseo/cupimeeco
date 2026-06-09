import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shortenSeoTitle } from './lib/truncate-seo.mjs';

const WP_DIR = path.resolve('src/data/wp');
const TITLE_MAX = 60;

function fixItem(data) {
	const currentSeoTitle = (data.seo?.title || '').trim();
	const fallbackTitle = (data.title || '').trim();
	const source = currentSeoTitle || fallbackTitle;

	if (!source || source.length <= TITLE_MAX) {
		return { data, changed: false };
	}

	const shortened = shortenSeoTitle(source, TITLE_MAX);
	if (shortened === source) return { data, changed: false };

	const next = {
		...data,
		seo: {
			...data.seo,
			title: shortened,
		},
	};

	return { data: next, changed: true, before: source.length, after: shortened.length };
}

async function processDir(subdir) {
	const dir = path.join(WP_DIR, subdir);
	const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));

	let filesUpdated = 0;
	let stillLong = 0;

	for (const file of files) {
		const filePath = path.join(dir, file);
		const raw = await readFile(filePath, 'utf8');
		const data = JSON.parse(raw);
		const { data: fixed, changed } = fixItem(data);

		if (!changed) continue;

		const len = (fixed.seo?.title || '').length;
		if (len > TITLE_MAX) stillLong++;

		await writeFile(filePath, `${JSON.stringify(fixed, null, 2)}\n`);
		filesUpdated++;
	}

	return { filesUpdated, stillLong };
}

console.log(`Encurtando títulos SEO > ${TITLE_MAX} caracteres…\n`);

const pages = await processDir('pages');
const posts = await processDir('posts');

console.log(`Páginas: ${pages.filesUpdated} títulos ajustados`);
console.log(`Posts: ${posts.filesUpdated} títulos ajustados`);
console.log(`Total: ${pages.filesUpdated + posts.filesUpdated} arquivos`);

if (pages.stillLong + posts.stillLong > 0) {
	console.log(`Aviso: ${pages.stillLong + posts.stillLong} ainda acima de ${TITLE_MAX} chars`);
}
