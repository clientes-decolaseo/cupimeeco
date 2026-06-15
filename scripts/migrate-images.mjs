import { mkdir, readFile, readdir, writeFile, access, stat } from 'node:fs/promises';
import path from 'node:path';

const WP_ORIGIN = 'https://cupins.eco.br/d';
const DATA_DIR = path.resolve('src/data/wp');
const PUBLIC_DIR = path.resolve('public');
const MANIFEST_PATH = path.resolve('src/data/wp/images-manifest.json');

const CONCURRENCY = 8;
const DELAY_MS = 100;
const RETRIES = 3;

const URL_PATTERNS = [
	/https:\/\/cupim\.eco\.br\/d\/wp-content\/uploads\/[^\s"'<>)\]]+/gi,
	/https:\/\/cupim\.eco\.br\/wp-content\/uploads\/[^\s"'<>)\]]+/gi,
	/\/d\/wp-content\/uploads\/[^\s"'<>)\]]+/gi,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeUrl(rawUrl) {
	let url = rawUrl
		.replace(/\\+$/, '')
		.replace(/&amp;/g, '&')
		.replace(/\\u0026/g, '&');

	if (url.startsWith('/d/wp-content/')) {
		url = `${WP_ORIGIN}${url.slice(2)}`;
	}

	if (url.startsWith('/wp-content/')) {
		url = `${WP_ORIGIN}${url}`;
	}

	return url.split('?')[0];
}

function getFallbackUrls(absoluteUrl) {
	const fallbacks = [absoluteUrl];
	const withoutSize = absoluteUrl.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, '');

	if (withoutSize !== absoluteUrl) {
		fallbacks.push(withoutSize);
	}

	return [...new Set(fallbacks)];
}

function toLocalPath(absoluteUrl) {
	const prefix = `${WP_ORIGIN}/wp-content/uploads/`;
	const altPrefix = 'https://cupins.eco.br/wp-content/uploads/';

	let relative = '';

	if (absoluteUrl.startsWith(prefix)) {
		relative = absoluteUrl.slice(prefix.length);
	} else if (absoluteUrl.startsWith(altPrefix)) {
		relative = absoluteUrl.slice(altPrefix.length);
	} else {
		return null;
	}

	return {
		absoluteUrl,
		publicPath: `/wp-content/uploads/${relative}`,
		diskPath: path.join(PUBLIC_DIR, 'wp-content', 'uploads', relative),
	};
}

function extractUrlsFromText(text) {
	const found = new Set();

	for (const pattern of URL_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			found.add(normalizeUrl(match[0]));
		}
	}

	return [...found];
}

async function fileExists(filePath) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function downloadImage(localMeta, cache) {
	if (cache.has(localMeta.absoluteUrl)) {
		return cache.get(localMeta.absoluteUrl);
	}

	if (await fileExists(localMeta.diskPath)) {
		const result = { status: 'cached', ...localMeta };
		cache.set(localMeta.absoluteUrl, result);
		return result;
	}

	await mkdir(path.dirname(localMeta.diskPath), { recursive: true });

	const candidates = getFallbackUrls(localMeta.absoluteUrl);

	for (let attempt = 1; attempt <= RETRIES; attempt++) {
		for (const candidateUrl of candidates) {
			try {
				const response = await fetch(candidateUrl);

				if (!response.ok) continue;

				const buffer = Buffer.from(await response.arrayBuffer());
				await writeFile(localMeta.diskPath, buffer);

				const result = {
					status: 'downloaded',
					bytes: buffer.length,
					...localMeta,
					sourceUrl: candidateUrl,
				};
				cache.set(localMeta.absoluteUrl, result);
				return result;
			} catch {
				// tenta próximo fallback
			}
		}

		if (attempt < RETRIES) {
			await sleep(DELAY_MS * attempt);
		}
	}

	const result = {
		status: 'failed',
		error: 'HTTP 404',
		...localMeta,
	};
	cache.set(localMeta.absoluteUrl, result);
	return result;
}

function enhanceImages(html) {
	return html.replace(/<img\b([^>]*?)>/gi, (match, attrs) => {
		let next = attrs;

		if (!/\bloading=/i.test(next)) {
			next += ' loading="lazy"';
		}

		if (!/\bdecoding=/i.test(next)) {
			next += ' decoding="async"';
		}

		return `<img${next}>`;
	});
}

function replaceUrlsInText(text, urlMap) {
	let output = text;

	for (const [remote, local] of urlMap.entries()) {
		const variants = [
			remote,
			remote.replace(WP_ORIGIN, ''),
			remote.replace(`${WP_ORIGIN}/wp-content`, '/wp-content'),
			remote.replace('https://cupins.eco.br/d/', 'https://cupins.eco.br/'),
		];

		for (const variant of new Set(variants)) {
			output = output.split(variant).join(local);
			output = output.split(variant.replace(/&/g, '&amp;')).join(local);
		}
	}

	return output;
}

async function collectJsonFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith('.json')) {
			files.push(path.join(dir, entry.name));
		}
	}

	return files;
}

async function runPool(items, worker, concurrency) {
	const results = [];
	let index = 0;

	async function runner() {
		while (index < items.length) {
			const current = index++;
			results[current] = await worker(items[current], current);
		}
	}

	await Promise.all(Array.from({ length: concurrency }, runner));
	return results;
}

async function main() {
	console.log('Migrando imagens WordPress → public/wp-content/uploads/');

	const contentFiles = [
		...(await collectJsonFiles(path.join(DATA_DIR, 'pages'))),
		...(await collectJsonFiles(path.join(DATA_DIR, 'posts'))),
	];

	const allUrls = new Set();

	for (const filePath of contentFiles) {
		const raw = await readFile(filePath, 'utf8');
		for (const url of extractUrlsFromText(raw)) {
			allUrls.add(url);
		}
	}

	const localItems = [...allUrls]
		.map(toLocalPath)
		.filter(Boolean);

	console.log(`→ ${localItems.length} URLs únicas encontradas`);

	const cache = new Map();
	let downloaded = 0;
	let cached = 0;
	let failed = 0;
	let totalBytes = 0;

	await runPool(
		localItems,
		async (item, i) => {
			const result = await downloadImage(item, cache);

			if (result.status === 'downloaded') {
				downloaded++;
				totalBytes += result.bytes ?? 0;
			} else if (result.status === 'cached') {
				cached++;
			} else {
				failed++;
			}

			if ((i + 1) % 50 === 0 || i + 1 === localItems.length) {
				console.log(`  ✓ ${i + 1}/${localItems.length} processadas`);
			}

			await sleep(DELAY_MS / CONCURRENCY);
			return result;
		},
		CONCURRENCY,
	);

	const urlMap = new Map();

	for (const item of localItems) {
		const result = cache.get(item.absoluteUrl);
		if (result?.status === 'downloaded' || result?.status === 'cached') {
			urlMap.set(item.absoluteUrl, item.publicPath);
		}
	}

	console.log('\nAtualizando referências nos JSONs...');
	let updatedFiles = 0;

	for (const filePath of contentFiles) {
		const item = JSON.parse(await readFile(filePath, 'utf8'));
		const original = JSON.stringify(item);

		item.content = enhanceImages(replaceUrlsInText(item.content, urlMap));

		if (item.seo?.ogImage) {
			const local = urlMap.get(normalizeUrl(item.seo.ogImage));
			if (local) item.seo.ogImage = local;
		}

		const next = JSON.stringify(item, null, 2);

		if (next !== original) {
			await writeFile(filePath, `${next}\n`, 'utf8');
			updatedFiles++;
		}
	}

	const manifest = {
		migratedAt: new Date().toISOString(),
		source: WP_ORIGIN,
		stats: {
			uniqueUrls: localItems.length,
			downloaded,
			cached,
			failed,
			totalMb: Number((totalBytes / 1024 / 1024).toFixed(2)),
			updatedJsonFiles: updatedFiles,
		},
		failed: [...cache.values()]
			.filter((entry) => entry.status === 'failed')
			.map(({ absoluteUrl, error }) => ({ absoluteUrl, error })),
	};

	await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

	console.log('\nMigração de imagens concluída!');
	console.log(`  Baixadas:    ${downloaded}`);
	console.log(`  Em cache:    ${cached}`);
	console.log(`  Falhas:      ${failed}`);
	console.log(`  Tamanho:     ${manifest.stats.totalMb} MB`);
	console.log(`  JSONs atualizados: ${updatedFiles}`);
	console.log(`  Manifest: src/data/wp/images-manifest.json`);
}

main().catch((error) => {
	console.error('Erro na migração de imagens:', error);
	process.exit(1);
});
