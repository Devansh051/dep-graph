import { readFileSync } from 'fs';

const d = JSON.parse(readFileSync('github_catalog.json', 'utf8'));

// Examine a few key tools
const slugsToExamine = [
  'GITHUB_LIST_REPOSITORY_ISSUES',
  'GITHUB_CREATE_AN_ISSUE',
  'GITHUB_CREATE_AN_ISSUE_COMMENT',
  'GITHUB_LIST_PULL_REQUESTS',
  'GITHUB_MERGE_A_PULL_REQUEST',
  'GITHUB_GET_AN_ISSUE',
  'GITHUB_CREATE_A_PULL_REQUEST',
];

for (const slug of slugsToExamine) {
  const t = d.find(t => t.slug === slug);
  if (!t) { console.log(`${slug}: NOT FOUND`); continue; }
  
  // Extract output field names recursively from $defs
  const defs = t.outputParameters.$defs || {};
  const allOutputFields = new Set();
  
  function extractFields(schema, depth = 0) {
    if (depth > 4) return;
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(props)) {
      allOutputFields.add(k);
      if (v.properties) extractFields(v, depth + 1);
      if (v.$ref) {
        const refName = v.$ref.replace('#/$defs/', '');
        if (defs[refName]) extractFields(defs[refName], depth + 1);
      }
      if (v.items && v.items.$ref) {
        const refName = v.items.$ref.replace('#/$defs/', '');
        if (defs[refName]) extractFields(defs[refName], depth + 1);
      }
    }
  }
  
  for (const def of Object.values(defs)) {
    extractFields(def);
  }
  
  const inputRequired = t.inputParameters.required || [];
  const inputAll = Object.keys(t.inputParameters.properties || {});
  
  console.log(`\n=== ${slug} ===`);
  console.log('Required inputs:', inputRequired);
  console.log('All inputs:', inputAll);
  console.log('Output fields (from $defs):', [...allOutputFields].sort());
  console.log('Tags:', t.tags);
}

// Now check: for issue_number - which tools have it in output?
console.log('\n\n=== Tools that produce issue-related output fields ===');
const targetFields = ['number', 'issue_number', 'pull_number', 'comment_id', 'id', 'gist_id'];

for (const field of targetFields) {
  const producers = [];
  for (const t of d) {
    const defs = t.outputParameters.$defs || {};
    let hasField = false;
    
    function checkFields(schema, depth = 0) {
      if (depth > 3 || hasField) return;
      const props = schema.properties || {};
      if (props[field]) { hasField = true; return; }
      for (const v of Object.values(props)) {
        if (v.$ref) {
          const refName = v.$ref.replace('#/$defs/', '');
          if (defs[refName]) checkFields(defs[refName], depth + 1);
        }
        if (v.items && v.items.$ref) {
          const refName = v.items.$ref.replace('#/$defs/', '');
          if (defs[refName]) checkFields(defs[refName], depth + 1);
        }
      }
    }
    
    for (const def of Object.values(defs)) {
      checkFields(def);
    }
    
    if (hasField) producers.push(t.slug);
  }
  console.log(`\n${field} producers (${producers.length}):`, producers.slice(0, 15).join(', '), producers.length > 15 ? '...' : '');
}
