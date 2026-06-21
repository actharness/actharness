import { PwshSession } from './pwsh-session.js';

export class PwshSessionPool {
  private sessions = new Map<string, PwshSession>();

  getOrCreate(runId: string): PwshSession {
    const existing = this.sessions.get(runId);
    if (existing && existing.isAlive()) {
      return existing;
    }
    const session = new PwshSession();
    session.spawn();
    this.sessions.set(runId, session);
    return session;
  }

  invalidate(runId: string): void {
    this.sessions.delete(runId);
  }

  roll(runId: string): void {
    const session = this.sessions.get(runId);
    if (session) {
      session.kill();
      this.sessions.delete(runId);
    }
  }

  endRun(runId: string): void {
    const session = this.sessions.get(runId);
    if (session) {
      session.kill();
      this.sessions.delete(runId);
    }
  }
}
