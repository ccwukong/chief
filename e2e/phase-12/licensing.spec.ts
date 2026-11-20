import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * Task 12.1: chief is open source under Apache-2.0. These checks are cheap and they matter, because a
 * license file that goes missing quietly turns the project back into "all rights reserved".
 */

const read = (p: string) => readFileSync(join(ROOT_DIR, p), "utf8");

test("E12.1-1 the license and the release metadata are in place and complete", () => {
  // The license itself: the Apache-2.0 terms, with the copyright filled in.
  const license = read("LICENSE");
  expect(license).toContain("Apache License");
  expect(license).toContain("Version 2.0, January 2004");
  expect(license).toContain("END OF TERMS AND CONDITIONS");
  expect(license).toContain("Copyright 2026 Chen Cheng");
  expect(license).not.toContain("[yyyy] [name of copyright owner]"); // the placeholder is filled

  // Every manifest declares it, so npm no longer reports UNLICENSED.
  for (const pkg of ["package.json", "packages/chief/package.json", "packages/web/package.json"]) {
    expect(JSON.parse(read(pkg)).license, pkg).toBe("Apache-2.0");
  }

  // Contributions: inbound = outbound, plus the grant that keeps relicensing possible.
  const contributing = read("CONTRIBUTING.md");
  expect(contributing).toContain("Apache-2.0");
  expect(contributing).toMatch(/relicens|other terms/i);
  expect(contributing).toMatch(/perpetual,\s+worldwide,\s+non-exclusive,\s+royalty-free,\s+irrevocable/i);

  // The README points at the license, and says where the third-party notices come from.
  const readme = read("README.md");
  // A link *to* the file, whatever its label reads: the section names the license and links it, rather than
  // making a reader find the file. (It read `[LICENSE](LICENSE)`, so a better label broke the case.)
  expect(readme).toMatch(/\[[^\]]+\]\(LICENSE\)/);
  expect(readme).toContain("THIRD-PARTY-NOTICES");
  // The copyright notice has exactly one home: `LICENSE` above, and the desktop app's About panel. A copy
  // in a README paragraph is a second thing to keep in sync, which is why it is not there (asked for on
  // 2026-11-20: "why did you put my name there?"). The name itself is not removable — Apache-2.0 §4 makes
  // the notice travel with every distributed copy, and the case above keeps it in the file that travels.
  expect(readme).not.toMatch(/Copyright\s+\d{4}/);
  // The notices are a build product, so there is no list in the tree to keep current (task 15.18).
  expect(existsSync(join(ROOT_DIR, "THIRD-PARTY-NOTICES.md"))).toBe(false);
  expect(existsSync(join(ROOT_DIR, "NOTICE"))).toBe(false);
});
