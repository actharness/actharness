// H1+H2: zero imports — describe, it, actspec, expect all come from --import register.ts

describe('actspec stub', () => {
  it('run() returns a success result', async () => {
    const result = await actspec('./action.yml').run({ inputs: { name: 'World' } });
    expect(result).toHaveSucceeded();
  });

  it('outputs are available', async () => {
    const result = await actspec('./action.yml').run();
    expect(result).toHaveOutput('greeting');
    expect(result).toHaveOutput('greeting', 'Hello World');
  });

  it('mock captures calls', async () => {
    const action = actspec('./action.yml');
    const checkout = action.mock('actions/checkout@v4', { outputs: { ref: 'abc' } });
    await action.run();
    expect(checkout).toHaveBeenCalledWith({ name: 'World' });
  });
});

describe('expect() primitives', () => {
  it('toBe passes for equal primitives', () => {
    expect(1 + 1).toBe(2);
    expect('hello').toBe('hello');
  });

  it('toEqual passes for structurally equal values', () => {
    expect({ a: 1 }).toEqual({ a: 1 });
  });

  it('.not inverts the matcher', () => {
    expect(42).not.toBe(99);
    expect('hello').not.toBe('world');
  });
});
