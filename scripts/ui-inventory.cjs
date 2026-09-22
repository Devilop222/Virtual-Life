/* Static inventory: includes Persian literals/templates and every Telegram route.
 * Deliberately includes domain labels/errors; no regex-only extraction or comments.
 * Run after UI changes: node scripts/ui-inventory.cjs
 */
const ts = require('typescript')
const fs = require('fs')
const path = require('path')
const texts = [], routes = [], tables = {}
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) { scan(file); continue }
    if (!file.endsWith('.ts')) continue
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node) {
      const loc = source.getLineAndCharacterOfPosition(node.getStart(source))
      if (file.endsWith('command-catalog.ts') && ts.isVariableDeclaration(node) && ['EXACT_SECTIONS', 'SECTION_KEYWORDS', 'SECTION_TITLES', 'SECTION_CHAT_POLICY'].includes(node.name.getText(source)) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        tables[node.name.getText(source)] = Object.fromEntries(node.initializer.properties.filter(ts.isPropertyAssignment).map(p => [ts.isStringLiteral(p.name) ? p.name.text : p.name.getText(source), p.initializer.text]))
      }

      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && /[\u0600-\u06ff]/.test(node.getText(source))) {
        texts.push({ file, line: loc.line + 1, kind: ts.SyntaxKind[node.kind], text: node.getText(source) })
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['command','hears','callbackQuery','on'].includes(node.expression.name.text)) {
        routes.push({ file, line: loc.line + 1, type: node.expression.name.text, trigger: node.arguments[0]?.getText(source) })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}
scan('src')
fs.mkdirSync('docs', { recursive: true })
fs.writeFileSync('docs/ui-text-inventory.jsonl', texts.map(v => JSON.stringify(v)).join('\n') + '\n')
fs.writeFileSync('docs/telegram-routes.json', JSON.stringify(routes, null, 2) + '\n')
console.log(`${texts.length} text candidates, ${routes.length} routes`)

const keywords = Object.entries(tables.EXACT_SECTIONS).map(([trigger, section]) => ({ trigger, syntax: trigger, location: tables.SECTION_CHAT_POLICY[section], result: tables.SECTION_TITLES[section], canonical: tables.SECTION_KEYWORDS[section] }))
fs.writeFileSync('docs/keyword-guide.json', JSON.stringify(keywords, null, 2) + '\n')
console.log(`${keywords.length} exact keyword forms inventoried`)
