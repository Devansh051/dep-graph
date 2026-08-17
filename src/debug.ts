import { readFileSync } from "fs";

const d = JSON.parse(readFileSync("github_catalog.json", "utf8"));

// Check depth of Repository $def in a few tools
const slugs = [
  "GITHUB_LIST_REPOSITORY_ISSUES",
  "GITHUB_CREATE_AN_ISSUE",
  "GITHUB_LIST_PULL_REQUESTS",
  "GITHUB_LIST_REPOSITORIES_FOR_A_USER",
  "GITHUB_CREATE_A_REPOSITORY",
  "GITHUB_GET_A_REPOSITORY",
];

for (const slug of slugs) {
  const t = d.find((t: any) => t.slug === slug);
  if (!t) continue;
  
  const defs = t.outputParameters?.$defs || {};
  
  // Find Repository def and its depth
  const dataRef = t.outputParameters?.properties?.data?.$ref;
  if (!dataRef) continue;
  
  const mainRef = dataRef.replace("#/$defs/", "");
  console.log(`\n=== ${slug} ===`);
  console.log(`Main response: ${mainRef}`);
  
  // Walk and track depth
  const visited = new Set();
  function walk(defName: string, depth: number) {
    if (visited.has(defName) || depth > 4) return;
    visited.add(defName);
    const def = defs[defName];
    if (!def) return;
    
    if (defName === "Repository" || defName.includes("Repository")) {
      console.log(`  Repository "${'  '.repeat(depth)}${defName}" at depth ${depth}`);
      const props = def.properties || {};
      if (props.id) console.log(`    → id at depth ${depth} (${props.id.description?.slice(0, 60)})`);
    }
    
    const props = def.properties || {};
    for (const [, prop] of Object.entries(props)) {
      const p = prop as any;
      if (p.$ref) {
        walk(p.$ref.replace("#/$defs/", ""), depth + 1);
      }
      if (p.items?.$ref) {
        walk(p.items.$ref.replace("#/$defs/", ""), depth + 1);
      }
    }
  }
  
  walk(mainRef, 0);
}
