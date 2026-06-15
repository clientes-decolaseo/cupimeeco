import {
	buildRedirectMap,
	normalizePathKey,
	resolveRedirectDestination,
} from './redirect-map.mjs';

const SITE_HOSTS = new Set(['cupins.eco.br', 'www.cupins.eco.br', 'cupim.eco.br', 'www.cupim.eco.br']);
const HREF_RE = /href\s*=\s*(["'])([^"']*)\1/gi;

function isSkippableHref(href) {
	const value = href.trim();
	return (
		!value ||
		value.startsWith('#') ||
		value.startsWith('mailto:') ||
		value.startsWith('tel:') ||
		value.startsWith('javascript:')
	);
}

function parseHrefParts(href) {
	const trimmed = href.trim();
	let pathname = '';
	let query = '';
	let hash = '';
	let isAbsolute = false;
	let isInternal = true;

	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		isAbsolute = true;
		try {
			const url = new URL(trimmed);
			if (!url.hostname) return { isInternal: false };
			isInternal = SITE_HOSTS.has(url.hostname.toLowerCase());
			if (!isInternal) return { isInternal: false };

			pathname = url.pathname;
			query = url.search;
			hash = url.hash;
		} catch {
			return { isInternal: false };
		}
	} else {
		let rest = trimmed;
		const hashIndex = rest.indexOf('#');
		if (hashIndex >= 0) {
			hash = rest.slice(hashIndex);
			rest = rest.slice(0, hashIndex);
		}
		const queryIndex = rest.indexOf('?');
		if (queryIndex >= 0) {
			query = rest.slice(queryIndex);
			rest = rest.slice(0, queryIndex);
		}
		pathname = rest.startsWith('/') ? rest : `/${rest}`;
	}

	return { isInternal, pathname, query, hash, isAbsolute };
}

function formatHref(destination, query, hash, isAbsolute) {
	const path = normalizeRedirectDestinationForHref(destination);
	const suffix = `${query}${hash}`;

	if (isAbsolute) {
		const originPath = path === '/' ? '/' : path;
		return `https://cupins.eco.br${originPath}${suffix}`;
	}

	return `${path}${suffix}`;
}

function normalizeRedirectDestinationForHref(destination) {
	if (!destination || destination === '/') return '/';
	const withSlash = destination.startsWith('/') ? destination : `/${destination}`;
	return withSlash.endsWith('/') ? withSlash : `${withSlash}/`;
}

export function rewriteHrefValue(href, redirectMap) {
	if (isSkippableHref(href)) return { href, changed: false };

	const parts = parseHrefParts(href);
	if (!parts.isInternal) return { href, changed: false };

	const pathKey = normalizePathKey(parts.pathname);
	const destination = resolveRedirectDestination(pathKey, redirectMap);
	if (!destination) return { href, changed: false };

	const currentNorm = normalizeRedirectDestinationForHref(parts.pathname);
	const destNorm = normalizeRedirectDestinationForHref(destination);
	if (pathKey === normalizePathKey(destination) || currentNorm === destNorm) {
		return { href, changed: false };
	}

	return {
		href: formatHref(destination, parts.query, parts.hash, parts.isAbsolute),
		changed: true,
	};
}

export function rewriteRedirectLinksInHtml(html, redirectMap) {
	if (!html) return { html, replacements: 0 };

	let replacements = 0;

	const output = html.replace(HREF_RE, (match, quote, hrefValue) => {
		const { href: newHref, changed } = rewriteHrefValue(hrefValue, redirectMap);
		if (!changed) return match;
		replacements++;
		return `href=${quote}${newHref}${quote}`;
	});

	return { html: output, replacements };
}

let cachedMap = null;

export function getRedirectMap() {
	if (!cachedMap) cachedMap = buildRedirectMap();
	return cachedMap;
}

export function rewriteRedirectLinksInText(text, redirectMap = getRedirectMap()) {
	if (!text) return { text, replacements: 0 };

	const { html, replacements } = rewriteRedirectLinksInHtml(text, redirectMap);
	return { text: html, replacements };
}
