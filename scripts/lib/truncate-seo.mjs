const BRAND = 'Cupim Eco';
const BRAND_SUFFIXES = [` | ${BRAND}`, ` - ${BRAND}`, ` – ${BRAND}`];

export function decodeHtmlEntities(text = '') {
	return text
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"');
}

/** Mesma lógica do BioLayout.astro */
export function truncateAtWord(text, max) {
	const normalized = text.trim().replace(/\s+/g, ' ');
	if (normalized.length <= max) return normalized;

	const slice = normalized.slice(0, max - 1);
	const lastSpace = slice.lastIndexOf(' ');

	return `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trim()}…`;
}

/**
 * Encurta title SEO preservando sufixo de marca quando existir.
 * @param {string} raw
 * @param {number} max
 */
export function shortenSeoTitle(raw, max = 60) {
	let text = decodeHtmlEntities(raw).trim().replace(/\s+/g, ' ');
	if (text.length <= max) return text;

	for (const suffix of BRAND_SUFFIXES) {
		const lower = text.toLowerCase();
		const suffixLower = suffix.toLowerCase();
		if (!lower.endsWith(suffixLower)) continue;

		const main = text.slice(0, text.length - suffix.length).trim();
		const budget = max - suffix.length;
		if (budget < 12) break;

		return `${truncateAtWord(main, budget)}${suffix}`;
	}

	if (!text.includes(BRAND) && max >= 12 + 3) {
		const suffix = ` | ${BRAND}`;
		const budget = max - suffix.length;
		if (budget >= 15) {
			return `${truncateAtWord(text, budget)}${suffix}`;
		}
	}

	return truncateAtWord(text, max);
}

export function stripHtml(text = '') {
	return decodeHtmlEntities(text)
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/\[\s*…\s*\]/g, '')
		.trim();
}

/** Meta description — mesma regra do BioLayout (160 caracteres). */
export function shortenSeoDescription(raw, max = 160) {
	const text = stripHtml(raw);
	if (!text || text.length <= max) return text;
	return truncateAtWord(text, max);
}
