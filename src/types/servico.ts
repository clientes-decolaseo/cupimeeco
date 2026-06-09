export interface ServicoBeneficio {
	titulo: string;
	texto: string;
}

export interface ServicoDetalhe {
	nome: string;
	descricao: string;
}

export interface ServicoFaqItem {
	pergunta: string;
	resposta: string;
}

export interface ServicoData {
	slug: string;
	titulo: string;
	subtitulo: string;
	seo: {
		title: string;
		description: string;
	};
	intro: string;
	beneficios: ServicoBeneficio[];
	detalhes: ServicoDetalhe[];
	detalhesTitulo: string;
	sinais: string[];
	sinaisTitulo: string;
	etapas: string[];
	etapasTitulo: string;
	prevencao: string[];
	prevencaoTitulo: string;
	faq?: ServicoFaqItem[];
}
