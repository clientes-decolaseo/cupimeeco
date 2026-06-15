import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', 'dist', '.vercel', '.astro']);
const REPLACEMENTS = [
	['https://cupins.eco.br', 'https://cupins.eco.br'],
	['https://cupins.eco.br', 'https://cupins.eco.br'],
	['contato@cupins.eco.br', 'contato@cupins.eco.br'],
];

async function walk(dir, files = []) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) await walk(full, files);
		else if (/\.(json|mjs|ts|astro|txt|md|html|xml)$/i.test(entry.name)) files.push(full);
	}
	return files;
}

let changed = 0;
let matched = 0;

for (const file of await walk(ROOT)) {
	const raw = await readFile(file, 'utf8');
	if (!raw.includes('cupim.eco.br')) continue;

	matched++;
	let next = raw;
	for (const [from, to] of REPLACEMENTS) {
		next = next.split(from).join(to);
	}

	if (next !== raw) {
		await writeFile(file, next);
		changed++;
	}
}

console.log(`Arquivos com cupim.eco.br: ${matched}`);
console.log(`Arquivos atualizados: ${changed}`);
