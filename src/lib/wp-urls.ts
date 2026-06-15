const SITE_ORIGIN = 'https://cupins.eco.br';

const BRAND_REPLACEMENTS: [RegExp, string][] = [
	[/Dedetizadora\s+Bio[\s-]*Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Dedetiza[cç][aã]o\s+Bio[\s-]*Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Descupiniza[cç][aã]o\s+Bio[\s-]*Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Bio[\s&nbsp;]*Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Bio-Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/BioSolu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Universo\s+Ambiental/gi, 'Cupim Eco'],
	[/Combate\s+Ambienta/gi, 'Cupim Eco'],
	[/https?:\/\/(?:www\.)?bio-solucoes\.com\.br/gi, 'https://cupins.eco.br'],
	[/https?:\/\/(?:www\.)?bio-solucoes\.com/gi, 'https://cupins.eco.br'],
	[/https?:\/\/(?:www\.)?biosolucoes\.com\.br/gi, 'https://cupins.eco.br'],
	[/https?:\/\/(?:www\.)?biosolucoes\.com/gi, 'https://cupins.eco.br'],
];

export function normalizeSiteUrl(url: string): string {
	if (!url) return url;

	let normalized = url
		.replace(/https?:\/\/(?:www\.)?cupins\.eco\.br\/d\//gi, `${SITE_ORIGIN}/`)
		.replace(/https?:\/\/(?:www\.)?cupins\.eco\.br\/d$/gi, SITE_ORIGIN)
		.replace(/https?:\/\/(?:www\.)?cupim\.eco\.br\/d\//gi, `${SITE_ORIGIN}/`)
		.replace(/https?:\/\/(?:www\.)?cupim\.eco\.br\/d$/gi, SITE_ORIGIN)
		.replace(/https?:\/\/(?:www\.)?cupim\.eco\.br\//gi, `${SITE_ORIGIN}/`)
		.replace(/https?:\/\/(?:www\.)?cupim\.eco\.br$/gi, SITE_ORIGIN)
		.replace(/\/d\//g, '/');

	if (normalized.startsWith('/d/')) {
		normalized = normalized.slice(2);
	}

	return normalized;
}

export function normalizeWpHtml(html: string): string {
	if (!html) return html;

	return html
		.replace(/https?:\/\/(?:www\.)?cupins\.eco\.br\/d\//gi, `${SITE_ORIGIN}/`)
		.replace(/https?:\/\/(?:www\.)?cupim\.eco\.br\/d\//gi, `${SITE_ORIGIN}/`)
		.replace(/https?:\/\/(?:www\.)?cupim\.eco\.br\//gi, `${SITE_ORIGIN}/`)
		.replace(/href="\/d\//gi, 'href="/')
		.replace(/href='\/d\//gi, "href='/");
}

export function normalizeBrandText(text: string): string {
	let result = text;

	for (const [pattern, replacement] of BRAND_REPLACEMENTS) {
		result = result.replace(pattern, replacement);
	}

	return result.replace(/Cupim Eco\s+Cupim Eco/gi, 'Cupim Eco');
}

export function pathToCanonical(path: string, origin = SITE_ORIGIN): string {
	const clean = path.replace(/^\/+|\/+$/g, '');
	return clean ? `${origin}/${clean}/` : `${origin}/`;
}
