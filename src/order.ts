// Boot order: dependencies first, and otherwise the order the list was given in.

export interface Node {
	readonly name: string;
	readonly deps: ReadonlyArray<Node>;
}

function describeCycle(stuck: ReadonlyArray<Node>): string {
	const path = new Array<Node>();
	let at: Node | undefined = stuck[0];
	while (at !== undefined && !path.includes(at)) {
		path.push(at);
		at = at.deps.find((dep) => stuck.includes(dep));
	}
	if (at === undefined) return stuck.map((node) => node.name).join(", ");
	const start = path.indexOf(at);
	const cycle = path.filter((_, index) => index >= start).map((node) => node.name);
	cycle.push(at.name);
	return cycle.join(" -> ");
}

/** Throws on a repeated name, a dependency that isn't in the list, or a cycle. */
export function order<T extends Node>(nodes: ReadonlyArray<T>): ReadonlyArray<T> {
	const listed = new Set<Node>();
	const names = new Set<string>();
	for (const node of nodes) {
		assert(!names.has(node.name), `trellis: "${node.name}" is listed twice`);
		names.add(node.name);
		listed.add(node);
	}
	for (const node of nodes) {
		for (const dep of node.deps) {
			if (!listed.has(dep)) {
				error(
					`trellis: "${node.name}" depends on "${dep.name}", which is not in the list`,
					0,
				);
			}
		}
	}

	const placed = new Set<Node>();
	const result = new Array<T>();
	while (result.size() < nodes.size()) {
		const ready = nodes.find(
			(node) => !placed.has(node) && node.deps.every((dep) => placed.has(dep)),
		);
		if (ready === undefined) {
			const stuck = nodes.filter((node) => !placed.has(node));
			error(`trellis: dependency cycle ${describeCycle(stuck)}`, 0);
		}
		placed.add(ready);
		result.push(ready);
	}
	return result;
}
