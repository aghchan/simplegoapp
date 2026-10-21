import type { TestProject } from "vitest/node";
import { rsaKeyPair } from "./helpers.ts";

declare module "vitest" {
  export interface ProvidedContext {
    githubAppPrivateKey: string;
  }
}

// Runs in Node, once per run: the key is bound into the Workers runtime by vitest.config.ts.
export default async function setup(project: TestProject): Promise<void> {
  const { privatePem } = await rsaKeyPair();
  project.provide("githubAppPrivateKey", privatePem);
}
