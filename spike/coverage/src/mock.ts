import type { ActionMock, ActionMockCall, ActionMockDef, ActionMockImpl, GitHubApiRoutes } from './types.js';

class ActionMockImpl_ implements ActionMock {
  readonly calls: ActionMockCall[] = [];
  private _def: ActionMockDef = {};
  private _impl: ActionMockImpl | null = null;
  private _onceQueue: ActionMockImpl[] = [];

  get called(): boolean { return this.calls.length > 0; }
  get callCount(): number { return this.calls.length; }

  mockOutputs(outputs: Record<string, string>): this { this._def = { ...this._def, outputs }; return this; }
  mockConclusion(c: 'success' | 'failure'): this { this._def = { ...this._def, conclusion: c }; return this; }
  mockImplementation(impl: ActionMockImpl): this { this._impl = impl; return this; }
  mockImplementationOnce(impl: ActionMockImpl): this { this._onceQueue.push(impl); return this; }
  clear(): void { this.calls.length = 0; this._onceQueue.length = 0; }

  async invoke(callEnv: { with: Record<string, string>; env: Record<string, string> }): Promise<ActionMockDef> {
    const onceImpl = this._onceQueue.shift();
    const implToUse = onceImpl ?? this._impl;
    let resultDef: ActionMockDef = { ...this._def };
    if (implToUse) {
      const returned = await implToUse(callEnv);
      if (returned) resultDef = { ...resultDef, ...returned };
    }
    this.calls.push({ with: callEnv.with, env: callEnv.env, outputs: resultDef.outputs ?? {} });
    return resultDef;
  }
}

export class MockRegistry {
  private readonly _mocks = new Map<string, ActionMockImpl_>();
  private _githubApiRoutes: GitHubApiRoutes = {};

  mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock {
    const m = new ActionMockImpl_();
    if (typeof def === 'function') { m.mockImplementation(def); }
    else if (def) { if (def.outputs) m.mockOutputs(def.outputs); if (def.conclusion) m.mockConclusion(def.conclusion); }
    this._mocks.set(normalizeRef(ref), m);
    return m;
  }

  mockGitHubApi(routes: GitHubApiRoutes): void { this._githubApiRoutes = { ...this._githubApiRoutes, ...routes }; }
  get githubApiRoutes(): GitHubApiRoutes { return this._githubApiRoutes; }
  hasMock(ref: string): boolean { return this._mocks.has(normalizeRef(ref)); }

  async invoke(ref: string, callEnv: { with: Record<string, string>; env: Record<string, string> }): Promise<ActionMockDef> {
    const m = this._mocks.get(normalizeRef(ref));
    if (!m) throw new Error(`No mock registered for ref: ${ref}`);
    return m.invoke(callEnv);
  }

  reset(): void { this._mocks.clear(); this._githubApiRoutes = {}; }
  clearCalls(): void { for (const m of this._mocks.values()) m.clear(); }
}

function normalizeRef(ref: string): string { return ref.trim().toLowerCase(); }
