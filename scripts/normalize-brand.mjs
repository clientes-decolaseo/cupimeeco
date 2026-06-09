import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeBrandDeep, normalizeBrandText } from './lib/brand-normalize.mjs';

const WP_DIR = path.resolve('src/data/wp');
const MANIFEST_PATH = path.join(WP_DIR, 'manifest.json');

const dryRun = process.argv.includes('--dry-run');

function countBrandMatches(text) {
	if (!text) return 0;

	const patterns = [
		/Bio[\s-]*Solu[cç][oõ]es/gi,
		/bio-solucoes/gi,
		/biosolucoes/gi,
		/Universo\s+Ambiental/gi,
	];

	return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

function normalizeWpItem(data) {
	return {
		...data,
		title: normalizeBrandText(data.title),
		excerpt: normalizeBrandText(data.excerpt),
		link: normalizeBrandText(data.link),
		content: normalizeBrandText(data.content),
		seo: data.seo
			? {
					...data.seo,
					title: normalizeBrandText(data.seo.title),
					description: normalizeBrandText(data.seo.description),
				}
			: data.seo,
	};
}

async function processDir(subdir) {
	const dir = path.join(WP_DIR, subdir);
	const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
	let updated = 0;
	let matchesBefore = 0;

	for (const file of files) {
		const filePath = path.join(dir, file);
		const raw = await readFile(filePath, 'utf8');
		matchesBefore += countBrandMatches(raw);

		const data = JSON.parse(raw);
		const normalized = normalizeWpItem(data);
		const output = `${JSON.stringify(normalized, null, 2)}\n`;

		if (output !== raw) {
			if (!dryRun) await writeFile(filePath, output);
			updated++;
		}
	}

	return { updated, matchesBefore };
}

async function processManifest() {
	const raw = await readFile(MANIFEST_PATH, 'utf8');
	const matchesBefore = countBrandMatches(raw);
	const data = JSON.parse(raw);
	const normalized = normalizeBrandDeep(data);
	const output = `${JSON.stringify(normalized, null, 2)}\n`;
	const changed = output !== raw;

	if (changed && !dryRun) {
		await writeFile(MANIFEST_PATH, output);
	}

	return { updated: changed ? 1 : 0, matchesBefore };
}

const pages = await processDir('pages');
const posts = await processDir('posts');
const manifest = await processManifest();

const totalUpdated = pages.updated + posts.updated + manifest.updated;
const totalMatches = pages.matchesBefore + posts.matchesBefore + manifest.matchesBefore;

console.log(
	dryRun
		? `[dry-run] Seriam atualizados: ${pages.updated} páginas, ${posts.updated} posts, manifest ${manifest.updated ? 'sim' : 'não'}.`
		: `Marca normalizada: ${pages.updated} páginas, ${posts.updated} posts, manifest ${manifest.updated ? 'sim' : 'não'}.`,
);
console.log(`Ocorrências legadas encontradas antes da passagem: ${totalMatches}`);

if (!dryRun && totalUpdated === 0 && totalMatches > 0) {
	console.warn('Aviso: ainda há ocorrências legadas — revise os padrões em scripts/lib/brand-normalize.mjs');
}

process.exit(0);
