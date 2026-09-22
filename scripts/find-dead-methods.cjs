/**
 * اسکن یک‌بارهٔ متدهای مردهٔ سرویس‌ها:
 * متدهای async که خارج از فایل تعریفشان هیچ فراخوانی ندارند.
 * ابزار موقتِ ممیزی است — نتیجه باید دستی تأیید شود (name collision ممکن است).
 */
const fs = require('fs')
const path = require('path')

function walk(d) {
  let r = []
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) r = r.concat(walk(p))
    else if (p.endsWith('.ts')) r.push(p)
  }
  return r
}

const files = walk('src')
const content = new Map()
for (const f of files) content.set(f, fs.readFileSync(f, 'utf8'))

const dead = []
for (const f of files) {
  const norm = f.replace(/\\/g, '/')
  if (!norm.includes('/modules/')) continue
  const src = content.get(f)
  const re = /async ([a-zA-Z][a-zA-Z0-9]*)\(/g
  let m
  while ((m = re.exec(src))) {
    const meth = m[1]
    if (meth === 'constructor') continue
    const needle = '.' + meth + '('
    let refs = 0
    let ownRefs = 0
    for (const [g, c] of content) {
      const count = c.split(needle).length - 1
      if (count === 0) continue
      if (g === f) ownRefs += count
      else refs += count
    }
    if (refs === 0) dead.push(norm + ' -> ' + meth + ' (ownRefs=' + ownRefs + ')')
  }
}
console.log(dead.join('\n'))
console.log('total dead:', dead.length)
