export type AddonContext = {
  addonID: string;
  addonVersion: string;
  addonRoot: string;
};

export class Addon {
  public readonly data: AddonContext;
  public readonly hooks: typeof import("./hooks").default;

  constructor(data: AddonContext, hooks: typeof import("./hooks").default) {
    this.data = data;
    this.hooks = hooks;
  }
}