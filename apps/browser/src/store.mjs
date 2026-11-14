import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { text, validateId } from './policy.mjs';

// Browser-owned state only. Core records remain projections with explicit provenance.
export class BrowserStore {
  constructor(root) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'browser.sqlite'));
    if(this.db.prepare('PRAGMA user_version').get().user_version>1){this.db.close();throw new Error('UNSUPPORTED_STORAGE_VERSION');}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS item (id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES project(id), kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turn (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, project TEXT NOT NULL REFERENCES project(id), model TEXT NOT NULL, prompt TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, reason TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (turn_id TEXT PRIMARY KEY REFERENCES turn(id), delivered_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
      PRAGMA user_version=1;`);
    if(!this.db.prepare('PRAGMA table_info(turn)').all().some(c=>c.name==='context_json'))this.db.exec("ALTER TABLE turn ADD COLUMN context_json TEXT NOT NULL DEFAULT '[]'");
    this.db.prepare('INSERT OR IGNORE INTO project VALUES(?,?,?)').run('mnemos', 'MNEMOS', new Date().toISOString());
    this.db.prepare("UPDATE turn SET status='INTERRUPTED', reason='Lietotne pārtraukta; atkārtota nosūtīšana nenotika', updated=? WHERE status IN ('QUEUED','RUNNING')").run(new Date().toISOString());
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  project(id) { const row = this.db.prepare('SELECT * FROM project WHERE id=?').get(validateId(id)); if (!row) throw new Error('Projekts nav atrasts'); return row; }
  createProject(name) { const row = { id: randomUUID(), name: text(name,100), created: new Date().toISOString() }; this.db.prepare('INSERT INTO project VALUES(?,?,?)').run(row.id,row.name,row.created); this.event('project.created',{id:row.id}); return row; }
  addItem({ project, kind, title, source = 'browser' }) {
    this.project(project);
    if (!['goal','task','memory'].includes(kind)) throw new Error('Nederīgs ieraksta veids');
    const row = {id:randomUUID(), project, kind, title:text(title,16000), status:kind === 'memory' ? 'SAVED' : 'OPEN', source, created:new Date().toISOString()};
    this.db.prepare('INSERT INTO item VALUES(?,?,?,?,?,?,?)').run(...Object.values(row));
    this.event(`${kind}.created`,{id:row.id,project}); return row;
  }
  completeItem(id,project) { const row=this.db.prepare('SELECT * FROM item WHERE id=? AND project=?').get(validateId(id),validateId(project)); if(!row || row.kind==='memory') throw new Error('Uzdevums nav atrasts šajā projektā'); this.db.prepare("UPDATE item SET status=? WHERE id=?").run(row.status==='DONE'?'OPEN':'DONE',id); }
  findMemoryBySource(project,source) {
    this.project(project);
    return this.db.prepare("SELECT * FROM item WHERE project=? AND kind='memory' AND source=? LIMIT 1")
      .get(project,String(source));
  }
  resolveContext(project,ids=[]) {
    this.project(project);if(!Array.isArray(ids)||ids.length>4)throw new Error('CONTEXT_LIMIT');
    let size=0;
    return [...new Set(ids)].map(id=>{const m=this.db.prepare("SELECT id,title,source FROM item WHERE id=? AND project=? AND kind='memory'").get(validateId(id),project);if(!m)throw new Error('CONTEXT_SCOPE_DENIED');size+=m.title.length;if(size>12000)throw new Error('CONTEXT_TOO_LARGE');return {id:m.id,text:m.title,source:m.source,trust:'UNTRUSTED_REFERENCE'};});
  }
  beginTurn({ key, project, model, prompt, contextIds=[] }) {
    this.project(project); validateId(key); text(model,160); text(prompt,16000);
    const context=this.resolveContext(project,contextIds);
    const hash = createHash('sha256').update(JSON.stringify({project,model,prompt,context})).digest('hex');
    const existing=this.db.prepare('SELECT * FROM turn WHERE request_key=?').get(key);
    if(existing) { if(existing.request_hash!==hash) throw new Error('IDEMPOTENCY_CONFLICT'); return {turn:existing,replay:true}; }
    const now=new Date().toISOString(), id=randomUUID();
    this.db.prepare('INSERT INTO turn(id,request_key,request_hash,project,model,prompt,status,created,updated,context_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,key,hash,project,model,prompt,'QUEUED',now,now,JSON.stringify(context));
    return {turn:this.turn(id),replay:false};
  }
  turn(id) { return this.db.prepare('SELECT * FROM turn WHERE id=?').get(validateId(id)); }
  updateTurn(id,{status,output,reason=null}) { this.db.prepare('UPDATE turn SET status=?,output=?,reason=?,updated=? WHERE id=?').run(status,output,reason,new Date().toISOString(),id); return this.turn(id); }
  completeTurn(id,output) {this.db.exec('BEGIN IMMEDIATE');try{const t=this.updateTurn(id,{status:'COMPLETED',output});this.db.prepare('INSERT OR IGNORE INTO outbox(turn_id) VALUES(?)').run(id);this.db.exec('COMMIT');return t;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  pendingDeliveries(){return this.db.prepare('SELECT turn.* FROM turn JOIN outbox ON turn.id=outbox.turn_id WHERE outbox.delivered_at IS NULL ORDER BY turn.created LIMIT 100').all();}
  delivery(id,error=null){this.db.prepare('UPDATE outbox SET delivered_at=?, attempts=attempts+1, error=? WHERE turn_id=?').run(error?null:new Date().toISOString(),error,id);}
  event(kind,data) { this.db.prepare('INSERT INTO event(kind,data,created) VALUES(?,?,?)').run(kind,JSON.stringify(data),new Date().toISOString()); }
  snapshot() { return {projects:this.db.prepare('SELECT * FROM project ORDER BY created').all(),items:this.db.prepare('SELECT * FROM item ORDER BY created DESC LIMIT 1000').all(),turns:this.db.prepare('SELECT * FROM turn ORDER BY created DESC LIMIT 100').all(),outbox:this.db.prepare('SELECT * FROM outbox WHERE delivered_at IS NULL').all(),events:this.db.prepare('SELECT * FROM event ORDER BY seq DESC LIMIT 60').all()}; }
  close() { this.db.close(); }
}
