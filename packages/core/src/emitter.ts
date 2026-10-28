type Handler<T> = (payload: T) => void;

export class Emitter<Events extends object> {
	private handlers = new Map<keyof Events, Set<Handler<any>>>();

	on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}

	emit<K extends keyof Events>(event: K, payload: Events[K]): void {
		for (const handler of this.handlers.get(event) ?? []) {
			try {
				handler(payload);
			} catch (error) {
				// A failing listener must not break sync; rethrow outside so it still surfaces.
				queueMicrotask(() => {
					throw error;
				});
			}
		}
	}
}
