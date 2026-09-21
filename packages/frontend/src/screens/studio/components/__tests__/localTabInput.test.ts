import { expect, it } from "vitest";
import { localTabInput } from "../localTabInput";
import type { RemoteBrowserInputMessage } from "../remoteBrowserInput";
it("maps clicks/wheel to the atomic normalized lane and never sends held input",()=>{
  const base={type:"mouse",kind:"mousePressed",x:0.25,y:0.7,button:"left",buttons:1,modifiers:0,clickCount:1} as const;
  expect(localTabInput(base)).toBeNull();
  expect(localTabInput({...base,kind:"mouseReleased"})).toEqual({type:"click",x:.25,y:.7});
  expect(localTabInput({...base,kind:"mouseReleased",button:"right"})).toBeNull();
  expect(localTabInput({type:"wheel",x:.2,y:.3,deltaX:0,deltaY:50,modifiers:0})).toEqual({type:"wheel",x:.2,y:.3,deltaX:0,deltaY:50});
});
it("limits physical/virtual keys and IME text to page input without generic shortcuts",()=>{
  const key=(key:string,modifiers=0,text=""):RemoteBrowserInputMessage=>({type:"key",kind:"keyDown",key,code:key,text,modifiers,autoRepeat:false});
  expect(localTabInput(key("F12"))).toBeNull();expect(localTabInput(key("l",4))).toBeNull();
  expect(localTabInput(key("a",4))).toEqual({type:"key",key:"SelectAll",shift:false});
  expect(localTabInput(key("Enter",0,"\r"))).toEqual({type:"key",key:"Enter",shift:false});
  expect(localTabInput({type:"text",text:"こんにちは"})).toEqual({type:"text",text:"こんにちは"});
});
