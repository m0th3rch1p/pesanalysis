/** Scaffolding marker. Thrown by stubs so a call to unbuilt behaviour fails loudly, never silently. */
export class NotImplemented extends Error {
  constructor(what: string, plan = "docs/IMPLEMENTATION.md") {
    super(`NotImplemented: ${what} (see ${plan})`);
    this.name = "NotImplemented";
  }
}
