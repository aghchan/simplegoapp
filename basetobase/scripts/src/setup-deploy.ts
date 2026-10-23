// `npm run setup:deploy`, on the owner's machine: lets basetobase-ci deploy main by itself
// (scripts/src/ci-deploy.ts). Also the last step of `npm run setup`. Rerunnable: each step skips
// what already exists.
import {
  accountProblem,
  accountsOf,
  branchPoliciesOf,
  DEPLOY_ENVIRONMENT,
  DEPLOY_PROBES,
  deployTokenUrl,
  GH_SIGNED_IN,
  looksLikeCloudflareToken,
  MAIN_BRANCH_POLICY,
  probeProblem,
  productionEnvironment,
  REPO,
  tokenProblem,
} from "./setup-lib.ts";
import { askHidden, has, openBrowser, sh, step, yes } from "./io.ts";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const IN_ENV = ["--env", DEPLOY_ENVIRONMENT, "--repo", REPO];

interface Account {
  id: string;
  name: string;
}

async function main(): Promise<void> {
  if (!(await has("gh", GH_SIGNED_IN))) {
    throw new Error("gh is not signed in to github.com: run `gh auth login`");
  }

  step("Production environment");
  const environment = `repos/${REPO}/environments/${DEPLOY_ENVIRONMENT}`;
  await sh("gh", ["api", "-X", "PUT", environment, "--input", "-"], {
    input: JSON.stringify(productionEnvironment()),
    capture: true,
  });
  const policies = branchPoliciesOf(
    JSON.parse(await sh("gh", ["api", `${environment}/deployment-branch-policies`], { capture: true })),
  );
  if (!policies.some((p) => p.name === MAIN_BRANCH_POLICY.name && p.type === MAIN_BRANCH_POLICY.type)) {
    await sh("gh", ["api", "-X", "POST", `${environment}/deployment-branch-policies`, "--input", "-"], {
      input: JSON.stringify(MAIN_BRANCH_POLICY),
      capture: true,
    });
  }
  console.log("Only main can deploy to it, so only main's workflows read its secrets.");
  const others = policies.filter((p) => p.name !== MAIN_BRANCH_POLICY.name).map((p) => p.name);
  if (others.length > 0) {
    console.log(
      `It also lets ${others.join(", ")} deploy; only main should: https://github.com/${REPO}/settings/environments`,
    );
  }

  step("Cloudflare deploy token");
  const secrets = await sh("gh", ["secret", "list", ...IN_ENV], { capture: true });
  const variables = await sh("gh", ["variable", "list", ...IN_ENV], { capture: true });
  const set = secrets.includes("CLOUDFLARE_API_TOKEN") && variables.includes("CLOUDFLARE_ACCOUNT_ID");
  if (!set || (await yes("A deploy token is set. Replace it?"))) {
    const { token, account } = await deployToken();
    await sh("gh", ["secret", "set", "CLOUDFLARE_API_TOKEN", ...IN_ENV], { input: token });
    await sh("gh", ["variable", "set", "CLOUDFLARE_ACCOUNT_ID", ...IN_ENV, "--body", account.id]);
  }

  step("First deploy");
  try {
    await sh("gh", ["workflow", "run", "basetobase-ci.yml", "--repo", REPO, "--ref", "main"], { capture: true });
    console.log(`Deploying main: https://github.com/${REPO}/actions/workflows/basetobase-ci.yml`);
  } catch {
    console.log("main has no deploy job yet. Merging the pull request that adds it deploys main.");
  }
}

async function deployToken(): Promise<{ token: string; account: Account }> {
  const url = deployTokenUrl();
  console.log("Create the token. Cloudflare's form opens with its permissions filled in:");
  console.log(url);
  console.log("Under Account Resources pick your account, then Continue to summary → Create Token.");
  openBrowser(url);
  for (;;) {
    let token = await askHidden("Paste the token (hidden): ");
    while (!looksLikeCloudflareToken(token)) {
      token = await askHidden("That is not a Cloudflare API token. Paste it again: ");
    }
    const checked = await checkToken(token);
    if (typeof checked !== "string") return { token, account: checked };
    console.log(checked);
  }
}

// The account the token reaches, or why it is refused.
async function checkToken(token: string): Promise<Account | string> {
  const get = async (path: string) => {
    const res = await fetch(`${CLOUDFLARE_API}${path}`, { headers: { Authorization: `Bearer ${token}` } }).catch(
      (error: unknown) => {
        throw new Error(`could not reach api.cloudflare.com (${error instanceof Error ? error.message : error})`);
      },
    );
    return { status: res.status, body: (await res.json().catch(() => undefined)) as unknown };
  };
  const verify = await get("/user/tokens/verify");
  const refused = tokenProblem(verify.status, verify.body);
  if (refused) return refused;
  const accounts = accountsOf((await get("/accounts")).body);
  const scope = accountProblem(accounts);
  if (scope) return scope;
  const account = accounts[0]!;
  for (const probe of DEPLOY_PROBES) {
    const problem = probeProblem(probe, (await get(probe.path(account.id))).status);
    if (problem) return problem;
  }
  console.log(`The token reads Workers and D1 in ${account.name}. Its edit rights show at the first deploy.`);
  return account;
}

main().catch((error: unknown) => {
  console.error(`\nSetup stopped: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix that and rerun `npm run setup:deploy`; finished steps are skipped.");
  process.exit(1);
});
