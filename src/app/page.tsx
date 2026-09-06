'use client';

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

type ScanResult = {
  ok:boolean; symbol:string; price:number; change24h:number; direction:string; totalScore:number;
  confidence:number; alignmentScore:number; alignmentQuality:string; bestSetup:string; verdict:string; error?:string;
  historical?:{sampleSize?:number;tp1Rate?:number;tp2Rate?:number;tp3Rate?:number;stopRate?:number;expectancyR?:number;profitFactor?:number;avgMfePct?:number;avgMaePct?:number;maxLosingStreak?:number;regimeWinRate?:number};
  masterSignal:{entry:number;stopLoss:number;tp1:number;tp2:number;tp3:number;leverage:number;netRR:number;signalText:string};
  deep:{rsi:number;wyckoffPhase:string;hasBOS:boolean;hasOB:boolean;hasFVG:boolean;hasChoCH:boolean;hasSweep:boolean;macdBull:boolean;macdBear:boolean;vwapAbove:boolean;volRatio:number};
};

const pairs=['EIGENUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','SUIUSDT'];
const usd=(n:number,d=2)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:d}).format(n);
const p=(n:number)=>n>=100?n.toFixed(2):n>=1?n.toFixed(4):n.toFixed(5);

function Stat({label,value,tone}:{label:string;value:string;tone?:string}){return <div className="stat"><span>{label}</span><b className={tone||''}>{value}</b></div>;}
function Chip({on,label}:{on:boolean;label:string}){return <span className={'chip '+(on?'on':'')}><i/>{label}</span>;}
function Ring({value,label,tone}:{value:number;label:string;tone:string}){const s={'--v':String(Math.max(0,Math.min(100,value))*3.6)+'deg'} as CSSProperties;return <div className={'ring '+tone} style={s}><div><b>{Math.round(value)}%</b><span>{label}</span></div></div>;}

export default function Home(){
  const [symbol,setSymbol]=useState('EIGENUSDT'),[data,setData]=useState<ScanResult|null>(null),[loading,setLoading]=useState(false),[raw,setRaw]=useState(false);
  const [capital,setCapital]=useState(5000),[riskPct,setRiskPct]=useState(1);

  async function scan(s=symbol){const q=s.toUpperCase().trim();setSymbol(q);setLoading(true);setData(null);try{const r=await fetch('/api/scan?symbol='+q);setData(await r.json() as ScanResult);}catch(e){setData({ok:false,error:String(e)} as ScanResult);}finally{setLoading(false);}}

  const risk=useMemo(()=>{if(!data?.ok)return null;const riskAmount=capital*riskPct/100;const stopPct=Math.abs(data.masterSignal.entry-data.masterSignal.stopLoss)/data.masterSignal.entry;const notional=stopPct?riskAmount/stopPct:0;const fee=notional*.0011;const gain=(x:number)=>notional*Math.abs(x-data.masterSignal.entry)/data.masterSignal.entry-fee;return{riskAmount,notional,m3:notional/3,m5:notional/5,tp1:gain(data.masterSignal.tp1),tp2:gain(data.masterSignal.tp2),tp3:gain(data.masterSignal.tp3),stop:-(riskAmount+fee)};},[data,capital,riskPct]);

  const h=data?.historical,sample=h?.sampleSize||0,base=data?.confidence||0;
  const tp1=h?.tp1Rate??base,tp2=h?.tp2Rate??Math.max(0,base-14),tp3=h?.tp3Rate??Math.max(0,base-31),stop=h?.stopRate??Math.max(0,100-base);
  const tone=data?.direction==='LONG'?'long':data?.direction==='SHORT'?'short':'neutral';

  return <main className="shell">
    <header><div className="brand"><strong>4S</strong><div><h1>4SCANS</h1><span>Futures Intelligence Terminal</span></div></div><div className="live"><i/>BYBIT LIVE DATA</div></header>

    <section className="hero">
      <div><small>PAIR-SPECIFIC DECISION ENGINE</small><h2>Trade the <em>edge</em>, not the noise.</h2><p>Historical expectancy, live structure, quantified risk and execution levels in one screen.</p></div>
      <div className="inputs"><label>CAPITAL<input type="number" value={capital} onChange={e=>setCapital(Number(e.target.value)||0)}/></label><label>RISK / TRADE<input type="number" step=".1" value={riskPct} onChange={e=>setRiskPct(Number(e.target.value)||0)}/></label></div>
    </section>

    <section className="search"><div><input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} onKeyDown={e=>e.key==='Enter'&&scan()} placeholder="EIGENUSDT"/><button onClick={()=>scan()} disabled={loading}>{loading?'ANALYSING…':'RUN DEEP SCAN'}</button></div><nav>{pairs.map(x=><button key={x} onClick={()=>scan(x)} className={symbol===x?'active':''}>{x.replace('USDT','')}</button>)}</nav></section>

    {data?.error&&<div className="error">{data.error}</div>}
    {!data&&!loading&&<section className="empty"><div className="radar"><span>4S</span></div><h3>Ready for market interrogation.</h3><p>Select a perpetual pair and run a deep scan.</p></section>}
    {loading&&<section className="empty"><div className="loader">{Array.from({length:12}).map((_,i)=><i key={i}/>)}</div><h3>Building market thesis</h3><p>Structure · volatility · historical context · execution</p></section>}

    {data?.ok&&<div className="dash">
      <section className="market panel">
        <div><small>PERPETUAL / USDT</small><h3>{data.symbol.replace('USDT','')}<i>/USDT</i></h3><span className={'dir '+tone}>{data.direction==='LONG'?'▲':data.direction==='SHORT'?'▼':'—'} {data.direction}</span></div>
        <div className="stats"><Stat label="MARK PRICE" value={'$'+p(data.price)}/><Stat label="24H CHANGE" value={(data.change24h>=0?'+':'')+data.change24h.toFixed(2)+'%'} tone={data.change24h>=0?'green':'red'}/><Stat label="SETUP" value={data.bestSetup}/><Stat label="ALIGNMENT" value={data.alignmentScore.toFixed(0)+'%'}/></div>
      </section>

      <section className="cols">
        <article className="panel">
          <div className="title"><div><small>HISTORICAL EDGE</small><h3>{data.symbol} statistics</h3></div><span>{sample?'n='+sample:'ENGINE PENDING'}</span></div>
          <div className="rings"><Ring value={tp1} label="TP1" tone="g"/><Ring value={tp2} label="TP2" tone="b"/><Ring value={tp3} label="TP3" tone="a"/><Ring value={stop} label="STOP" tone="r"/></div>
          {!sample&&<p className="notice">Historical backtest data is not connected yet. These percentages are placeholders based on the current heuristic confidence and are not observed win rates.</p>}
          <div className="edgeStats"><Stat label="EXPECTANCY" value={sample?((h?.expectancyR||0)>=0?'+':'')+(h?.expectancyR||0).toFixed(2)+'R':'—'} tone="green"/><Stat label="PROFIT FACTOR" value={sample?(h?.profitFactor||0).toFixed(2):'—'}/><Stat label="AVG MFE" value={sample?'+'+(h?.avgMfePct||0).toFixed(2)+'%':'—'}/><Stat label="AVG MAE" value={sample?'-'+(h?.avgMaePct||0).toFixed(2)+'%':'—'}/><Stat label="MAX LOSS STREAK" value={sample?String(h?.maxLosingStreak||0):'—'}/><Stat label="REGIME WR" value={sample?(h?.regimeWinRate||0).toFixed(1)+'%':'—'}/></div>
        </article>

        <article className="panel">
          <div className="title"><div><small>LIVE THESIS</small><h3>Confluence map</h3></div><b className={'score '+tone}>{data.totalScore}</b></div>
          <div className="chips"><Chip on={data.deep.hasBOS} label="BOS"/><Chip on={data.deep.hasChoCH} label="CHoCH"/><Chip on={data.deep.hasOB} label="ORDER BLOCK"/><Chip on={data.deep.hasFVG} label="FVG"/><Chip on={data.deep.hasSweep} label="LIQ. SWEEP"/><Chip on={data.deep.vwapAbove===(data.direction==='LONG')} label="VWAP"/><Chip on={data.deep.macdBull||data.deep.macdBear} label="MACD"/><Chip on={data.deep.volRatio>=1.5} label={'VOL '+data.deep.volRatio.toFixed(1)+'×'}/></div>
          <div className="mini"><Stat label="RSI" value={data.deep.rsi.toFixed(1)}/><Stat label="WYCKOFF" value={data.deep.wyckoffPhase}/><Stat label="MODEL QUALITY" value={data.alignmentQuality}/></div>
          <div className="bar"><span>SIGNAL QUALITY <b>{data.totalScore}%</b></span><i><u style={{width:String(data.totalScore)+'%'}}/></i></div>
          <div className="bar"><span>TIMEFRAME ALIGNMENT <b>{data.alignmentScore.toFixed(0)}%</b></span><i><u style={{width:String(data.alignmentScore)+'%'}}/></i></div>
        </article>
      </section>

      <section className="panel execution">
        <div className="title"><div><small>EXECUTION MAP</small><h3>Defined risk. Defined invalidation.</h3></div><span>NET R:R {data.masterSignal.netRR.toFixed(2)}×</span></div>
        <div className="levels">
          <div className="sl"><span>STOP</span><b>{'$'+p(data.masterSignal.stopLoss)}</b><small>thesis invalid</small></div>
          <div className="en"><span>ENTRY</span><b>{'$'+p(data.masterSignal.entry)}</b><small>model reference</small></div>
          <div className="tp"><span>TP1</span><b>{'$'+p(data.masterSignal.tp1)}</b><small>{risk?'~'+usd(risk.tp1)+' net':''}</small></div>
          <div className="tp"><span>TP2</span><b>{'$'+p(data.masterSignal.tp2)}</b><small>{risk?'~'+usd(risk.tp2)+' net':''}</small></div>
          <div className="tp"><span>TP3</span><b>{'$'+p(data.masterSignal.tp3)}</b><small>{risk?'~'+usd(risk.tp3)+' net':''}</small></div>
        </div>
        <div className="risk"><Stat label="CAPITAL" value={usd(capital,0)}/><Stat label="MAX RISK" value={risk?usd(risk.riskAmount):'—'} tone="amber"/><Stat label="MAX NOTIONAL" value={risk?usd(risk.notional,0):'—'}/><Stat label="MARGIN @ 3×" value={risk?usd(risk.m3,0):'—'}/><Stat label="MARGIN @ 5×" value={risk?usd(risk.m5,0):'—'}/><Stat label="STOP EST." value={risk?usd(risk.stop):'—'} tone="red"/></div>
        <p className="fee">Display estimates use a simple fee allowance. Exact maker/taker, funding and slippage costs should come from the execution engine.</p>
      </section>

      <section className="panel verdict"><div className="title"><div><small>TRADER'S VERDICT</small><h3>Decision over prediction.</h3></div><b className={'dir '+tone}>{data.direction}</b></div><pre>{data.verdict}</pre><footer><span>01 <b>Do not chase price.</b></span><span>02 <b>Risk fixed before entry.</b></span><span>03 <b>No edge = no trade.</b></span></footer></section>

      <button className="rawBtn" onClick={()=>setRaw(!raw)}>{raw?'HIDE ENGINE OUTPUT':'SHOW ENGINE OUTPUT'}</button>
      {raw&&<section className="panel verdict"><pre>{data.masterSignal.signalText}</pre></section>}
    </div>}
  </main>;
}
