// H4+H5: intentionally failing tests — prove failure messages are actionable.
// This file always exits non-zero. Run via `npm run test:fail`.

describe('failure messages', () => {
  it('toHaveFailed on a success result shows conclusion', async () => {
    const result = await actspec('./action.yml').run();
    // stub always returns success — this fails intentionally
    expect(result).toHaveFailed();
  });

  it('toHaveOutput with wrong value shows key + actual + expected', async () => {
    const result = await actspec('./action.yml').run();
    expect(result).toHaveOutput('greeting', 'Hello Nobody');
  });

  it('.not.toHaveSucceeded on a success result shows message', async () => {
    const result = await actspec('./action.yml').run();
    expect(result).not.toHaveSucceeded();
  });

  it('toBe mismatch shows actual vs expected', () => {
    expect('hello').toBe('world');
  });
});
