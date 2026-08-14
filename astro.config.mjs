// @ts-check
import { defineConfig } from 'astro/config';

import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';
import cupimPolicy from './src/data/seo/cupim-policy.json';
import dedetizacaoPolicy from './src/data/seo/dedetizacao-policy.json';
import deratizacaoPolicy from './src/data/seo/deratizacao-policy.json';
import foraAreaPolicy from './src/data/seo/fora-area-policy.json';
import duplicatesPolicy from './src/data/seo/duplicates-policy.json';
import sanitizacaoPolicy from './src/data/seo/sanitizacao-policy.json';
import mosquitosPolicy from './src/data/seo/mosquitos-policy.json';
import hubThinPolicy from './src/data/seo/hub-thin-policy.json';
import offtopicPolicy from './src/data/seo/offtopic-policy.json';
import cidadesRedirectsJson from './scripts/redirects-cidades.json' with { type: 'json' };

const policyFiles = [
	cupimPolicy,
	dedetizacaoPolicy,
	deratizacaoPolicy,
	sanitizacaoPolicy,
	mosquitosPolicy,
	foraAreaPolicy,
	duplicatesPolicy,
	hubThinPolicy,
	offtopicPolicy,
];

const redirectSources = new Set();
const noindexPaths = new Set();

/** @type {Record<string, { status: 301; destination: string }>} */
const clusterRedirects = {};

for (const policy of policyFiles) {
	for (const path of policy.noindex ?? []) {
		noindexPaths.add(String(path).replace(/^\/+|\/+$/g, '').toLowerCase());
	}

	for (const [from, to] of Object.entries(policy.redirects ?? {})) {
		redirectSources.add(from);
		const destination = to.replace(/\/+$/, '') || '/';
		clusterRedirects[`/${from}`] = { status: 301, destination };
	}
}

/** Redirects 301 de cidades (fora da área) — merge sem sobrescrever chaves já existentes. */
function normalizeRedirectKey(key = '') {
	return String(key).replace(/^\/+|\/+$/g, '').toLowerCase();
}

const existingRedirectKeys = new Set(
	[
		'/sitemap.xml',
		'/d',
		'/d/[...slug]',
		'/desratizacao',
		'/fotos',
		'/biblioteca-da-universo',
		'/glossario-tudo-sobre-descupinizacao',
		'/sanitizacao/regioes',
		'/controle-de-mosquitos/regioes',
		'/dedetizacao-de-cupins',
		'/dedetizadora-de-cupim',
		...Object.keys(clusterRedirects),
	].map(normalizeRedirectKey),
);

/** @type {Record<string, string>} */
const cidadesRedirects = {};
for (const [from, to] of Object.entries(cidadesRedirectsJson)) {
	if (from === '_meta' || from.startsWith('_')) continue;
	if (existingRedirectKeys.has(normalizeRedirectKey(from))) continue;
	cidadesRedirects[from] = typeof to === 'string' ? to : String(to?.destination ?? to);
	existingRedirectKeys.add(normalizeRedirectKey(from));
	// sitemap: não listar URLs que só redirecionam
	redirectSources.add(normalizeRedirectKey(from));
}

function pathnameFromSitemapUrl(url) {
	try {
		return new URL(url).pathname.replace(/^\/+|\/+$/g, '');
	} catch {
		return '';
	}
}

/** Paths never listed in sitemap-index (utility or legacy HTML pages). */
const sitemapBlocklist = new Set(['sitemap', 'busca']);

// https://astro.build/config
export default defineConfig({
	site: 'https://cupins.eco.br',
	output: 'static',
	adapter: vercel(),
	trailingSlash: 'always',
	build: {
		inlineStylesheets: 'always',
	},
	integrations: [
		sitemap({
			filter: (page) => {
				const pathname = pathnameFromSitemapUrl(page);

				if (!pathname) return true;
				if (sitemapBlocklist.has(pathname)) return false;
				if (redirectSources.has(pathname)) return false;
				if (noindexPaths.has(pathname)) return false;

				return true;
			},
		}),
	],
	redirects: {
		// Cidades fora da área (scripts/redirects-cidades.json) — entradas
		// já existentes abaixo têm prioridade e não são sobrescritas.
		...cidadesRedirects,
		'/sitemap.xml': {
			status: 301,
			destination: '/sitemap-index.xml',
		},
		'/d': {
			status: 301,
			destination: '/',
		},
		'/d/[...slug]': {
			status: 301,
			destination: '/[...slug]',
		},
		'/desratizacao': {
			status: 301,
			destination: '/deratizacao',
		},
		'/fotos': {
			status: 301,
			destination: '/',
		},
		'/biblioteca-da-universo': {
			status: 301,
			destination: '/blog/',
		},
		'/glossario-tudo-sobre-descupinizacao': {
			status: 301,
			destination: '/blog/',
		},
		...clusterRedirects,
		'/sanitizacao/regioes': {
			status: 301,
			destination: '/sanitizacao',
		},
		'/controle-de-mosquitos/regioes': {
			status: 301,
			destination: '/controle-de-mosquitos',
		},
		'/dedetizacao-de-cupins': {
			status: 301,
			destination: '/descupinizacao',
		},
		'/dedetizadora-de-cupim': {
			status: 301,
			destination: '/descupinizacao',
		},
	},
});
