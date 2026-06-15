import type { ImageMetadata } from 'astro';
import dedetizacaoImg from '../assets/servicos/dedetizacao.webp';
import descupinizacaoImg from '../assets/servicos/descupinizacao.webp';
import deratizacaoImg from '../assets/servicos/deratizacao.webp';
import sanitizacaoImg from '../assets/servicos/sanitizacao.jpg';
import mosquitosImg from '../assets/servicos/mosquitos.webp';
import contratosImg from '../assets/servicos/contratos-empresariais.webp';

export interface ServiceImage {
	src: ImageMetadata;
	width: number;
	height: number;
}

export const serviceImages: Record<string, ServiceImage> = {
	'/dedetizacao': { src: dedetizacaoImg, width: 1536, height: 1024 },
	'/descupinizacao': { src: descupinizacaoImg, width: 1536, height: 1024 },
	'/deratizacao': { src: deratizacaoImg, width: 1024, height: 682 },
	'/sanitizacao': { src: sanitizacaoImg, width: 600, height: 400 },
	'/controle-de-mosquitos': { src: mosquitosImg, width: 1536, height: 1024 },
	'/contratos-empresariais': { src: contratosImg, width: 1024, height: 683 },
};

export function getServiceImage(href: string): ServiceImage | undefined {
	return serviceImages[href];
}
