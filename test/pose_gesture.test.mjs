import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPoseGestureGate, classifyArm} from '../src/runtime/pose-gesture.mjs';
function pose(state='DOWN', side='left') {
 const p=Array.from({length:33},()=>({x:.5,y:.2,z:0,visibility:.99,presence:.99}));
 p[11].x=.4;p[12].x=.6;p[11].y=p[12].y=.5;
 for(const [s,e,w] of [[11,13,15],[12,14,16]]) {p[e].y=.65;p[w].y=.8;}
 const e=side==='left'?13:14,w=side==='left'?15:16;
 if(state==='UP') {p[e].y=.3;p[w].y=.1;}
 return p;
}
function run(g,p,start,duration,step=100) {let out=[];for(let t=start;t<=start+duration;t+=step) out.push(...g.update(p,t,t));return out;}
test('empty, missing/low confidence and invalid coordinates cannot arm or raise',()=>{
 for(const invalid of [null,[],pose('UP').map(p=>({...p,visibility:.1})),pose('UP').map(({visibility,...p})=>p),pose('UP').map(p=>({...p,x:NaN}))]) {
 const g=createPoseGestureGate();run(g,pose(),0,500);assert.deepEqual(run(g,invalid,600,1000),[]);
 }
});
test('already raised and stationary lowered arms never trigger',()=>{for(const p of [pose(),pose('UP')]) assert.deepEqual(run(createPoseGestureGate(),p,0,3000),[]);});
test('deliberate cycles emit once on each side at varied inference rates',()=>{
 for(const step of [200,100,1000/15,1000/30]) for(const side of ['left','right']) {
 const g=createPoseGestureGate();run(g,pose('DOWN',side),0,800,step);
 assert.deepEqual(run(g,pose('UP',side),900,800,step),[{type:'raise',side}]);
 assert.deepEqual(run(g,pose('DOWN',side),1800,800,step),[{type:'lower',side}]);
 }
});
test('loss cancels silently and requires a new baseline',()=>{
 const g=createPoseGestureGate();run(g,pose(),0,500);run(g,pose('UP'),600,500);
 assert.deepEqual(run(g,null,1200,500),[{type:'cancel',side:'left'}]);
 assert.deepEqual(run(g,pose('UP'),1800,1000),[]);
});
test('stale/duplicate timestamps and interrupted candidates cannot trigger',()=>{
 const g=createPoseGestureGate();run(g,pose(),0,500);
 g.update(pose('UP'),600,600);g.update(null,700,700);
 assert.deepEqual(g.update(pose('UP'),800,800),[]);
 assert.deepEqual(g.update(pose('UP'),800,800),[]);
 assert.deepEqual(g.update(pose('UP'),900,2000),[]);
 g.reset();assert.deepEqual(run(g,pose('UP'),2100,800),[]);
});
test('shoulder and head evidence is mandatory',()=>{const p=pose('UP');p[0].presence=0;p[7].presence=0;assert.equal(classifyArm(p,'left'),'UNKNOWN');});

test('JavaScript SDK landmarks without optional presence can trigger; low supplied presence cannot',()=>{
 const p=pose();for(const pt of p) delete pt.presence;
 assert.equal(classifyArm(p,'left'),'DOWN');p[15].presence=.1;assert.equal(classifyArm(p,'left'),'UNKNOWN');
});
