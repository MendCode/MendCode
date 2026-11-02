// Exact replay of a long streamed session versus identical original event rows, in isolated stores.
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "../packages/store/src"
import { createIdFactory, type SessionEvent } from "../packages/protocol/src"
import { parseEvent } from "../packages/store/src/compress"
const dir = mkdtempSync(path.join(tmpdir(), "mend-replay-probe-")), store = openStore({ dir }), ids = createIdFactory()
const sessionId = ids("session")
const raw = new Database(path.join(dir, "original.db"))
raw.run("CREATE TABLE events(session_id TEXT,seq INTEGER,payload TEXT,PRIMARY KEY(session_id,seq)) WITHOUT ROWID")
raw.run("CREATE TABLE transcript_prefix(session_id TEXT,seq INTEGER,parent_id TEXT,parent_seq INTEGER,PRIMARY KEY(session_id,seq)) WITHOUT ROWID")
const insert = raw.query("INSERT INTO events VALUES (?,?,?)")
store.createSession({ id: sessionId, directory: "/probe", title: "long streaming" })
for (const event of store.readAfter(sessionId,0)) insert.run(sessionId,event.seq,JSON.stringify(event))
const append = (draft: Parameters<typeof store.sessionSink.append>[0]) => { const event=store.sessionSink.append(draft); insert.run(sessionId,event.seq,JSON.stringify(event)); return event }
for(let n=0;n<300;n++) {
  const turnId=ids("turn"),itemId=ids("item")
  append({type:"turn.started",sessionId,turnId,queueId:ids("queue")})
  append({type:"item.started",sessionId,turnId,itemId,kind:"agent_message"})
  for(let k=0;k<100;k++) append({type:"item.delta",sessionId,itemId,text:`piece ${k} `})
  append({type:"item.completed",sessionId,itemId,status:"ok",text:Array.from({length:100},(_,k)=>`piece ${k} `).join("")})
  append({type:"turn.completed",sessionId,turnId})
}
const select=raw.query<{payload:string},[string,number]>(`SELECT payload FROM (
 SELECT seq,payload FROM (SELECT seq,payload FROM events WHERE session_id=?1 AND seq>?2 ORDER BY seq LIMIT 1000)
 UNION ALL
 SELECT seq,payload FROM (SELECT p.seq AS seq,json_set(e.payload,'$.sessionId',p.session_id,'$.seq',p.seq) AS payload FROM transcript_prefix p JOIN events e ON e.session_id=p.parent_id AND e.seq=p.parent_seq WHERE p.session_id=?1 AND p.seq>?2 ORDER BY p.seq LIMIT 1000)
) ORDER BY seq LIMIT 1000`)
const results=[]
try {
 for(let round=0;round<10;round++) for(const folded of round%2?[true,false]:[false,true]) {
  const start=performance.now(),cpu=process.cpuUsage();let cursor=0,count=0
  for(;;){const page:SessionEvent[]=folded?store.readExactAfter(sessionId,cursor,1000):select.all(sessionId,cursor).map(r=>parseEvent(r.payload));if(!page.length)break;for(const e of page){if(e.seq!==cursor+1)throw Error("replay gap");cursor=e.seq;count++}}
  const used=process.cpuUsage(cpu);results.push({round,folded,ms:performance.now()-start,cpuUs:used.user+used.system,count})
 }
 console.log(JSON.stringify({dir,results},null,2))
}finally{raw.close();store.close()}
