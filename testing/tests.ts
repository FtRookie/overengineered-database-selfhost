import { beforeEach, afterEach, test } from "bun:test";

// todo: implement testing (https://bun.sh/docs/test/lifecycle)

// run with 
// bun test .\testing\tests.ts
beforeEach(() =>
{
    console.log("running test.");
});

afterEach(() =>
{
    console.log("done with test.");
});

// tests
test("example test", () =>
{

});