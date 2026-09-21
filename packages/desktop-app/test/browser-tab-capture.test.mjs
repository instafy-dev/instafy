import assert from "node:assert/strict";
import test from "node:test";
import { BrowserTabCapture } from "../dist/browserTabCapture.js";

function fixture() {
  let source;
  const jpeg = Buffer.from([255,216,1,255,217]);
  const image = { getSize: () => ({ width: 3200, height: 2000 }), resize(options) { this.resized = options; return this; }, toJPEG: () => jpeg };
  const contents = { isDestroyed: () => false, getURL: () => "https://example.com/cart", capturePage: async () => image };
  source = { ownerId: "owner", projectId: "project", contents };
  const capture = new BrowserTabCapture(() => source);
  return { capture, contents, image, jpeg, replace: value => { source = value; } };
}

test("selected tab capture requires explicit owner, bounds pixels, and ignores a stale stop", async () => {
  const f=fixture(); assert.throws(() => f.capture.start("other"));
  const first=f.capture.start("owner");
  assert.deepEqual(await f.capture.frame("owner",first.captureId),f.jpeg);
  assert.deepEqual(f.image.resized,{width:1600,height:1000,quality:"good"});
  f.capture.stop(first.captureId);
  const second=f.capture.start("owner"); f.capture.stop(first.captureId);
  assert.notEqual(first.captureId,second.captureId);
  assert.equal(f.capture.active,true);
  await assert.rejects(f.capture.frame("owner",first.captureId));
});

for (const reason of ["stop", "account", "project", "view", "hidden", "navigation"]) {
  test(`in-flight pixels cannot escape after ${reason}`, async () => {
    const f=fixture(); let finish;
    f.contents.capturePage=()=>new Promise(resolve=>{finish=resolve});
    const {captureId}=f.capture.start("owner"); const pending=f.capture.frame("owner",captureId);
    await assert.rejects(f.capture.frame("owner",captureId),/pending/);
    if(reason==="stop") f.capture.stop();
    if(reason==="account") f.replace({ownerId:"another",projectId:"project",contents:f.contents});
    if(reason==="project") f.replace({ownerId:"owner",projectId:"other",contents:f.contents});
    if(reason==="view") f.replace({ownerId:"owner",projectId:"project",contents:{...f.contents}});
    if(reason==="hidden") f.replace(null);
    if(reason==="navigation") f.contents.getURL=()=>"file:///private/local";
    finish(f.image); await assert.rejects(pending,/ended/);
  });
}

test("closed or non-web sources and oversized images are rejected",async()=>{
  const f=fixture();f.contents.getURL=()=>"about:blank";assert.throws(()=>f.capture.start("owner"));
  f.contents.getURL=()=>"https://example.com";const {captureId}=f.capture.start("owner");
  f.image.toJPEG=()=>Buffer.alloc(1024*1024+1);await assert.rejects(f.capture.frame("owner",captureId),/large/);
  f.contents.isDestroyed=()=>true;await assert.rejects(f.capture.frame("owner",captureId),/ended/);
});

function controlledFixture() {
  let source;
  const applied=[];
  const contents={isDestroyed:()=>false,getURL:()=>"https://example.test",capturePage:async()=>({getSize:()=>({width:1,height:1}),toJPEG:()=>Buffer.from([255,216,255,217])})};
  source={ownerId:"owner",projectId:"project",contents,canControl:true,dispatchInput:async(input,current)=>{assert.ok(current());applied.push(input);}};
  const capture=new BrowserTabCapture(()=>source);
  const {captureId}=capture.start("owner"), grantId="11111111-1111-4111-8111-111111111111";
  return {capture,captureId,grantId,applied,source,replace:s=>{source=s}};
}
test("tab input requires an active exact capture/grant and never accepts generic commands",async()=>{
  const f=controlledFixture(); const input={type:"text",text:"hello"};
  await assert.rejects(f.capture.input("owner",f.captureId,f.grantId,input));
  f.capture.setControl("owner",f.captureId,f.grantId);
  await f.capture.input("owner",f.captureId,f.grantId,input);assert.deepEqual(f.applied,[input]);
  for(const bad of [{type:"evaluate",expression:"secret"},{type:"click",x:NaN,y:0},{type:"key",key:"F12",shift:false},{type:"text",text:"x",command:"exec"}]) await assert.rejects(f.capture.input("owner",f.captureId,f.grantId,bad));
  await assert.rejects(f.capture.input("other",f.captureId,f.grantId,input));
  f.capture.revokeControl();assert.equal(f.capture.controlActive,false);
  assert.equal(f.capture.renewControl("owner",f.captureId,f.grantId),false);
  await assert.rejects(f.capture.input("owner",f.captureId,f.grantId,input));
});
test("take back fences queued input and a late heartbeat cannot reactivate it",async()=>{
  const f=controlledFixture();let finish;const entered=new Promise(resolve=>{f.source.dispatchInput=async input=>{f.applied.push(input);resolve();await new Promise(r=>{finish=r})}});
  f.capture.setControl("owner",f.captureId,f.grantId);
  const first=f.capture.input("owner",f.captureId,f.grantId,{type:"text",text:"first"});await entered;
  const queued=f.capture.input("owner",f.captureId,f.grantId,{type:"text",text:"late"});
  const rejected=assert.rejects(queued,/ended/);f.capture.revokeControl();finish();await first;await rejected;
  assert.equal(f.applied.length,1);assert.equal(f.capture.renewControl("owner",f.captureId,f.grantId),false);
});
test("native input lease expires without heartbeat and agent authority blocks granting",async(t)=>{
  t.mock.timers.enable({apis:["setTimeout"]});const f=controlledFixture();
  f.source.canControl=false;assert.throws(()=>f.capture.setControl("owner",f.captureId,f.grantId),/Pause agent/);
  f.source.canControl=true;f.capture.setControl("owner",f.captureId,f.grantId);
  t.mock.timers.tick(3999);assert.equal(f.capture.controlActive,true);
  t.mock.timers.tick(1);assert.equal(f.capture.controlActive,false);
  assert.equal(f.capture.renewControl("owner",f.captureId,f.grantId),false);
});

test("Explore belongs to the exact capture and Stop destroys every private page",async()=>{
  const f=controlledFixture(), closed=[];
  f.source.createExplore=()=>({frame:async()=>Buffer.from([255,216,255,217]),resize:async()=>{},input:async()=>{},navigate:async()=>{},close:()=>closed.push(true)});
  const viewport={width:390,height:650,dpr:2};
  assert.throws(()=>f.capture.openExplore("other",f.captureId,viewport),/ended/);
  const first=f.capture.openExplore("owner",f.captureId,viewport);
  const second=f.capture.openExplore("owner",f.captureId,viewport);
  f.capture.stop("stale-capture");assert.equal(closed.length,0);
  assert.equal(f.capture.operateExplore("owner",f.captureId,first.viewId,"renew"),true);
  f.capture.stop(f.captureId);assert.equal(closed.length,2);
  const next=f.capture.start("owner");
  assert.equal(f.capture.operateExplore("owner",next.captureId,second.viewId,"renew"),false);
  assert.throws(()=>f.capture.operateExplore("owner",f.captureId,first.viewId,"frame"),/ended/);
  const third=f.capture.openExplore("owner",next.captureId,viewport);
  f.replace({...f.source,projectId:"different"});
  assert.throws(()=>f.capture.operateExplore("owner",next.captureId,third.viewId,"input",{type:"text",text:"late"}),/ended/);
  f.capture.stop();assert.equal(closed.length,3);
});
