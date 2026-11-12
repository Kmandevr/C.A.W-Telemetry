// Builds src/dashboard.js (the module the Worker serves) from src/dashboard.html. Run with `npm run build`.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
writeFileSync(new URL('../src/dashboard.js', import.meta.url),
  `// Generated from src/dashboard.html by scripts/build-dashboard.js: edit the HTML, then run \`npm run build\`.\nexport const DASHBOARD = ${JSON.stringify(html)};\n`);
