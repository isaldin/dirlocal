import type { ApiExtensionContext, HookConfig } from '@directus/types';

export type Register = Parameters<HookConfig>[0];
export type ApiContext = ApiExtensionContext;
export type Database = ApiContext['database'];
