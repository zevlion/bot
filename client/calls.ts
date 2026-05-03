import type { WACallEvent } from "../lib";

export default async (ev?: WACallEvent[]) => {
	console.log(ev);
};
