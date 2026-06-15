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

const policyFiles = [
	cupimPolicy,
	dedetizacaoPolicy,
	deratizacaoPolicy,
	sanitizacaoPolicy,
	mosquitosPolicy,
	foraAreaPolicy,
	duplicatesPolicy,
];

const redirectSources = new Set();
const noindexPaths = new Set();

/** @type {Record<string, { status: 301; destination: string }>} */
const clusterRedirects = {};

for (const policy of policyFiles) {
	for (const path of policy.noindex ?? []) {
		noindexPaths.add(path);
	}

	for (const [from, to] of Object.entries(policy.redirects)) {
		redirectSources.add(from);
		const destination = to.replace(/\/+$/, '') || '/';
		clusterRedirects[`/${from}`] = { status: 301, destination };
	}
}

function pathnameFromSitemapUrl(url) {
	try {
		return new URL(url).pathname.replace(/^\/+|\/+$/g, '');
	} catch {
		return '';
	}
}

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
				if (redirectSources.has(pathname)) return false;
				if (noindexPaths.has(pathname)) return false;

				return true;
			},
		}),
	],
	redirects: {
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
