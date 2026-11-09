const OWN_ROUTE='scnet', HOST_FOREIGN_API='dsh-foreign';
function blocksOf(m){return Array.isArray(m?.content)?m.content:[]}
function align(msgs){let ch=false;const next=msgs.map(m=>{if(m===null||typeof m!=='object')return m;if(m.role!=='assistant')return m;if(m.provider!==OWN_ROUTE)return m;if(m.api!==HOST_FOREIGN_API)return m;ch=true;return {...m,api:'openai-completions'}});return ch?next:msgs}
function isCross(m){if(m===null||typeof m!=='object')return false;if(m.role!=='assistant')return false;if(m.api===HOST_FOREIGN_API)return true;return typeof m.provider!=='string'||m.provider!==OWN_ROUTE}
function dropForeign(m){const c=blocksOf(m);const f=c.filter(b=>b===null||typeof b!=='object'||b.type!=='thinking'||b.redacted===true);return f.length!==c.length?{...m,content:f}:m}
const msgs=[
 {role:'assistant',provider:'scnet',api:'dsh-foreign',content:[{type:'thinking',thinking:'a'},{type:'text',text:'b'}]},
 {role:'assistant',provider:'workbuddy',api:'dsh-foreign',content:[{type:'thinking',thinking:'x'.repeat(100)},{type:'text',text:'y'}]},
 {role:'assistant',provider:'scnet',api:'openai-completions',content:[{type:'thinking',thinking:'sig',thinkingSignature:'s1'}]},
 {role:'assistant',provider:'scnet',api:'openai-completions',content:[{type:'thinking',thinking:'unsigned-own'}]},
 {role:'assistant',provider:'scnet',api:'dsh-foreign',content:[{type:'thinking',thinking:'redacted',redacted:true},{type:'thinking',thinking:'normal',thinkingSignature:'s2'}]}
];
const aligned=align(msgs);
const out=aligned.map(m=>isCross(m)?dropForeign(m):m);
const assert=(c,msg)=>{if(!c){console.error('FAIL:',msg);process.exit(1)}console.log('PASS:',msg)};
assert(out[0].api==='openai-completions','① own dsh-foreign api aligned');
assert(out[0].content.length===2,'① own (aligned) thinking KEPT');
assert(out[1].content.length===1&&out[1].content[0].type==='text','② foreign thinking DROPPED');
assert(out[2].content.length===1&&out[2].content[0].thinkingSignature==='s1','③ own signed thinking kept');
assert(out[3].content.length===1,'④ own unsigned (same-route switch) kept (no switch yet)');
assert(out[4].api==='openai-completions'&&out[4].content.length===2&&out[4].content[0].type==='thinking'&&out[4].content[0].redacted===true&&out[4].content[1].thinkingSignature==='s2','⑤ aligned own: redacted + signed kept');
console.log('ALL SEMANTICS PASS');
