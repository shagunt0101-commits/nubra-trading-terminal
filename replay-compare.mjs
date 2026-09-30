import { loadDay, chainFn } from "./server/backtest-all.ts";
import { precomputeSignals } from "./server/backtest-engine.ts";

// LIVE trades on 08-06 (from state file, all bb_mr ct55 h18, qty130):
const LIVE = [
  { side:"CE", in:119.95, tIn:"10:49", out:121.7,  tOut:"11:07", reason:"MAX_HOLD" },
  { side:"CE", in:121.2,  tIn:"12:24", out:124.2,  tOut:"12:42", reason:"MAX_HOLD" },
  { side:"CE", in:121.7,  tIn:"12:55", out:116.4,  tOut:"13:13", reason:"MAX_HOLD" },
];
const { candles, prem } = await loadDay("20260806");
candles.sort((a,b)=>a.ts-b.ts);
const premAt=(ts,opt)=>chainFn(prem)(ts-(ts%60000),opt);
const opts={strategy:"bollinger_band_reversal",instrument:"NIFTY",confidenceThreshold:55,entryCutoffMin:1415,premiumTargetPct:15,premiumStopLossPct:50,exitMode:"sl_tp",maxHoldBars:18,maxEntryPremium:600};
const sig=precomputeSignals(candles,"bollinger_band_reversal",opts);
const T=ts=>new Date(ts).toLocaleString("en-US",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"});
let pos=null, sim=[];
for(let i=50;i<candles.length;i++){
  const c=candles[i],ts=c.ts-(c.ts%60000);
  if(pos){
    const p=premAt(ts,pos.optType);
    let reason=null;
    if(p<=pos.stopLoss)reason="SL";
    else if(p>=pos.target)reason="TP";
    else if(i-pos.entryBar>=18)reason="MAX_HOLD";
    else if(i===candles.length-1)reason="EOD";
    if(reason){sim.push({...pos,out:p,tOut:T(c.ts),reason});pos=null;continue;}
    continue;
  }
  if(i+1>=candles.length||(!sig.long[i]&&!sig.short[i]))continue;
  const opt=sig.long[i]?"CE":"PE";
  const e=candles[i+1],p=premAt(e.ts,opt);
  if(!p||p<=0||p>600)continue;
  pos={optType:opt,in:p,tIn:T(e.ts),entryBar:i+1,stopLoss:p*0.5,target:p*1.15};
}
console.log("=== LIVE (08-06) ===");
for(const t of LIVE)console.log(`  ${t.tIn} ${t.side} in ${t.in} -> ${t.tOut} out ${t.out} (${t.reason}) pnl ${((t.out-t.in)*130).toFixed(0)}`);
console.log("=== REPLAY (same config ct55 h18, chain LTP) ===");
for(const t of sim)console.log(`  ${t.tIn} ${t.optType} in ${t.in} -> ${t.tOut} out ${t.out} (${t.reason}) pnl ${((t.out-t.in)*130).toFixed(0)}`);
const lp=LIVE.map(t=>(t.out-t.in)*130).reduce((a,b)=>a+b,0);
const sp=sim.map(t=>(t.out-t.in)*130).reduce((a,b)=>a+b,0);
console.log(`live net ${lp.toFixed(0)} | replay net ${sp.toFixed(0)} | diff ${(sp-lp).toFixed(0)} (${sim.length} vs ${LIVE.length} trades)`);
