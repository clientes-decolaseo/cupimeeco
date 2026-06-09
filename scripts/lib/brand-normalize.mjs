/** Substituições de marca legada → Cupim Eco (ordem importa). */
export const BRAND_REPLACEMENTS = [
	[/Dedetizadora\s+Bio[\s-]*Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Dedetiza[cç][aã]o\s+Bio[\s-]*Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Descupiniza[cç][aã]o\s+Bio[\s-]*Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Bio[\s&nbsp;]*Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Bio-Solu[cç][oõ]es/gi, 'Cupim Eco'],
	[/BioSolu[cç][oõ]es/gi, 'Cupim Eco'],
	[/Universo\s+Ambiental/gi, 'Cupim Eco'],
	[/Combate\s+Ambienta/gi, 'Cupim Eco'],
	[/https?:\/\/(?:www\.)?bio-solucoes\.com\.br/gi, 'https://cupim.eco.br'],
	[/https?:\/\/(?:www\.)?bio-solucoes\.com/gi, 'https://cupim.eco.br'],
	[/https?:\/\/(?:www\.)?biosolucoes\.com\.br/gi, 'https://cupim.eco.br'],
	[/https?:\/\/(?:www\.)?biosolucoes\.com/gi, 'https://cupim.eco.br'],
];

export function normalizeBrandText(text = '') {
	if (!text || typeof text !== 'string') return text;

	let result = text;

	for (const [pattern, replacement] of BRAND_REPLACEMENTS) {
		result = result.replace(pattern, replacement);
	}

	// Evita duplicação acidental após múltiplas passagens
	result = result.replace(/Cupim Eco\s+Cupim Eco/gi, 'Cupim Eco');

	return result;
}

export function normalizeBrandDeep(value) {
	if (typeof value === 'string') return normalizeBrandText(value);

	if (Array.isArray(value)) {
		return value.map((item) => normalizeBrandDeep(item));
	}

	if (value && typeof value === 'object') {
		const output = {};

		for (const [key, nested] of Object.entries(value)) {
			output[key] = normalizeBrandDeep(nested);
		}

		return output;
	}

	return value;
}
