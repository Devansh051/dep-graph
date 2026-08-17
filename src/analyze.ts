/**
 * Temporary analysis script — understand catalog structure deeply.
 */
import { readFileSync } from "fs";

const d: any[] = JSON.parse(readFileSync("github_catalog.json", "utf-8"));

// 1. Analyze output $defs entity names
const defNameCounts: Record<string, number> = {};
for (const t of d) {
  const defs = t.outputParameters?.$defs || {};
  for (const name of Object.keys(defs)) {
    defNameCounts[name] = (defNameCounts[name] || 0) + 1;
  }
}
console.log("=== Most common $def names ===");
Object.entries(defNameCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 40)
  .forEach(([k, v]) => console.log(`  ${v}x ${k}`));

// 2. Analyze what $defs contain 'number' and 'id' fields
console.log("\n=== $defs with 'number' field ===");
const numberDefs = new Set<string>();
const idDefs = new Set<string>();
for (const t of d) {
  const defs = t.outputParameters?.$defs || {};
  for (const [name, def] of Object.entries(defs)) {
    const props = (def as any).properties || {};
    if (props.number) numberDefs.add(name);
    if (props.id) idDefs.add(name);
  }
}
console.log([...numberDefs].sort().join(", "));
console.log("\n=== $defs with 'id' field ===");
console.log([...idDefs].sort().join(", "));

// 3. Sample tool with issue_number input — what does description say?
console.log("\n=== Tools requiring issue_number ===");
for (const t of d) {
  const req = t.inputParameters?.required || [];
  if (req.includes("issue_number")) {
    const param = t.inputParameters.properties.issue_number;
    console.log(`  ${t.slug}: type=${param.type}, desc="${param.description?.slice(0, 120)}"`);
  }
}

// 4. Sample tool with pull_number input
console.log("\n=== Tools requiring pull_number ===");
for (const t of d) {
  const req = t.inputParameters?.required || [];
  if (req.includes("pull_number")) {
    const param = t.inputParameters.properties.pull_number;
    console.log(`  ${t.slug}: type=${param.type}, desc="${param.description?.slice(0, 120)}"`);
  }
}

// 5. Sample tool with comment_id input
console.log("\n=== Tools requiring comment_id ===");
for (const t of d) {
  const req = t.inputParameters?.required || [];
  if (req.includes("comment_id")) {
    const param = t.inputParameters.properties.comment_id;
    console.log(`  ${t.slug}: type=${param.type}, desc="${param.description?.slice(0, 120)}"`);
  }
}

// 6. What does the Issue $def look like (sample)?
console.log("\n=== Issue $def fields (sample) ===");
for (const t of d) {
  const defs = t.outputParameters?.$defs || {};
  if (defs.Issue) {
    const props = defs.Issue.properties || {};
    console.log(Object.keys(props).join(", "));
    console.log("number desc:", props.number?.description);
    console.log("id desc:", props.id?.description);
    break;
  }
}

// 7. What does PullRequest $def look like?
console.log("\n=== PullRequest / PullRequestSimple $def fields ===");
for (const t of d) {
  const defs = t.outputParameters?.$defs || {};
  const prDef = defs.PullRequest || defs.PullRequestSimple;
  if (prDef) {
    const props = prDef.properties || {};
    console.log("Def name:", defs.PullRequest ? "PullRequest" : "PullRequestSimple");
    console.log("Fields:", Object.keys(props).slice(0, 30).join(", "));
    console.log("number desc:", props.number?.description);
    console.log("id desc:", props.id?.description);
    break;
  }
}

// 8. Analyze all distinct required input param names and their frequencies
console.log("\n=== All required input params (frequency) ===");
const inputFreq: Record<string, number> = {};
for (const t of d) {
  const req = t.inputParameters?.required || [];
  for (const r of req) {
    inputFreq[r] = (inputFreq[r] || 0) + 1;
  }
}
// Filter to likely entity IDs  
const entityLike = Object.entries(inputFreq)
  .filter(([k]) => k.match(/_(id|number|sha)$/) || k === "ref")
  .sort((a, b) => b[1] - a[1]);
console.log("Entity-ID-like required inputs:");
entityLike.forEach(([k, v]) => console.log(`  ${v}x ${k}`));
