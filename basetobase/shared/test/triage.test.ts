import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { classifyPanels, pickRunName, rateChange, triage } from "../src/triage.ts";

const f = (path: string, add = 1, del = 0) => ({ path, additions: add, deletions: del });
const renamed = (from: string, to: string) => ({
  path: to,
  previousPath: from,
  additions: 0,
  deletions: 0,
});

describe("rateChange", () => {
  it("one small file is green", () =>
    expect(rateChange([f("pkg/id/id.go", 10)], config)).toBe("green"));
  it("four small files is blue", () => {
    const files = [f("pkg/a.go"), f("pkg/b.go"), f("pkg/c.go"), f("pkg/d.go")];
    expect(rateChange(files, config)).toBe("blue");
  });
  it("risk path is black", () => expect(rateChange([f("config.yml", 5)], config)).toBe("black"));
  it("over 300 lines is black", () =>
    expect(rateChange([f("pkg/a.go", 301)], config)).toBe("black"));
  it("CI change is double black", () =>
    expect(rateChange([f(".github/workflows/ci.yml")], config)).toBe("double_black"));
  it("four top-level dirs is double black", () => {
    const files = [f("api/a"), f("app/a"), f("domain/a"), f("pkg/a")];
    expect(rateChange(files, config)).toBe("double_black");
  });
  it("over 1000 lines is double black", () =>
    expect(rateChange([f("pkg/a.go", 1001)], config)).toBe("double_black"));

  it("deletions count toward lines", () =>
    expect(rateChange([f("pkg/a.go", 150, 151)], config)).toBe("black"));
  it("exactly 50 lines in 3 files is green", () => {
    const files = [f("pkg/a.go", 48), f("pkg/b.go"), f("pkg/c.go")];
    expect(rateChange(files, config)).toBe("green");
  });
  it("exactly 300 lines is blue", () =>
    expect(rateChange([f("pkg/a.go", 300)], config)).toBe("blue"));
  it("exactly 1000 lines is black", () =>
    expect(rateChange([f("pkg/a.go", 1000)], config)).toBe("black"));
  it("three top-level dirs stays green", () => {
    const files = [f("api/a"), f("app/a"), f("pkg/a")];
    expect(rateChange(files, config)).toBe("green");
  });
  it("root-level files share one top-level dir", () => {
    const files = [f("a.go"), f("b.go"), f("c.go"), f("pkg/d.go")];
    expect(rateChange(files, config)).toBe("blue");
  });
  it("infra outranks risk", () =>
    expect(rateChange([f(".github/workflows/auth.yml")], config)).toBe("double_black"));
  it("wildcards match inside dot directories", () =>
    expect(rateChange([f(".config/secrets.json", 5)], config)).toBe("black"));
  it.each([
    "domain/billing/invoice.go",
    "pkg/payments/charge.go",
    "pkg/secrets/vault.go",
    "pkg/session/store.go",
    "cmd/oidc/x.go",
  ])("risk directory %s is black", (path) => {
    expect(rateChange([f(path, 5)], config)).toBe("black");
  });
  it("risk words match regardless of case", () => {
    const files = [f("basetobase/dashboard/src/AuthProvider.tsx", 5)];
    expect(rateChange(files, config)).toBe("black");
  });
  it("session inside a name is not a risk path", () =>
    expect(rateChange([f("pkg/user_session.go", 5)], config)).toBe("green"));

  it("a rename out of CI is double black", () => {
    const files = [
      {
        path: "ci-disabled/deploy.yml",
        previousPath: ".github/workflows/deploy.yml",
        additions: 0,
        deletions: 0,
      },
    ];
    expect(rateChange(files, config)).toBe("double_black");
  });
  it("a rename into CI is double black", () =>
    expect(
      rateChange([renamed("ci-disabled/deploy.yml", ".github/workflows/deploy.yml")], config),
    ).toBe("double_black"));
  it("a rename out of a risk path is black", () =>
    expect(rateChange([renamed("pkg/auth/login.go", "pkg/login.go")], config)).toBe("black"));
  it("renames count the top-level dirs of both paths", () => {
    const files = [renamed("api/a", "app/a"), renamed("domain/a", "pkg/a")];
    expect(rateChange(files, config)).toBe("double_black");
  });
  it("a rename is one file", () => {
    const files = [
      renamed("pkg/a.go", "pkg/b.go"),
      renamed("pkg/c.go", "pkg/d.go"),
      renamed("pkg/e.go", "pkg/f.go"),
    ];
    expect(rateChange(files, config)).toBe("green");
  });
});

describe("classifyPanels", () => {
  it("dashboard path is frontend only", () => {
    const files = [f("basetobase/dashboard/src/App.tsx")];
    expect(classifyPanels(files, config)).toEqual(["frontend"]);
  });
  it("mixed paths get both panels in order", () => {
    const files = [f("basetobase/dashboard/x.tsx"), f("main.go")];
    expect(classifyPanels(files, config)).toEqual(["backend", "frontend"]);
  });
  it("paths outside the dashboard are backend only", () => {
    const files = [f("basetobase/dispatch/src/index.ts"), f("main.go")];
    expect(classifyPanels(files, config)).toEqual(["backend"]);
  });
  it.each([
    ["out of", "basetobase/dashboard/src/x.ts", "pkg/x.ts"],
    ["into", "pkg/x.ts", "basetobase/dashboard/src/x.ts"],
  ])("a rename %s the dashboard gets both panels", (_direction, from, to) => {
    expect(classifyPanels([renamed(from, to)], config)).toEqual(["backend", "frontend"]);
  });
  it("a rename within the backend is backend only", () =>
    expect(classifyPanels([renamed("pkg/a.go", "pkg/b.go")], config)).toEqual(["backend"]));
});

describe("pickRunName", () => {
  it("first unused name", () =>
    expect(pickRunName("green", ["Easy Slider"], config)).toBe("Ramp Run"));
  it("all used gets a numbered name", () => {
    const active = ["Easy Slider", "Ramp Run", "Bunny Hill"];
    expect(pickRunName("green", active, config)).toBe("Easy Slider 2");
  });
  it("numbering continues through the list", () => {
    const active = ["Easy Slider", "Ramp Run", "Bunny Hill", "Easy Slider 2"];
    expect(pickRunName("green", active, config)).toBe("Ramp Run 2");
  });
});

describe("triage", () => {
  it("bundles panels, rating, run name and totals", () => {
    const files = [f("basetobase/dashboard/src/auth.ts", 20, 5), f("pkg/a.go", 10, 2)];
    expect(triage(files, ["Red Dog Face"], config)).toEqual({
      panels: ["backend", "frontend"],
      rating: "black",
      runName: "Headwall Face",
      files: 2,
      additions: 30,
      deletions: 7,
    });
  });
});
