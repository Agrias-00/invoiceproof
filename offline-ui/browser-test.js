'use strict';
const checks=[];
function check(label,condition){checks.push({label,passed:!!condition});if(!condition)throw Error(label);}
try {
 check('initial create controls disabled',document.getElementById('success').disabled&&document.getElementById('unknown').disabled);
 check('evidence anchor resolves',!!document.querySelector(document.querySelector('a[href="#source-1"]').getAttribute('href')));
 document.getElementById('approve').click();
 check('approval enables simulation',!document.getElementById('success').disabled);
 const input=document.getElementById('description');input.value='<img src=x onerror=alert(1)>';input.dispatchEvent(new Event('input',{bubbles:true}));
 check('edit invalidates approval',document.getElementById('success').disabled&&document.getElementById('status').textContent.includes('NEEDS_REVIEW'));
 check('injected markup never rendered',document.querySelectorAll('img').length===0);
 const rate=document.getElementById('rate');rate.value='70.00';rate.dispatchEvent(new Event('input',{bubbles:true}));
 check('mismatch blocks approval',document.getElementById('approve').disabled&&document.getElementById('total').textContent==='Blocked');
 rate.value='50.00';rate.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('approve').click();
 const unknownMode=new URLSearchParams(location.search).get('outcome')!=='success';
 document.getElementById(unknownMode?'unknown':'success').click();
 check('terminal state displayed',document.getElementById('status').textContent.includes(unknownMode?'UNKNOWN':'DRAFT_VERIFIED'));
 check('terminal controls locked',['approve','success','unknown','description','quantity','rate'].every(id=>document.getElementById(id).disabled));
 const before=document.getElementById('status').textContent;document.getElementById('success').click();
 check('repeated click cannot restart',document.getElementById('status').textContent===before);
 check('labels associated',Array.from(document.querySelectorAll('input')).every(el=>document.querySelector(`label[for="${el.id}"]`)));
 document.body.dataset.testResult='PASS';
}catch(e){document.body.dataset.testResult='FAIL';checks.push({error:e.message});}
const report=document.createElement('pre');report.id='browser-test-results';report.textContent=JSON.stringify(checks,null,2);document.body.append(report);
