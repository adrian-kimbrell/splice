// Ambient globals injected by the WebdriverIO test runner
import type { Browser } from "webdriverio";

declare global {
  const browser: Browser;
  function describe(name: string, fn: (this: Mocha.Suite) => void): void;
  function it(name: string, fn: () => Promise<void> | void): void;
  function before(fn: () => Promise<void> | void): void;
  function after(fn: () => Promise<void> | void): void;
  function expect<T>(val: T): Chai.Assertion;
}
