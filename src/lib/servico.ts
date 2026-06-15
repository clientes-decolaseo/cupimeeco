import type { ServicoData } from '../types/servico';

export function buildServiceJsonLd(servico: ServicoData) {
	return {
		'@context': 'https://schema.org',
		'@type': 'Service',
		name: servico.titulo,
		description: servico.seo.description,
		provider: {
			'@type': 'LocalBusiness',
			name: 'Cupim Eco',
			telephone: '08001117272',
			url: 'https://cupins.eco.br',
		},
		areaServed: {
			'@type': 'State',
			name: 'São Paulo',
		},
	};
}

export function buildFaqJsonLd(servico: ServicoData) {
	if (!servico.faq?.length) return null;

	return {
		'@context': 'https://schema.org',
		'@type': 'FAQPage',
		mainEntity: servico.faq.map((item) => ({
			'@type': 'Question',
			name: item.pergunta,
			acceptedAnswer: {
				'@type': 'Answer',
				text: item.resposta,
			},
		})),
	};
}

export function buildPillarJsonLd(servico: ServicoData): Record<string, unknown>[] {
	const schemas: Record<string, unknown>[] = [buildServiceJsonLd(servico)];
	const faq = buildFaqJsonLd(servico);

	if (faq) schemas.push(faq);

	return schemas;
}
