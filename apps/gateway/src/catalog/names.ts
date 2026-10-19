/**
 * Asset display names shared by the search catalog and the exchanges' symbol lookups, so a
 * pair reads the same everywhere ("XRP / TetherUS"). The catalog fills it from every
 * exchange's names; until then, codes stand in.
 */
export class AssetNames {
  private names: ReadonlyMap<string, string> = new Map();

  update(names: ReadonlyMap<string, string>): void {
    this.names = names;
  }

  nameOf(code: string): string {
    return this.names.get(code) ?? code;
  }

  describe(base: string, quote: string): string {
    return `${this.nameOf(base)} / ${this.nameOf(quote)}`;
  }
}
