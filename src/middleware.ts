import { defineMiddleware } from 'astro:middleware';
import gonePolicy from './data/seo/gone-410-policy.json';

const goneKeys = new Set(
	(gonePolicy.gone ?? []).map((item) => String(item).replace(/^\/+|\/+$/g, '').toLowerCase()),
);

const GONE_HTML = `<!doctype html>
<html lang="pt-BR">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="robots" content="noindex, follow" />
		<title>Conteúdo removido | Cupim Eco</title>
	</head>
	<body>
		<main style="max-width: 720px; margin: 4rem auto; padding: 0 1rem; font-family: system-ui, sans-serif;">
			<h1>Conteúdo removido</h1>
			<p>Esta página não existe mais e não tem um substituto equivalente.</p>
			<p><a href="/">Voltar para a página inicial</a></p>
		</main>
	</body>
</html>
`;

export const onRequest = defineMiddleware(async (context, next) => {
	const key = context.url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();

	if (key && goneKeys.has(key)) {
		return new Response(GONE_HTML, {
			status: 410,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'X-Robots-Tag': 'noindex',
			},
		});
	}

	return next();
});
