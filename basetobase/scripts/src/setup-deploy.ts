// `npm run setup:deploy`, on the owner's machine: lets basetobase-ci deploy main by itself
// (scripts/src/ci-deploy.ts). Also the last step of `npm run setup`. Rerunnable: each step skips
// what already exists.
import {
  accountsOf,
  DEPLOY_ENVIRONMENT,
  DEPLOY_PROBES,
  deployTokenUrl,
  looksLikeCloudflareToken,
  productionEnvironment,
  REPO,
  tokenIsActive,
} from "./setup-lib.ts";
import { ask, askHidden, has, openBrowser, sh, step, yes } from "./io.ts";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const IN_ENV = ["--env", DEPLOY_ENVIRONMENT, "--repo", REPO];

interface Account {
  id: string;
  name: string;
}

async function main(): Promise<void> {
  if (!(await has("gh", ["auth", "status"]))) {
    throw new Error("gh is not signed in: run `gh auth login`");
  }

  step("Production environment");
  const environment = ["api", "-X", "PUT", `repos/${REPO}/environments/${DEPLOY_ENVIRONMENT}`, "--input", "-"];
  await sh("gh", environment, { input: JSON.stringify(productionEnvironment()), capture: true });
  console.log("Only protected branches can deploy to it, so only main reads its secrets.");
  if (!(await has("gh", ["api", `repos/${REPO}/branches/main/protection`]))) {
    console.log("main is not protected, so nothing can deploy yet: run `npm run setup` (Branch protection).");
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

// The account the token deploys to, or why it cannot.
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
  if (!tokenIsActive(verify.body)) return `Cloudflare does not accept that token (HTTP ${verify.status}).`;
  const accounts = accountsOf((await get("/accounts")).body);
  if (accounts.length === 0) return "That token reaches no account: give it yours under Account Resources.";
  const account = accounts.length === 1 ? accounts[0]! : await pickAccount(accounts);
  for (const probe of DEPLOY_PROBES) {
    const { status } = await get(probe.path(account.id));
    if (status !== 200) {
      return `That token cannot read ${probe.what} (HTTP ${status}): it needs ${probe.permission}. Create it again from the link.`;
    }
  }
  console.log(`The token deploys to ${account.name}.`);
  return account;
}

async function pickAccount(accounts: Account[]): Promise<Account> {
  accounts.forEach((account, i) => console.log(`${i + 1}. ${account.name}`));
  for (;;) {
    const picked = accounts[Number(await ask("Which account runs Base to Base? Number:")) - 1];
    if (picked) return picked;
  }
}

main().catch((error: unknown) => {
  console.error(`\nSetup stopped: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Fix that and rerun `npm run setup:deploy`; finished steps are skipped.");
  process.exit(1);
});
