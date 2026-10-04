import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { validateArtifacts } from "../../src/benchmark/validate-artifacts.js";

describe("Validate Artifacts Test Suite: Negative Fixture Rejection", () => {
  const baseDir = path.join(process.cwd(), "results");
  const createdDirs: string[] = [];

  function createTestFixture(): string {
    const dir = path.join(process.cwd(), "test", "fixtures", `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    createdDirs.push(dir);
    for (const f of ["run_config.json", "publication_trials.csv", "verification_queries.csv", "resource_measurements.csv", "correctness_tests.csv"]) {
      fs.copyFileSync(path.join(baseDir, f), path.join(dir, f));
    }
    return dir;
  }

  afterEach(() => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir && fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        } catch {}
      }
    }
  });

  it("Rejects negative fixture with TC-4 field mismatch (expected_pub=PUBLISHED != observed_pub=INSUFFICIENT_EVIDENCE)", () => {
    const tmpFixtureDir = createTestFixture();
    const corPath = path.join(tmpFixtureDir, "correctness_tests.csv");
    const content = fs.readFileSync(corPath, "utf8");
    // Inject old bad TC-4 row with mismatch
    const badContent = content.replace(
      /TC-4.*INSUFFICIENT_EVIDENCE.*PASS/,
      'TC-4,"Invalid institution signature",C1,NOT_AUTHENTIC,NOT_AUTHENTIC,PUBLISHED,INSUFFICIENT_EVIDENCE,NO_REVOCATION_OBSERVED,NO_REVOCATION_OBSERVED,PASS'
    );
    fs.writeFileSync(corPath, badContent);

    const report = validateArtifacts(tmpFixtureDir);
    expect(report.overallPassed).toBe(false);
    expect(report.correctnessTestsValid).toBe(false);
    expect(report.validationErrors.some((e) => e.includes("TC-4") && e.includes("mismatch"))).toBe(true);
  });

  it("Rejects negative fixture with timestamp order inversion in publication trials", () => {
    const tmpFixtureDir = createTestFixture();
    const pubPath = path.join(tmpFixtureDir, "publication_trials.csv");
    const content = fs.readFileSync(pubPath, "utf8").split("\n");
    // Invert first acceptance and submission on row 1
    const cols = content[1].split(",");
    cols[8] = (parseFloat(cols[7]) - 100).toString(); // first acceptance < submission
    content[1] = cols.join(",");
    fs.writeFileSync(pubPath, content.join("\n"));

    const report = validateArtifacts(tmpFixtureDir);
    expect(report.overallPassed).toBe(false);
    expect(report.timestampOrderValid).toBe(false);
    expect(report.validationErrors.some((e) => e.includes("first acceptance"))).toBe(true);
  });

  it("Rejects negative fixture with verification latency arithmetic mismatch", () => {
    const tmpFixtureDir = createTestFixture();
    const verPath = path.join(tmpFixtureDir, "verification_queries.csv");
    const content = fs.readFileSync(verPath, "utf8").split("\n");
    const cols = content[1].split(",");
    cols[6] = "9999.00"; // Total latency corrupted != retrieval + local
    content[1] = cols.join(",");
    fs.writeFileSync(verPath, content.join("\n"));

    const report = validateArtifacts(tmpFixtureDir);
    expect(report.overallPassed).toBe(false);
    expect(report.verificationLatencyArithmeticValid).toBe(false);
    expect(report.validationErrors.some((e) => e.includes("total latency"))).toBe(true);
  });

  it("Rejects negative fixture with duplicate publication rows", () => {
    const tmpFixtureDir = createTestFixture();
    const pubPath = path.join(tmpFixtureDir, "publication_trials.csv");
    const content = fs.readFileSync(pubPath, "utf8").trim().split("\n");
    content.push(content[1]); // Duplicate row 1
    fs.writeFileSync(pubPath, content.join("\n"));

    const report = validateArtifacts(tmpFixtureDir);
    expect(report.overallPassed).toBe(false);
    expect(report.duplicatePublicationRows).toBeGreaterThan(0);
  });

  it("Rejects negative fixture with corrupted run_config (missing required fields or invalid deadline)", () => {
    const tmpFixtureDir = createTestFixture();
    const cfgPath = path.join(tmpFixtureDir, "run_config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.retryPolicy.deadlineMs = 5000; // Expected 1000ms
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const report = validateArtifacts(tmpFixtureDir);
    expect(report.overallPassed).toBe(false);
    expect(report.runConfigValid).toBe(false);
    expect(report.validationErrors.some((e) => e.includes("deadline"))).toBe(true);
  });
});
