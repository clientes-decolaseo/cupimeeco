import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import manifest from '../src/data/wp/manifest.json' with { type: 'json' };
import overrides from '../src/data/seo/wp-meta-overrides.json' with { type: 'json' };
import { shortenSeoDescription } from './lib/truncate-seo.mjs';
import { shortenSeoTitle } from './lib/truncate-seo.mjs';

const TITLE_MIN = 30;
const DESC_MIN = 70;
const WP_DIR = path.resolve('src/data/wp');

const pathToEntry = new Map();

for (const page of manifest.pages) {
	if (page.path) pathToEntry.set(page.path, { type: 'pages', id: page.id });
}

for (const post of manifest.posts) {
	if (post.path) pathToEntry.set(post.path, { type: 'posts', id: post.id });
}

let updated = 0;
const missing = [];

for (const [itemPath, meta] of Object.entries(overrides)) {
	const entry = pathToEntry.get(itemPath);
	if (!entry) {
		missing.push(itemPath);
		continue;
	}

	const filePath = path.join(WP_DIR, entry.type, `${entry.id}.json`);
	const raw = await readFile(filePath, 'utf8');
	const data = JSON.parse(raw);
	const seo = { ...data.seo };

	if (meta.title) {
		seo.title = shortenSeoTitle(meta.title, 60);
	}

	if (meta.description) {
		seo.description = shortenSeoDescription(meta.description, 160);
	}

	const next = { ...data, seo };
	const output = `${JSON.stringify(next, null, 2)}\n`;

	if (output !== raw) {
		await writeFile(filePath, output);
		updated++;
	}
}

console.log(`Meta overrides aplicados: ${updated} arquivos`);

if (missing.length) {
	console.log(`Caminhos não encontrados no manifest: ${missing.join(', ')}`);
}
