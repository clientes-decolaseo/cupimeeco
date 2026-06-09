import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import manifest from '../src/data/wp/manifest.json' with { type: 'json' };
import cupimPolicy from '../src/data/seo/cupim-policy.json' with { type: 'json' };
import dedetizacaoPolicy from '../src/data/seo/dedetizacao-policy.json' with { type: 'json' };
import deratizacaoPolicy from '../src/data/seo/deratizacao-policy.json' with { type: 'json' };
import sanitizacaoPolicy from '../src/data/seo/sanitizacao-policy.json' with { type: 'json' };
import mosquitosPolicy from '../src/data/seo/mosquitos-policy.json' with { type: 'json' };
import foraAreaPolicy from '../src/data/seo/fora-area-policy.json' with { type: 'json' };
import duplicatesPolicy from '../src/data/seo/duplicates-policy.json' with { type: 'json' };
import { isPageInServiceArea } from './lib/resolve-city.mjs';

const OUT = path.resolve('src/data/seo/full-seo-audit.json');
const WP_PAGES = path.resolve('src/data/wp/pages');
const WP_POSTS = path.resolve('src/data/wp/posts');

const TITLE_MIN = 30;
const TITLE_MAX_WARN = 60;
const DESC_MIN = 70;
const DESC_MAX_WARN = 160;
const MIN_WORDS_POST = 300;

const policies = [
	cupimPolicy,
	dedetizacaoPolicy,
	deratizacaoPolicy,
	sanitizacaoPolicy,
	mosquitosPolicy,
	foraAreaPolicy,
	duplicatesPolicy,
];

const redirectSources = new Set();
const redirectDest = new Map();
const noindexPaths = new Set();

for (const policy of policies) {
	for (const [from, to] of Object.entries(policy.redirects ?? {})) {
		redirectSources.add(from);
		redirectDest.set(from, to);
	}
	for (const p of policy.noindex ?? []) noindexPaths.add(p);
}

function isIndexable(entryPath) {
	if (!entryPath) return false;
	return !redirectSources.has(entryPath) && !noindexPaths.has(entryPath);
}

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

function loadJson(dir, id) {
	try {
		return JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8'));
	} catch {
		return null;
	}
}

function extractIssues(html = '') {
	const imgs = [...html.matchAll(/<img\b[^>]*>/gi)];
	const imgsNoAlt = imgs.filter((m) => !/\balt\s*=\s*["'][^"']+["']/i.test(m[0])).length;

	const h1InBody = (html.match(/<h1\b/gi) ?? []).length;

	const internalLinks = [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);

	return { imgsNoAlt, h1InBody, internalLinks };
}

const issues = {
	missingDescription: [],
	shortDescription: [],
	longDescriptionTruncated: [],
	shortTitle: [],
	longTitleTruncated: [],
	duplicateTitles: [],
	duplicateDescriptions: [],
	imagesWithoutAlt: [],
	extraH1InContent: [],
	linksToRedirects: [],
	linksLegacyDomain: [],
	thinPosts: [],
	wpRobotsNoindex: [],
	emptyContent: [],
	defaultOgOnly: [],
};

const titleMap = new Map();
const descMap = new Map();

function trackDuplicate(map, key, item, bucket) {
	if (!key || key.length < 10) return;
	if (!map.has(key)) map.set(key, []);
	map.get(key).push(item);
}

function pathFromHref(href) {
	if (href.startsWith('http')) {
		try {
			const u = new URL(href);
			if (!u.hostname.includes('cupim.eco')) return null;
			return u.pathname.replace(/^\/+|\/+$/g, '');
		} catch {
			return null;
		}
	}
	if (href.startsWith('/')) return href.replace(/^\/+|\/+$/g, '');
	if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return null;
	return href.replace(/^\/+|\/+$/g, '');
}

const allEntries = [
	...manifest.pages.map((e) => ({ ...e, type: 'page' })),
	...manifest.posts.map((e) => ({ ...e, type: 'post' })),
];

let indexablePages = 0;
let indexablePosts = 0;

for (const entry of allEntries) {
	if (!entry.path) continue;

	const indexable = isIndexable(entry.path);
	if (entry.type === 'page' && indexable) indexablePages++;
	if (entry.type === 'post' && indexable) indexablePosts++;

	const dir = entry.type === 'page' ? WP_PAGES : WP_POSTS;
	const data = loadJson(dir, entry.id);
	if (!data) continue;

	const seoTitle = (data.seo?.title || data.title || '').trim();
	const seoDesc = (data.seo?.description || data.excerpt || '').trim();
	const body = data.content ?? '';
	const words = countWords(stripHtml(body));

	if (!indexable) continue;

	const item = { path: entry.path, type: entry.type, title: entry.title };

	if (!seoDesc) issues.missingDescription.push(item);
	else if (seoDesc.length < DESC_MIN) issues.shortDescription.push({ ...item, length: seoDesc.length });
	else if (seoDesc.length > DESC_MAX_WARN) {
		issues.longDescriptionTruncated.push({ ...item, length: seoDesc.length });
	}

	if (seoTitle.length < TITLE_MIN) issues.shortTitle.push({ ...item, length: seoTitle.length });
	if (seoTitle.length > TITLE_MAX_WARN) {
		issues.longTitleTruncated.push({ ...item, length: seoTitle.length });
	}

	trackDuplicate(titleMap, seoTitle.toLowerCase(), item, 'title');
	trackDuplicate(descMap, seoDesc.toLowerCase(), item, 'desc');

	const { imgsNoAlt, h1InBody, internalLinks } = extractIssues(body);

	if (imgsNoAlt > 0) issues.imagesWithoutAlt.push({ ...item, count: imgsNoAlt });
	if (h1InBody > 0) issues.extraH1InContent.push({ ...item, h1Count: h1InBody });

	if (!stripHtml(body) && entry.type === 'page') issues.emptyContent.push(item);

	const robots = data.seo?.robots;
	if (
		robots === true ||
		(typeof robots === 'string' && robots.toLowerCase().includes('noindex'))
	) {
		issues.wpRobotsNoindex.push(item);
	}

	if (!data.seo?.ogImage && entry.type === 'post') issues.defaultOgOnly.push(item);

	if (entry.type === 'post' && words < MIN_WORDS_POST) {
		issues.thinPosts.push({ ...item, words });
	}

	for (const href of internalLinks) {
		if (/bio-solucoes|biosolucoes/i.test(href)) {
			issues.linksLegacyDomain.push({ ...item, href });
		}
		const slug = pathFromHref(href);
		if (slug && redirectSources.has(slug)) {
			issues.linksToRedirects.push({ ...item, href, redirectsTo: redirectDest.get(slug) });
		}
	}
}

for (const [, items] of titleMap) {
	if (items.length > 1) issues.duplicateTitles.push({ title: items[0].title, count: items.length, paths: items.map((i) => i.path) });
}

for (const [descKey, items] of descMap) {
	if (items.length < 2 || !descKey || descKey.length < 40) continue;
	issues.duplicateDescriptions.push({
		count: items.length,
		paths: items.map((i) => i.path).slice(0, 8),
	});
}

issues.duplicateDescriptions = issues.duplicateDescriptions
	.filter((d) => d.count > 1)
	.sort((a, b) => b.count - a.count)
	.slice(0, 30);

issues.duplicateTitles = issues.duplicateTitles.sort((a, b) => b.count - a.count).slice(0, 30);

const sortByCount = (arr) => [...arr].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));

const publicFiles = readdirSync(path.resolve('public'));
const hasRobots = publicFiles.includes('robots.txt');

const report = {
	generatedAt: new Date().toISOString(),
	summary: {
		totalPages: manifest.totals.pages,
		totalPosts: manifest.totals.posts,
		indexablePages,
		indexablePosts,
		redirects301: redirectSources.size,
		noindexPaths: noindexPaths.size,
		buildPagesExpected: '~701 (último build)',
		hasRobotsTxt: hasRobots,
		clusterRedirects: {
			descupinizacao: cupimPolicy.stats,
			dedetizacao: dedetizacaoPolicy.stats,
			deratizacao: deratizacaoPolicy.stats,
			sanitizacao: sanitizacaoPolicy.stats,
			mosquitos: mosquitosPolicy.stats,
			foraArea: foraAreaPolicy.stats,
		},
		blogNoindexSlugs: cupimPolicy.noindex ?? [],
	},
	issues: {
		missingDescription: { count: issues.missingDescription.length, sample: issues.missingDescription.slice(0, 15) },
		shortDescription: { count: issues.shortDescription.length, sample: issues.shortDescription.slice(0, 15) },
		longDescriptionTruncated: {
			count: issues.longDescriptionTruncated.length,
			sample: issues.longDescriptionTruncated.slice(0, 15),
		},
		shortTitle: { count: issues.shortTitle.length, sample: issues.shortTitle.slice(0, 15) },
		longTitleTruncated: { count: issues.longTitleTruncated.length, sample: issues.longTitleTruncated.slice(0, 15) },
		duplicateTitles: { count: issues.duplicateTitles.length, items: issues.duplicateTitles },
		duplicateDescriptions: { count: issues.duplicateDescriptions.length, items: issues.duplicateDescriptions },
		imagesWithoutAlt: {
			count: issues.imagesWithoutAlt.length,
			totalImgs: issues.imagesWithoutAlt.reduce((s, i) => s + i.count, 0),
			sample: sortByCount(issues.imagesWithoutAlt).slice(0, 15),
		},
		extraH1InContent: { count: issues.extraH1InContent.length, sample: issues.extraH1InContent.slice(0, 15) },
		linksToRedirects: { count: issues.linksToRedirects.length, sample: issues.linksToRedirects.slice(0, 20) },
		linksLegacyDomain: { count: issues.linksLegacyDomain.length, sample: issues.linksLegacyDomain.slice(0, 15) },
		thinPosts: { count: issues.thinPosts.length, sample: issues.thinPosts.sort((a, b) => a.words - b.words).slice(0, 15) },
		wpRobotsNoindex: { count: issues.wpRobotsNoindex.length, sample: issues.wpRobotsNoindex.slice(0, 15) },
		emptyContent: { count: issues.emptyContent.length, sample: issues.emptyContent.slice(0, 15) },
	},
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

console.log('=== Auditoria SEO completa ===\n');
console.log('Indexáveis:', indexablePages, 'páginas +', indexablePosts, 'posts');
console.log('Redirects 301:', redirectSources.size, '| noindex:', noindexPaths.size);
console.log('robots.txt:', hasRobots ? 'SIM' : 'AUSENTE');
console.log('\n--- Problemas (indexáveis) ---');
for (const [key, val] of Object.entries(report.issues)) {
	console.log(`  ${key}: ${val.count}`);
}
