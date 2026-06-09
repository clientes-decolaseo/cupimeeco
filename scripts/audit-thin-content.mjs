import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import manifest from '../src/data/wp/manifest.json' with { type: 'json' };
import { isPageInServiceArea } from './lib/resolve-city.mjs';

const OUT_DIR = path.resolve('src/data/seo');
const MIN_WORDS = 300;

function stripHtml(html = '') {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z#0-9]+;/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function countWords(text) {
	if (!text) return 0;
	return text.split(/\s+/).filter(Boolean).length;
}

async function loadWordCount(page) {
	const filePath = path.resolve(`src/data/wp/pages/${page.id}.json`);

	try {
		const data = JSON.parse(readFileSync(filePath, 'utf8'));
		const body = stripHtml(data.content);
		const excerpt = stripHtml(data.excerpt);
		return Math.max(countWords(body), countWords(excerpt));
	} catch {
		return 0;
	}
}

const thinPages = [];

for (const page of manifest.pages) {
	if (!page.path) continue;
	if (!isPageInServiceArea(page)) continue;

	const words = await loadWordCount(page);

	if (words < MIN_WORDS) {
		thinPages.push({
			path: page.path,
			title: page.title,
			words,
		});
	}
}

thinPages.sort((a, b) => a.words - b.words);

mkdirSync(OUT_DIR, { recursive: true });

const report = {
	generatedAt: new Date().toISOString(),
	minWords: MIN_WORDS,
	total: thinPages.length,
	pages: thinPages,
};

writeFileSync(path.join(OUT_DIR, 'thin-content-report.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(`Páginas na área atendida com menos de ${MIN_WORDS} palavras: ${thinPages.length}`);
console.log(`Relatório: src/data/seo/thin-content-report.json`);

if (thinPages.length > 0) {
	console.log('\nAmostra (10 piores):');
	for (const item of thinPages.slice(0, 10)) {
		console.log(`  ${item.words} palavras — ${item.path}`);
	}
}
