import type { HookConfig } from '@directus/types';
import { registerChangeLog } from './hooks/changes';
import { ensureTables } from './hooks/schema';

// Typed config instead of defineHook(): the helper is an identity function that pulls zod into the bundle.
const hook: HookConfig = (register, context) => {
	register.init('app.before', () => ensureTables(context.database));
	registerChangeLog(register, context);
};

export default hook;
