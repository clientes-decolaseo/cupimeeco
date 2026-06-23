import supplements from '../data/seo/wp-content-supplements.json';

interface ContentSupplement {
	/** Trecho HTML único onde inserir o bloco (antes dele) */
	insertBefore: string;
	html: string;
}

const supplementMap = supplements as Record<string, ContentSupplement>;

export function applyContentSupplement(path: string, html: string): string {
	const supplement = supplementMap[path];
	if (!supplement?.html || !supplement.insertBefore) return html;

	const marker = supplement.insertBefore;
	const index = html.indexOf(marker);
	if (index === -1) return html;

	return `${html.slice(0, index)}${supplement.html}${html.slice(index)}`;
}
