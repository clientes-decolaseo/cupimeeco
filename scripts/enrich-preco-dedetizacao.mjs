import { readFileSync, writeFileSync } from 'node:fs';

const filePath = 'src/data/wp/pages/8720.json';
const data = JSON.parse(readFileSync(filePath, 'utf8'));

const enrichmentBeforeTables = `<h2>Preço de Dedetização em SP: Fatores Regionais e de Mercado</h2>
<p>O <strong>preço de dedetização em São Paulo</strong> varia conforme o tipo de praga, o tamanho do imóvel, o método de aplicação e o grau de infestação. Na Cupim Eco, a referência para apartamentos de dois quartos costuma partir de <strong>R$ 480,00</strong> para controle de baratas, formigas, pulgas ou roedores — sempre após vistoria técnica gratuita.</p>
<p>Contratar uma empresa registrada e com produtos aprovados pela ANVISA evita retrabalho e gastos maiores no futuro. Baratas, formigas, pulgas e ratos são as pragas mais comuns na capital e na Grande São Paulo; o <a href="/dedetizacao/">serviço de dedetização profissional</a> elimina focos e inclui garantia por escrito quando indicado no orçamento.</p>
<h3>O que influencia o valor da dedetização?</h3>
<p>Metragem e número de cômodos, tipo de praga (barata, formiga, pulga ou rato), necessidade de gel, pulverização ou barreira, condomínio versus casa, e se há infestação ativa ou tratamento preventivo. Imóveis comerciais e condomínios seguem tabelas específicas, como as referências abaixo. Valores podem ser atualizados — use as tabelas como orientação e confirme o preço final na visita técnica.</p>
<p>Atendemos residências e empresas em dezenas de cidades. Veja <a href="/dedetizacao/regioes/">dedetização por região e cidade</a> ou ligue grátis <strong>0800 111 7272</strong> (24 horas).</p>`;

const faqBlock = `
<h2>Perguntas frequentes sobre preço de dedetização em SP</h2>
<h3>Os valores das tabelas são finais?</h3>
<p>Não necessariamente. São referências históricas por tipo de imóvel e praga. O orçamento definitivo depende da inspeção no local, da metragem e do produto indicado para o seu caso.</p>
<h3>Por que o preço muda entre barata, rato, formiga e pulga?</h3>
<p>Cada praga exige produto, tempo de aplicação e monitoramento diferentes. Ratos costumam envolver iscas e vedação de acessos; baratas e formigas frequentemente usam gel ou pulverização residual em focos específicos.</p>
<h3>A dedetização inclui garantia?</h3>
<p>Sim. Conforme as tabelas abaixo, a garantia pode variar de 3 a 6 meses conforme o serviço e o tipo de imóvel. A Cupim Eco formaliza a garantia no contrato e retorna sem custo adicional no período acordado, se a praga tratada reaparecer no local.</p>
<h3>Vocês fazem visita técnica antes de passar o preço?</h3>
<p>Sim. Orçamento gratuito com avaliação presencial ou remota conforme o caso. Isso garante preço justo e método correto, sem surpresas no dia do serviço.</p>
<h3>Cupins entram no mesmo preço da dedetização?</h3>
<p>Não. Cupins exigem <a href="/descupinizacao/">descupinização</a> específica (barreira, injeção ou iscas), com valores distintos. Para roedores, veja também nossa <a href="/deratizacao/">deratização</a>.</p>
<h2>Solicite seu orçamento sem compromisso</h2>
<p>Central 24h: <strong>0800 111 7272</strong> ou <a href="/contato/">formulário de contato</a>. Atendemos São Paulo capital e região metropolitana, Baixada Santista, Campinas, Sorocaba, Jundiaí e Vale do Paraíba.</p>`;

const tablesStart = data.content.indexOf('<h2 class="heading-title');
const tablesPart = data.content.slice(tablesStart);
const tablesPartFixed = tablesPart
	.replace(/CUPIM\s*&#8211;\s*ORÇAMENTO GRÁTIS COM VISITA TÉCNICA!/i, 'Cupim Eco — orçamento grátis com visita técnica')
	.replace(/https:\/\/cupim\.eco\.br\/contato\//g, '/contato/');

const asideIndex = tablesPartFixed.indexOf('\n</div>\n</div>\n<aside');
const tablesWithFaq =
	asideIndex === -1
		? tablesPartFixed + faqBlock
		: tablesPartFixed.slice(0, asideIndex) + faqBlock + tablesPartFixed.slice(asideIndex);

data.content = enrichmentBeforeTables + '\n' + tablesWithFaq;

data.excerpt =
	'Preço de dedetização em SP: tabelas orientativas por quartos, salas e condomínios. Orçamento grátis com visita técnica — Cupim Eco, 0800 111 7272.';
data.seo.description =
	'Quanto custa dedetização em São Paulo? Veja tabelas orientativas, fatores que alteram o preço e como solicitar orçamento grátis com a Cupim Eco. Ligue 0800 111 7272.';
data.seo.title = 'Preço de dedetização em SP | Tabelas e orçamento | Cupim Eco';
data.modified = new Date().toISOString();

writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);

function stripHtml(html) {
	return html
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

const words = stripHtml(data.content).split(/\s+/).filter(Boolean).length;
console.log(`Conteúdo atualizado: ${words} palavras.`);
