import type { EndpointConfig } from '@directus/types';
import { getConfig } from './config';
import { registerCompact } from './endpoints/compact';
import { registerPull } from './endpoints/pull';
import { registerPush } from './endpoints/push';
import { registerSnapshot } from './endpoints/snapshot';

const endpoint: EndpointConfig = {
	id: 'dirlocal',
	handler: (router, context) => {
		const config = getConfig(context.env);
		registerPull(router, context, config);
		registerSnapshot(router, context, config);
		registerPush(router, context, config);
		registerCompact(router, context, config);
	},
};

export default endpoint;
