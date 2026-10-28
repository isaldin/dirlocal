import type { EndpointConfig } from '@directus/types';
import { registerVisible } from './endpoints/visible';

const endpoint: EndpointConfig = {
	id: 'dirlocal',
	handler: (router, context) => {
		registerVisible(router, context);
	},
};

export default endpoint;
