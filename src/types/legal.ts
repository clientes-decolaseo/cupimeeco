export interface LegalSection {
	titulo: string;
	paragrafos: string[];
	itens?: string[];
}

export interface LegalPageData {
	slug: string;
	titulo: string;
	atualizadoEm: string;
	seo: {
		title: string;
		description: string;
	};
	intro: string;
	secoes: LegalSection[];
}
