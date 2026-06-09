import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const WP_DIR = path.resolve('src/data/wp');

const PATTERNS = [
	{ label: 'Bio Soluções (variantes)', regex: /Bio[\s-]*Solu[cç][oõ]es/gi },
	{ label: 'bio-solucoes (URL/domínio)', regex: /bio-solucoes/gi },
	{ label: 'biosolucoes', regex: /biosolucoes/gi },
	{ label: 'Universo Ambiental', regex: /Universo\s+Ambiental/gi },
];

function scanText(text, file, counts) {
	for (const { label, regex } of PATTERNS) {
		const matches = text.match(regex);
		if (!matches?.length) continue;

		counts[label] = (counts[label] ?? 0) + matches.length;

		if (!counts._samples) counts._samples = [];
		if (counts._samples.length < 8) {
			counts._samples.push({ file, label, sample: matches[0] });
		}
	}
}

async function scanDir(subdir, counts) {
	const dir = path.join(WP_DIR, subdir);
	const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));

	for (const file of files) {
		const raw = await readFile(path.join(dir, file), 'utf8');
		scanText(raw, `${subdir}/${file}`, counts);
	}
}

const counts = {};

await scanDir('pages', counts);
await scanDir('posts', counts);
scanText(await readFile(path.join(WP_DIR, 'manifest.json'), 'utf8'), 'manifest.json', counts);

const total = Object.entries(counts)
	.filter(([key]) => !key.startsWith('_'))
	.reduce((sum, [, value]) => sum + value, 0);

console.log('\nAuditoria de marca legada\n');

for (const { label } of PATTERNS) {
	console.log(`  ${label}: ${counts[label] ?? 0}`);
}

console.log(`\nTotal: ${total}`);

if (counts._samples?.length) {
	console.log('\nAmostras:');
	for (const sample of counts._samples) {
		console.log(`  - ${sample.file}: "${sample.sample}"`);
	}
}

process.exit(total > 0 ? 1 : 0);
