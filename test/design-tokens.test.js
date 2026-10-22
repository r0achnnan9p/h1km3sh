import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const publicDir = new URL('../public/', import.meta.url);
function checkCss(input) {
  const whole = input.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(whole, /@import|https?:\/\/|\bInter\b/i, '禁止外部字体/Inter');
  // Feature-query values test browser support; they are not theme declarations.
  const source = whole.replace(/@supports[^{};]+\{/g, '@supports {').replace(/:root\s*\{[^}]*\}/g, '');
  assert.doesNotMatch(source, /#[a-f\d]{3,8}\b|\bhsla?\(/i, '彩色值只在 root token 声明');
  for (const match of source.matchAll(/\brgba?\([^)]*\)/g)) assert.match(match[0], /^rgba\((255,255,255|0,0,0),\.(04|06|08|10|12|14|16|18|20|22|28|35|55)\)$/);
  for (const [, value] of source.matchAll(/border-radius:\s*([^;{}]+)/g)) {
    const remaining = value.replace(/var\(--radius(?:-[a-z]+)?\)/g, '').replace(/\b(?:0|inherit)\b/g, '').trim();
    assert.equal(remaining, '', '圆角必须来自已登记 token');
  }
  for (const [, value] of source.matchAll(/(?:box-shadow|backdrop-filter):\s*([^;{}]+)/g)) assert.match(value, /^(none|var\(--glass(?:-prompt)?-(?:shadow|blur)\))$/);
}
test('控制台样式只用Token', () => {
  for (const name of fs.readdirSync(publicDir).filter(name => name.endsWith('.css'))) {
    checkCss(fs.readFileSync(new URL(name, publicDir), 'utf8'));
  }
});
test('全部前端JavaScript的静态SVG集中在图标注册表', () => {
  for (const name of fs.readdirSync(publicDir).filter(name => name.endsWith('.js') && name !== 'ui-primitives.js')) assert.doesNotMatch(fs.readFileSync(new URL(name, publicDir), 'utf8'), /<svg\b/i, name);
});
test('Token守卫能拒绝颜色、圆角、外链字体、未登记透明度回归', () => {
  for (const source of ['.a{color:#fff4f5}', '.a{border-radius:7px;}', '@import "local.css";', '.a{color:rgba(255,255,255,.15)}', '.a{background:hsl(10,20%,30%)}', '@font-face{src:url(https://example.test/font.woff2)}']) assert.throws(() => checkCss(source), source);
  checkCss(':root{--bg:#070d14}.a{color:var(--bg);border-radius:var(--radius-panel);background:rgba(0,0,0,.28)}');
});

function checkCssStructure(source) {
  const clean=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,'');
  const stack=[], pairs={')':'(',']':'[','}':'{'};
  for(const char of clean){if('([{'.includes(char)) stack.push(char); else if(')]}'.includes(char)) assert.equal(stack.pop(),pairs[char],'CSS delimiters must balance in nesting order');}
  assert.equal(stack.length,0,'CSS must not swallow later rules in an unclosed block');
  for(const match of clean.matchAll(/@supports([^{}]*)([{}])/g)){
    assert.equal(match[2],'{');assert.doesNotMatch(match[1],/;/,'feature query is not a declaration block');
  }
}
test('console CSS feature queries are balanced so later responsive and precision rules survive parsing',()=>{
  for(const name of ['console.css','touch-controls.css'])checkCssStructure(fs.readFileSync(new URL(name,publicDir),'utf8'));
  for(const broken of ['@supports not ((backdrop-filter: var(--glass-blur); } }','.x{color:var(--text);','.x{transform:translateX(0];}'])assert.throws(()=>checkCssStructure(broken));
});
