import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shortenSeoDescription } from './lib/truncate-seo.mjs';

const WP_DIR = path.resolve('src/data/wp');
const DESC_MAX = 160;

function fixItem(data) {
	const currentDesc = (data.seo?.description || '').trim();
	const excerptPlain = (data.excerpt || '').trim();
	const source = currentDesc || excerptPlain;

	if (!source || source.length <= DESC_MAX) {
		return { data, changed: false };
	}

	const shortened = shortenSeoDescription(source, DESC_MAX);
	if (!shortened || currentDesc === shortened) {
		return { data, changed: false };
	}

	return {
		data: {
			...data,
			seo: {
				...data.seo,
				description: shortened,
			},
		},
		changed: true,
	};
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

		const len = (fixed.seo?.description || '').length;
		if (len > DESC_MAX) stillLong++;

		await writeFile(filePath, `${JSON.stringify(fixed, null, 2)}\n`);
		filesUpdated++;
	}

	return { filesUpdated, stillLong };
}

console.log(`Encurtando meta descriptions > ${DESC_MAX} caracteres…\n`);

const pages = await processDir('pages');
const posts = await processDir('posts');

console.log(`Páginas: ${pages.filesUpdated} descriptions ajustadas`);
console.log(`Posts: ${posts.filesUpdated} descriptions ajustadas`);
console.log(`Total: ${pages.filesUpdated + posts.filesUpdated} arquivos`);

if (pages.stillLong + posts.stillLong > 0) {
	console.log(`Aviso: ${pages.stillLong + posts.stillLong} ainda acima de ${DESC_MAX} chars`);
}
