import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeBrandText } from './lib/brand-normalize.mjs';

const WP_DIR = path.resolve('src/data/wp');
const BRAND = 'Cupim Eco';
const DEFAULT_ALT = 'Ilustração sobre controle de pragas e dedetização';

function stripHtml(text = '') {
	return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function humanizeFromSrc(src = '') {
	const file = src.split('/').pop()?.split('?')[0] ?? '';
	const base = file
		.replace(/\.[a-z0-9]+$/i, '')
		.replace(/[-_]?\d+x\d+[-_]?/gi, ' ')
		.replace(/[-_]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	return base.length >= 4 ? base : '';
}

function hasMeaningfulAlt(tag) {
	const match = tag.match(/\balt\s*=\s*(["'])(.*?)\1/i);
	if (!match) return false;
	return match[2].replace(/\s+/g, ' ').trim().length > 0;
}

function buildAltText(tag, pageTitle) {
	const titleAttr = tag.match(/\btitle\s*=\s*(["'])(.*?)\1/i);
	if (titleAttr?.[2]?.trim()) {
		return normalizeBrandText(stripHtml(titleAttr[2])).slice(0, 125);
	}

	const srcAttr = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
	if (srcAttr?.[2]) {
		const fromSrc = humanizeFromSrc(srcAttr[2]);
		if (fromSrc) return normalizeBrandText(fromSrc).slice(0, 125);
	}

	const cleanTitle = normalizeBrandText(stripHtml(pageTitle));
	if (cleanTitle) {
		return `${cleanTitle} — ${BRAND}`.slice(0, 125);
	}

	return DEFAULT_ALT;
}

function demoteH1InHtml(html) {
	let count = 0;

	const output = html.replace(/<\/?h1\b/gi, (match) => {
		count++;
		return match.toLowerCase().startsWith('</') ? '</h2>' : '<h2';
	});

	return { html: output, count: count / 2 };
}

function fixImgAlts(html, pageTitle) {
	let count = 0;

	const output = html.replace(/<img\b[^>]*>/gi, (tag) => {
		if (hasMeaningfulAlt(tag)) return tag;

		const alt = buildAltText(tag, pageTitle).replace(/"/g, '&quot;');
		count++;

		if (/\balt\s*=/i.test(tag)) {
			return tag.replace(/\balt\s*=\s*(["'])(.*?)\1/i, `alt="${alt}"`);
		}

		return tag.replace(/^<img\b/i, `<img alt="${alt}"`);
	});

	return { html: output, count };
}

function fixItem(data) {
	let h1Fixed = 0;
	let altFixed = 0;
	const next = { ...data };

	if (data.content) {
		const h1 = demoteH1InHtml(data.content);
		const imgs = fixImgAlts(h1.html, data.title);
		next.content = imgs.html;
		h1Fixed = h1.count;
		altFixed = imgs.count;
	}

	return { data: next, h1Fixed, altFixed, changed: h1Fixed > 0 || altFixed > 0 };
}

async function processDir(subdir) {
	const dir = path.join(WP_DIR, subdir);
	const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));

	let filesUpdated = 0;
	let totalH1 = 0;
	let totalAlt = 0;

	for (const file of files) {
		const filePath = path.join(dir, file);
		const raw = await readFile(filePath, 'utf8');
		const data = JSON.parse(raw);
		const { data: fixed, h1Fixed, altFixed, changed } = fixItem(data);

		if (!changed) continue;

		await writeFile(filePath, `${JSON.stringify(fixed, null, 2)}\n`);
		filesUpdated++;
		totalH1 += h1Fixed;
		totalAlt += altFixed;
	}

	return { filesUpdated, totalH1, totalAlt };
}

console.log('Corrigindo conteúdo WP (H1→H2 no HTML + alt em imagens)…\n');

const pages = await processDir('pages');
const posts = await processDir('posts');

console.log(
	`Páginas: ${pages.filesUpdated} arquivos — ${pages.totalH1} H1→H2, ${pages.totalAlt} alt adicionados`,
);
console.log(
	`Posts: ${posts.filesUpdated} arquivos — ${posts.totalH1} H1→H2, ${posts.totalAlt} alt adicionados`,
);
console.log(
	`\nTotal: ${pages.filesUpdated + posts.filesUpdated} arquivos, ${pages.totalH1 + posts.totalH1} cabeçalhos, ${pages.totalAlt + posts.totalAlt} imagens`,
);
