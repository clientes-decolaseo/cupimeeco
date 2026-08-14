/**
 * Dicionário de categorias de praga para auditoria/rematch de redirects.
 * Usado por audit-pest-type-mismatch.mjs e rematch-mismatched-404.mjs.
 */
import { normalizePathKey } from './redirect-map.mjs';

/**
 * Categorias de praga → sinônimos/variações presentes em slugs do projeto.
 * Ordem de matching: termos mais longos / específicos primeiro.
 */
export const PEST_CATEGORIES = {
	cupim: [
		'descupinizacao',
		'descupiniza',
		'xilofago',
		'xilofagas',
		'xilofaga',
		'termite',
		'termites',
		'cupins',
		'cupim',
	],
	rato: [
		'desratizacao',
		'desratiza',
		'deratizacao',
		'deratiza',
		'roedores',
		'roedor',
		'camundongo',
		'camundongos',
		'ratos',
		'rato',
	],
	pulga: ['pulgas', 'pulga'],
	barata: ['baratas', 'barata'],
	mosquito: ['mosquitos', 'mosquito', 'aedes', 'dengue', 'pernilongo', 'zika', 'chikungunya'],
	formiga: ['formigas', 'formiga'],
	escorpiao: ['escorpioes', 'escorpiao'],
	carrapato: ['carrapatos', 'carrapato'],
	aranha: ['aranhas', 'aranha'],
	broca: ['brocas', 'broca'],
};

/** Termos ordenados por comprimento desc (evita "rato" casar antes de "desratizacao"). */
export const PEST_TERMS_FLAT = Object.entries(PEST_CATEGORIES)
	.flatMap(([category, terms]) => terms.map((term) => ({ category, term })))
	.sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));

function slugHaystack(raw) {
	return normalizePathKey(raw).replace(/-/g, ' ');
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Categorias de praga detectáveis no slug (pode ser >1, ex.: cupim-broca).
 * @returns {Set<string>}
 */
export function matchPestCategories(pathOrUrl) {
	const hay = slugHaystack(pathOrUrl);
	/** @type {Set<string>} */
	const found = new Set();
	if (!hay) return found;

	const compact = hay.replace(/\s+/g, '');

	for (const { category, term } of PEST_TERMS_FLAT) {
		if (found.has(category)) continue;
		const t = term.toLowerCase();
		const asWord = new RegExp(`(?:^|\\s)${escapeRegExp(t)}(?:\\s|$)`);
		if (asWord.test(hay) || compact.includes(t)) {
			found.add(category);
		}
	}

	return found;
}

/** Categoria principal (ordem do dicionário). */
export function primaryCategory(categories) {
	if (!categories?.size) return null;
	for (const c of Object.keys(PEST_CATEGORIES)) {
		if (categories.has(c)) return c;
	}
	return [...categories][0];
}

/**
 * True se o slug pertence à categoria alvo e não a nenhuma outra praga.
 * (Ex.: origem cupim → candidato com "ratos" é rejeitado.)
 */
export function belongsToSamePestCategoryOnly(pathOrUrl, category) {
	if (!category) return false;
	const cats = matchPestCategories(pathOrUrl);
	if (!cats.has(category)) return false;
	for (const c of cats) {
		if (c !== category) return false;
	}
	return true;
}
