// Seeds the dev Directus: four collections, two roles with different rights, three users, sample data.
// Run against a fresh instance: `pnpm dev:up && pnpm dev:seed`. Re-running is a no-op once `tasks` exists.

const URL = process.env['DIRECTUS_URL'] ?? 'http://localhost:8055';
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'] ?? 'admin';

let token = '';

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${URL}${path}`, {
		method,
		headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
	return (text ? JSON.parse(text).data : undefined) as T;
}

const id = (overrides: Record<string, unknown> = {}) => ({
	field: 'id',
	type: 'uuid',
	meta: { hidden: true, readonly: true, interface: 'input', special: ['uuid'] },
	schema: { is_primary_key: true },
	...overrides,
});
const dateUpdated = {
	field: 'date_updated',
	type: 'timestamp',
	meta: { special: ['date-updated'], interface: 'datetime', readonly: true, hidden: true },
	schema: {},
};
const m2o = (field: string, related: string, onDelete: 'SET NULL' | 'CASCADE') => ({
	field: { field, type: 'uuid', meta: { interface: 'select-dropdown-m2o', special: ['m2o'] }, schema: {} },
	relation: { field, related_collection: related, schema: { on_delete: onDelete } },
});

async function createCollection(
	collection: string,
	fields: object[],
	relations: ReturnType<typeof m2o>[] = [],
): Promise<void> {
	await api('POST', '/collections', {
		collection,
		meta: { icon: 'box' },
		schema: {},
		fields: [...fields, ...relations.map((r) => r.field)],
	});
	for (const { relation } of relations) await api('POST', '/relations', { collection, ...relation });
}

async function createRole(name: string, appAccess: boolean, permissions: object[]): Promise<string> {
	const policy = await api<{ id: string }>('POST', '/policies', { name, icon: 'badge', app_access: appAccess, admin_access: false });
	for (const permission of permissions) await api('POST', '/permissions', { policy: policy.id, ...permission });
	const role = await api<{ id: string }>('POST', '/roles', { name, icon: 'badge' });
	await api('POST', '/access', { role: role.id, policy: policy.id });
	return role.id;
}

const all = (collection: string, actions: string[]) =>
	actions.map((action) => ({ collection, action, fields: ['*'], permissions: {}, validation: {} }));

async function main(): Promise<void> {
	token = (await api<{ access_token: string }>('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }))
		.access_token;

	const existing = await api<{ collection: string }[]>('GET', '/collections');
	if (existing.some((c) => c.collection === 'tasks')) {
		console.log('Already seeded (collection "tasks" exists), nothing to do.');
		return;
	}

	await createCollection('projects', [id(), { field: 'name', type: 'string', meta: { required: true }, schema: {} }, dateUpdated]);
	await createCollection(
		'tasks',
		[
			id(),
			{ field: 'title', type: 'string', meta: { required: true }, schema: {} },
			{
				field: 'status',
				type: 'string',
				meta: {
					interface: 'select-dropdown',
					options: { choices: ['todo', 'in_progress', 'done'].map((v) => ({ text: v, value: v })) },
				},
				schema: { default_value: 'todo' },
			},
			{ field: 'description', type: 'text', schema: {} },
			dateUpdated,
		],
		[m2o('project', 'projects', 'SET NULL'), m2o('assignee', 'directus_users', 'SET NULL')],
	);
	// Integer primary key on purpose: exercises the client_key → server_key mapping policy.
	await createCollection(
		'notes',
		[
			{ field: 'id', type: 'integer', meta: { hidden: true, readonly: true }, schema: { is_primary_key: true, has_auto_increment: true } },
			{ field: 'body', type: 'text', schema: {} },
			dateUpdated,
		],
		[m2o('task', 'tasks', 'CASCADE')],
	);
	// Manager-only: on the Core tier this is how "not visible to the caller" looks (whole collection, no row rules).
	await createCollection(
		'invoices',
		[id(), { field: 'amount', type: 'decimal', schema: { numeric_precision: 10, numeric_scale: 2 } }, dateUpdated],
		[m2o('project', 'projects', 'SET NULL')],
	);

	// Core tier (no license) rejects custom rules: item filters, field lists, validation, presets.
	// So the roles differ only per collection/action here; row-level visibility needs a licensed tier (docs/adr/0004).
	const managerRole = await createRole('Manager', true, [
		...all('projects', ['create', 'read', 'update', 'delete']),
		...all('tasks', ['create', 'read', 'update', 'delete']),
		...all('notes', ['create', 'read', 'update', 'delete']),
		...all('invoices', ['create', 'read', 'update', 'delete']),
	]);
	// API-only (no app access): mobile users don't take one of the Core tier's 3 seats.
	const workerRole = await createRole('Worker', false, [
		...all('projects', ['read']),
		...all('tasks', ['read', 'update']),
		...all('notes', ['read', 'create']),
	]);

	const user = (email: string, first_name: string, role: string) =>
		api<{ id: string }>('POST', '/users', { email, password: email.split('@')[0], first_name, role });
	await user('manager@example.com', 'Manager', managerRole);
	const worker = await user('worker@example.com', 'Worker', workerRole);
	const worker2 = await user('worker2@example.com', 'Worker 2', workerRole);

	const projects = await api<{ id: string }[]>('POST', '/items/projects?fields=id', [{ name: 'Kitchen' }, { name: 'Bathroom' }]);
	const [kitchen, bathroom] = projects.map((p) => p.id);
	const tasks = await api<{ id: string }[]>('POST', '/items/tasks?fields=id', [
		{ title: 'Remove old cabinets', project: kitchen, assignee: worker.id, status: 'done' },
		{ title: 'Install countertop', project: kitchen, assignee: worker.id },
		{ title: 'Tile the floor', project: bathroom, assignee: worker2.id },
		{ title: 'Fit the shower', project: bathroom, assignee: worker2.id },
		{ title: 'Order materials', project: bathroom, assignee: null },
	]);
	await api('POST', '/items/notes', [
		{ task: tasks[0]!.id, body: 'Cabinets taken to the dump' },
		{ task: tasks[2]!.id, body: 'Tiles arrive on Friday' },
	]);

	console.log('Seeded. Users (password = part before @): admin@example.com, manager@example.com, worker@example.com, worker2@example.com');
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
