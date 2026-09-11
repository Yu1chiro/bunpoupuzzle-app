'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vm=require('node:vm');
const request=require('supertest');
const {PGlite}=require('@electric-sql/pglite');
const {createApp,shuffle,parseQuestion,grade,PATH}=require('../server');

test('Semua HTML memiliki JavaScript inline yang valid',async()=>{
  for(const name of ['public/index.html','public/signin.html','public/admin.html','game-mode.html','profile.html']){
    const html=await fs.readFile(path.join(PATH.root,name),'utf8');
    const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(m=>m[1].trim());
    assert.equal(scripts.length,1,name+' memiliki satu script inline');
    scripts.forEach(m=>new vm.Script(m[1],{filename:name}));
    assert.ok(html.includes('const PATH = Object.freeze('));
    assert.ok(!/\b(?:alert|confirm|prompt)\(/.test(scripts[0][1]));
  }
});
test('Pengacakan dan parser mempertahankan token termasuk duplikat',()=>{
  assert.throws(()=>parseQuestion({question:'abc'}));
  assert.throws(()=>parseQuestion({question:'は・は'}));
  assert.throws(()=>parseQuestion({question:'私・・です'}));
  const q=parseQuestion({question:' 母 ・ の ・ 友達 ・ の ・ 本です。 ',clue:'Buku teman ibu'});
  assert.equal(q.tokens.length,5);
  for(let i=0;i<100;i++)assert.deepEqual(shuffle(q.tokens).sort(),[...q.tokens].sort());
  assert.deepEqual(q.tokens,['母','の','友達','の','本です。']);
  const correct=q.tokens.map((text,i)=>({id:String(i),text}));
  const r=grade({id:'q',correct,clue:''},['0','3','2','1','4'],60,0,1000);
  assert.equal(r.correct,true,'Token identik boleh bertukar ID');
  assert.throws(()=>grade({correct},['0','0'],60,0,1));
});
test('Integrasi auth, CRUD, kepemilikan, puzzle, timeout dan idempotensi',async t=>{
  const db=new PGlite();
  await db.exec(await fs.readFile(PATH.schema,'utf8'));
  const query=async(sql,params)=>{
    const result=await db.query(sql,params);
    return {...result,rowCount:result.affectedRows??result.rows.length};
  };
  const pool={query,connect:async()=>({query,release(){}})};
  let current=Date.now();
  const app=createApp({pool,secret:'test-only-0123456789-abcdefghijklmnopqrstuvwxyz',now:()=>current});
  const admin=request.agent(app), other=request.agent(app), guest=request(app);
  let deckId,questionIds,token;
  await t.test('register/login JWT HttpOnly, login gagal, email unik',async()=>{
    let r=await admin.post('/api/auth/register').send({username:'Hera',email:'hera@example.com',password:'testpass123'});
    assert.equal(r.status,201);assert.match(r.headers['set-cookie'][0],/HttpOnly/);assert.match(r.headers['set-cookie'][0],/SameSite=Strict/);
    assert.equal((await admin.get('/api/auth/me')).body.admin.username,'Hera');
    assert.equal((await guest.post('/api/auth/register').send({username:'Hera',email:'HERA@example.com',password:'testpass123'})).status,409);
    assert.equal((await other.post('/api/auth/register').send({username:'Lain',email:'other@example.com',password:'testpass123'})).status,201);
    assert.equal((await guest.post('/api/auth/login').send({email:'hera@example.com',password:'wrong'})).status,401);
    assert.equal((await guest.post('/api/auth/login').send({email:'hera@example.com',password:'testpass123'})).status,200);
    assert.equal((await guest.get('/api/admin/decks')).status,401);
    assert.equal((await guest.post('/api/auth/login').set('Origin','https://evil.example').send({})).status,403);
  });
  await t.test('CRUD deck dan validasi default 60 detik',async()=>{
    assert.equal((await admin.post('/api/admin/decks').send({title:'Kosong',secondsPerQuestion:0})).status,400);
    const r=await admin.post('/api/admin/decks').send({title:'Partikel dasar',description:'Latihan N5'});
    assert.equal(r.status,201);deckId=r.body.deck.id;assert.equal(r.body.deck.seconds_per_question,60);
    assert.equal((await guest.post('/api/games').send({deckId})).status,400);
    assert.equal((await other.put('/api/admin/decks/'+deckId).send({title:'Hack'})).status,404);
    assert.equal((await admin.put('/api/admin/decks/'+deckId).send({title:'Partikel Jepang',description:'Latihan N5',secondsPerQuestion:60})).status,200);
    assert.equal((await admin.get('/api/admin/decks')).body.decks.length,1);
  });
  await t.test('Repeater atomic, CRUD soal, publik tidak membocorkan jawaban',async()=>{
    const url='/api/admin/decks/'+deckId+'/questions';
    assert.equal((await admin.post(url).send({questions:[{question:'私・は・学生です。'},{question:'invalid'}]})).status,400);
    assert.equal((await admin.get(url)).body.questions.length,0);
    const r=await admin.post(url).send({questions:[{question:'明日・学校・へ・行きます。',clue:'Besok saya pergi ke sekolah.'},{question:'私・は・学生です。'},{question:'これ・は・本です。'}]});
    assert.equal(r.status,201);questionIds=r.body.questions.map(q=>q.id);
    assert.equal((await other.get(url)).status,404);
    assert.equal((await admin.put(url+'/'+questionIds[1]).send({question:'私・は・先生です。',clue:'Saya guru.'})).status,200);
    assert.equal((await admin.delete(url+'/'+questionIds[2])).status,200);
    const pub=await guest.get('/api/decks');assert.equal(pub.body.decks[0].question_count,2);
    assert.ok(!JSON.stringify(pub.body).includes('行きます'));
  });
  await t.test('Game benar, ID acak, snapshot konsisten, retry tidak menggandakan EXP',async()=>{
    let r=await guest.post('/api/games').send({deckId});assert.equal(r.status,201);token=r.body.token;
    assert.equal(r.body.question.tokens.length,4);assert.ok(!('correct' in r.body.question));
    assert.notDeepEqual(r.body.question.tokens.map(t=>t.text),['明日','学校','へ','行きます。']);
    let state=r.body;
    const tokenIds=['明日','学校','へ','行きます。'].map(text=>state.question.tokens.find(t=>t.text===text).id);
    current+=2000;
    r=await guest.post('/api/games/answer').set('x-game-token',token).send({index:0,tokenIds});assert.equal(r.status,200);assert.equal(r.body.result.correct,true);assert.equal(r.body.result.xp,29);
    const again=await guest.post('/api/games/answer').set('x-game-token',token).send({index:0,tokenIds});assert.deepEqual(again.body.result,r.body.result);assert.equal(again.body.state.xp,29);
    assert.equal((await guest.get('/api/games/current').set('x-game-token',token)).body.phase,'feedback');
    // Mengedit soal kedua tidak mengubah snapshot yang sedang dimainkan.
    await admin.put('/api/admin/decks/'+deckId+'/questions/'+questionIds[1]).send({question:'私・は・医者です。'});
    r=await guest.post('/api/games/next').set('x-game-token',token).send({index:0});assert.equal(r.body.index,1);assert.ok(r.body.question.tokens.some(t=>t.text==='先生です。'));
    assert.equal((await guest.post('/api/games/next').set('x-game-token',token).send({index:0})).body.index,1);
    assert.equal((await guest.post('/api/games/answer').set('x-game-token',token).send({index:1,tokenIds:['invalid']})).status,400);
    assert.equal((await guest.post('/api/games/answer').set('x-game-token',token).send({index:1,tokenIds:[r.body.question.tokens[0].id,r.body.question.tokens[0].id]})).status,400);
    current+=61000;
    r=await guest.post('/api/games/answer').set('x-game-token',token).send({index:1,tokenIds:[]});assert.equal(r.body.result.timedOut,true);assert.equal(r.body.result.xp,0);assert.equal(r.body.result.mismatches,3);
    r=await guest.post('/api/games/next').set('x-game-token',token).send({index:1});assert.equal(r.body.phase,'done');
    const s=r.body.summary;assert.equal(s.total,2);assert.equal(s.totalXp,29);assert.equal(s.accuracy,50);assert.equal(s.incorrect,1);assert.equal(s.timedOut,1);assert.equal(s.totalSeconds,62);assert.equal(s.bestStreak,1);
    const retry=await guest.post('/api/games/next').set('x-game-token',token).send({index:1});assert.deepEqual(retry.body.summary,s);
    assert.equal((await guest.get('/api/games/current').set('x-game-token','0'.repeat(64))).status,410);
  });
  await t.test('Jawaban salah, sesi kadaluarsa, hapus cascade, logout dan route file aman',async()=>{
    const r=await guest.post('/api/games').send({deckId});
    const answer=await guest.post('/api/games/answer').set('x-game-token',r.body.token).send({index:0,tokenIds:r.body.question.tokens.map(t=>t.id)});
    assert.equal(answer.body.result.correct,false);assert.equal(answer.body.result.timedOut,false);assert.ok(answer.body.result.mismatches>0);
    current+=86400001;
    assert.equal((await guest.get('/api/games/current').set('x-game-token',token)).status,410);
    assert.equal((await other.delete('/api/admin/decks/'+deckId)).status,404);
    assert.equal((await admin.delete('/api/admin/decks/'+deckId)).status,200);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM questions')).rows[0].n,0);
    for(const route of ['/','/signin','/admin','/game-mode','/profile'])assert.equal((await guest.get(route)).status,200);
    for(const route of ['/.env','/server.js','/schema.sql','/package.json'])assert.equal((await guest.get(route)).status,404);
    await admin.post('/api/auth/logout').send({});assert.equal((await admin.get('/api/auth/me')).status,401);
  });
  await db.close();
});

test('LocalStorage: simpan idempoten, hitung progres, lindungi data rusak dan penuh',async()=>{
  const html=await fs.readFile(PATH.profile,'utf8');
  const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].find(m=>m[1].includes('const STORE_KEY'))[1];
  const common=source.slice(0,source.indexOf('function renderProfile'));
  const memory=new Map();let blocked=false;
  const el={addEventListener(){},classList:{add(){},remove(){}},textContent:''};
  const ctx=vm.createContext({document:{querySelector:()=>el},localStorage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>{if(blocked)throw new Error('quota');memory.set(k,v);}},setTimeout:()=>0,clearTimeout(){},console});
  vm.runInContext(common,ctx);
  const fixture={id:'s1',deckId:'d1',deckTitle:'Test',revision:1,total:2,correct:1,totalXp:25,totalSeconds:10,mismatches:2,results:[]};
  ctx.fixture=fixture;
  assert.equal(vm.runInContext('saveSummary(fixture)',ctx),true);
  assert.equal(vm.runInContext('saveSummary(fixture)',ctx),true);
  assert.equal(vm.runInContext('readProgress().sessions.length',ctx),1);
  assert.equal(vm.runInContext('totals(readProgress().sessions).xp',ctx),25);
  assert.equal(vm.runInContext('totals(readProgress().sessions).accuracy',ctx),50);
  assert.equal(vm.runInContext('totals(readProgress().sessions).done',ctx),1);
  const good=memory.get('bunpou.progress.v1');
  memory.set('bunpou.progress.v1','bad-json');
  assert.equal(vm.runInContext('saveSummary(fixture)',ctx),false);
  assert.equal(memory.get('bunpou.progress.v1'),'bad-json');
  memory.set('bunpou.progress.v1',good);blocked=true;ctx.fixture={...fixture,id:'s2'};
  assert.equal(vm.runInContext('saveSummary(fixture)',ctx),false);
  assert.equal(memory.get('bunpou.progress.v1'),good);
});
