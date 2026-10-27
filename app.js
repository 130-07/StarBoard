/* Shared mode uses atomic database actions; it never uploads an entire stale board. */
(async function () {
  'use strict';
  const C=StarCore,$=id=>document.getElementById(id),cfg=window.STAR_CONFIG||{};
  const remote=Boolean(cfg.supabaseUrl||cfg.publishableKey);
  const token=new URLSearchParams(location.hash.slice(1)).get('board')||'';
  const demoKey='stjernetavlen-demo-v3';
  let state=C.blank(),ready=!remote,busy=false,refreshing=false,selected=null,requestId=null,pendingUndo=null,toastTimer,partyTimer;
  let configurationError='';
  if(remote) {
    try {
      if(!cfg.supabaseUrl||!cfg.publishableKey)throw new Error('Complete both public settings in config.js.');
      if(new URL(cfg.supabaseUrl).protocol!=='https:')throw new Error('The database URL must use HTTPS.');
      if(cfg.publishableKey.startsWith('sb_secret_'))throw new Error('Use a publishable key, never a secret key.');
      if(cfg.publishableKey.startsWith('eyJ')) {
        const part=cfg.publishableKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
        if(JSON.parse(atob(part)).role!=='anon')throw new Error('Use a publishable or legacy anon key, never a service-role key.');
      }
      if(!/^[a-f0-9]{64}$/i.test(token))throw new Error('Open the full team link, including #board= and its private code.');
    } catch(e) {configurationError=e.message;}
  } else {
    try {
      const raw=localStorage.getItem(demoKey);
      if(raw)state=JSON.parse(raw);
      else {
        const old=JSON.parse(localStorage.getItem('stjernetavlen-v2')||'null');
        if(old&&Array.isArray(old.history)&&Number.isInteger(old.round)) {
          state.round=old.round;state.carry=old.carry||0;state.events=old.events||0;
          state.entries=[...(old.archive||[]),...old.history.map(e=>({...e,round:old.round}))].map(e=>{
            if(!C.tasks[e.task])throw new Error('Unrecognized earlier task.');
            return {id:crypto.randomUUID(),taskLabel:C.tasks[e.task][0],points:C.tasks[e.task][1],name:e.name||'Not recorded',reference:e.reference||'Not recorded (earlier registration)',time:e.time,round:e.round};
          });
        }
        const p=JSON.parse(localStorage.getItem('stjernetavlen-copenhagen-vote-v1')||'null');
        if(p&&Array.isArray(p.votes)) {
          const votes=p.votes.filter(v=>C.events.some(e=>e.id===v.event));
          state.poll={votes,closed:!!p.closed&&C.events.some(e=>e.id===p.winner),winner:C.events.some(e=>e.id===p.winner)?p.winner:null};
        }
      }
      if(!Array.isArray(state.entries)||!Array.isArray(state.poll.votes))throw new Error('Invalid saved data.');
    } catch(e) {state=C.blank();showError('Saved demo data could not be loaded: '+e.message);}
  }
  function showError(message){$('error').textContent=message;$('error').hidden=false;}
  function toast(message){$('toast').textContent=message;$('toast').style.opacity=1;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').style.opacity=0,3000);}
  function page(name){$('boardPage').hidden=name!=='board';$('eventsPage').hidden=name!=='events';for(const p of ['board','events']){const b=$(p+'Tab');b.classList.toggle('active',name===p);if(name===p)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}}
  $('boardTab').onclick=()=>page('board');$('eventsTab').onclick=()=>page('events');$('chooseEvent').onclick=()=>page('events');
  async function rpc(name,body){
    const headers={'Content-Type':'application/json',apikey:cfg.publishableKey};
    if(cfg.publishableKey.startsWith('eyJ'))headers.Authorization='Bearer '+cfg.publishableKey;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try {
      const response=await fetch(cfg.supabaseUrl.replace(/\/$/,'')+'/rest/v1/rpc/'+name,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal});
      const data=await response.json();
      if(!response.ok)throw new Error(data.message||'The server could not save this change.');
      if(!data||!Array.isArray(data.entries)||!data.poll||!Number.isInteger(data.revision))throw new Error('Unexpected server response. Check the database setup.');
      return data;
    } finally {clearTimeout(timer);}
  }
  function accept(next,celebrateChange=true){
    if(next.revision<state.revision)return;
    const crossed=celebrateChange&&ready&&next.events>state.events;
    state=next;ready=true;render();if(crossed)celebrate();
  }
  async function refresh(initial=false){
    if(!remote||configurationError||refreshing||busy||(!initial&&document.hidden))return;
    refreshing=true;
    try {accept(await rpc('star_read',{p_token:token}),!initial);$('connection').textContent='● Shared board · up to date · auto-refresh every '+Math.max(3,Number(cfg.pollIntervalMs||3000)/1000)+' seconds';}
    catch(e){$('connection').textContent='● Disconnected · changes cannot be saved';if(initial)showError(e.message);}
    finally{refreshing=false;}
  }
  async function mutate(action,data={},id=crypto.randomUUID()){
    if(busy)throw new Error('Please wait for the current change to finish.');
    if(!ready)throw new Error('The board is not connected yet.');
    busy=true;render();$('error').hidden=true;
    try {
      if(remote){const next=await rpc('star_apply',{p_token:token,p_action:action,p_data:data,p_request_id:id});accept(next);$('connection').textContent='● Shared board · saved';}
      else {const next=C.apply(state,action,data,id);localStorage.setItem(demoKey,JSON.stringify(next));accept(next);}
    } finally {busy=false;render();}
  }
  const taskButtons=[];
  C.tasks.forEach(([name,points],i)=>{
    const card=document.createElement('article');card.className='task';const text=document.createElement('div'),h=document.createElement('h3'),s=document.createElement('small'),button=document.createElement('button');h.textContent=name;s.textContent='✦ '+points+' points';text.append(h,s);button.className='register';button.textContent='Register +'+points;button.setAttribute('aria-label','Register '+name);button.onclick=()=>openTask(String(i));card.append(text,button);$('tasks').append(card);taskButtons.push(button);
  });
  function openTask(task){
    if(!ready||busy||C.total(state)>=100)return;
    selected=task;requestId=crypto.randomUUID();$('entryForm').reset();$('formError').hidden=true;
    const custom=task==='custom';$('customFields').hidden=!custom;$('taskTitle').required=custom;$('points').required=custom;
    $('selectedTask').textContent=custom?'Custom task · choose your own points':C.tasks[Number(task)][0]+' · +'+C.tasks[Number(task)][1]+' points';
    $('entry').showModal();$(custom?'taskTitle':'performer').focus();
  }
  $('customTask').onclick=()=>openTask('custom');$('cancelEntry').onclick=()=>$('entry').close();
  $('entryForm').onsubmit=async e=>{
    e.preventDefault();if(busy)return;
    const data={task:selected,title:$('taskTitle').value,points:$('points').value,name:$('performer').value,reference:$('reference').value};
    try {C.registration(data);await mutate('register',data,requestId);$('entry').close();toast('Task registered · points added ✦');}
    catch(error){$('formError').textContent=error.name==='AbortError'?'The request timed out. Retry to check/save the same registration safely.':error.message;$('formError').hidden=false;}
  };
  const eventElements=[];
  C.events.forEach(e=>{
    const card=document.createElement('article');card.className='event';const scene=document.createElement('div');scene.className='scene';scene.style.setProperty('--color',e.color);const icon=document.createElement('span');icon.textContent=e.icon;icon.setAttribute('aria-hidden','true');scene.append(icon);
    const body=document.createElement('div');body.className='event-body';const h=document.createElement('h3');h.textContent=e.title;const p=document.createElement('p');p.textContent=e.description;const a=document.createElement('a');a.className='provider';a.href=e.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=e.provider+' ↗';
    const result=document.createElement('div');result.className='votes';const count=document.createElement('span'),percent=document.createElement('span');result.append(count,percent);const bar=document.createElement('div');bar.className='bar';const fill=document.createElement('span');bar.append(fill);const button=document.createElement('button');button.className='vote';button.onclick=async()=>{try{await mutate('vote',{name:$('voter').value,event:e.id});toast('Your vote is saved ✦');}catch(error){showError(error.message);if(!$('voter').value.trim())$('voter').focus();}};
    body.append(h,p,a,result,bar,button);card.append(scene,body);$('eventCards').append(card);eventElements.push({e,card,count,percent,fill,button});
  });
  function renderPoll(){
    const winner=C.leader(state),votes=state.poll.votes,mine=votes.find(v=>C.normalize(v.name)===C.normalize($('voter').value));
    eventElements.forEach(({e,card,count,percent,fill,button})=>{const n=votes.filter(v=>v.event===e.id).length,p=votes.length?Math.round(n/votes.length*100):0,chosen=mine?.event===e.id;card.classList.toggle('chosen',chosen);count.textContent=n+' vote'+(n===1?'':'s');percent.textContent=p+'%';fill.style.width=p+'%';button.textContent=state.poll.closed?(state.poll.winner===e.id?'✦ Team choice':'Voting closed'):chosen?'✓ Your current vote':mine?'Change my vote →':'Vote for this event →';button.disabled=!ready||busy||state.poll.closed;});
    $('voter').disabled=state.poll.closed||!ready;
    $('voteStatus').textContent=state.poll.closed?'Voting finalized.':mine?'Your vote: '+C.events.find(e=>e.id===mine.event).title:'One favourite per name.';
    $('pollSummary').textContent=votes.length+' votes cast · '+(winner?winner.title+(state.poll.closed?' is confirmed.':' is leading.'):votes.length?'The vote is tied.':'Waiting for votes.');
    $('finalize').hidden=state.poll.closed;$('finalize').disabled=!ready||busy||!winner;$('reopen').hidden=!state.poll.closed;$('reopen').disabled=busy||!ready;
    $('rewardTitle').textContent=winner?winner.icon+' '+winner.title:'✧ A social team event';$('rewardDescription').textContent=winner?(state.poll.closed?'Team choice confirmed':'Current favourite · voting open')+' · '+winner.type+' in Copenhagen.':votes.length?'The vote is tied. A clear leader will appear here automatically.':'Vote for the experience you would love to share.';
    $('partyReward').textContent=winner?(state.poll.closed?'Your chosen event: ':'Current favourite: ')+winner.title:'Choose the activity on the event voting page.';
  }
  $('voter').oninput=renderPoll;
  for(const [id,action]of [['finalize','finalize'],['reopen','reopen'],['next','next']])$(id).onclick=async()=>{try{await mutate(action);toast(action==='next'?'New round started — your log is kept.':'Event vote updated.');}catch(e){showError(e.message);}};
  $('undo').onclick=()=>{pendingUndo=state.entries.at(-1)?.id;if(!pendingUndo)return;const last=state.entries.at(-1);$('undoDescription').textContent=last.taskLabel+' · '+last.name+' · '+last.points+' points';$('undoDialog').showModal();};$('cancelUndo').onclick=()=>$('undoDialog').close();
  $('confirmUndo').onclick=async()=>{try{await mutate('undo',{id:pendingUndo});$('undoDialog').close();toast('Registration removed.');}catch(e){$('undoDialog').close();showError(e.message);}};
  function cell(row,text,cls){const td=document.createElement('td');td.textContent=text;if(cls)td.className=cls;row.append(td);return td;}
  let logSignature='';
  function renderLog(){
    const signature=ready+':'+state.revision+':'+state.entries.length;if(logSignature===signature)return;logSignature=signature;
    $('logCount').textContent=state.entries.length+' registered tasks · All rounds · Most recent first';$('history').replaceChildren();
    if(!state.entries.length){const empty=document.createElement('div');empty.className='empty';empty.textContent=ready?'No tasks registered yet. Your references and performers will appear here.':'Connect to the team board to load its task log.';$('history').append(empty);return;}
    const table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');for(const title of ['Date & time','Task performed','Reference / comment','Performed by','Points','Round']){const th=document.createElement('th');th.scope='col';th.textContent=title;tr.append(th);}head.append(tr);table.append(head);const body=document.createElement('tbody');
    [...state.entries].reverse().forEach(e=>{const row=document.createElement('tr');cell(row,new Date(e.time).toLocaleString('en-GB'));cell(row,e.taskLabel,'task-name');cell(row,e.reference,'ref');cell(row,e.name,'name');const b=document.createElement('b');b.textContent='+'+e.points+' ✦';cell(row,'').append(b);cell(row,String(e.round));body.append(row);});table.append(body);$('history').append(table);
  }
  function render(){
    const n=C.total(state),won=n>=100;$('round').textContent='Team points · Round '+state.round;$('score').textContent=ready?n:'—';$('fill').style.width=(ready?Math.min(n,100):0)+'%';document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow',Math.min(n,100));$('remaining').textContent=!ready?'Waiting for connection':won?'100 points reached — the stars are yours!':100-n+' points until the star shower';$('eventsEarned').textContent=state.events+' team events earned';$('encourage').textContent=won?'A shared effort deserves a shared celebration.':'Every completed task brings your next team event closer.';$('earned').hidden=!ready||!won;$('carry').textContent=(n>100?n-100+' extra points will carry over. ':'')+'Start the next round when you are ready. Your full log is kept.';
    [...taskButtons,$('customTask')].forEach(b=>b.disabled=!ready||busy||won);$('submitEntry').disabled=busy;$('cancelEntry').disabled=busy;$('next').disabled=busy;$('confirmUndo').disabled=busy;$('undo').disabled=!ready||busy||!state.entries.length||state.entries.at(-1).round!==state.round;renderPoll();renderLog();
  }
  function celebrate(){
    if($('entry').open)$('entry').close();if($('undoDialog').open)$('undoDialog').close();if($('party').open)return;
    $('rain').replaceChildren();$('party').showModal();if(!matchMedia('(prefers-reduced-motion: reduce)').matches)for(let i=0;i<55;i++){const s=document.createElement('span');s.className='falling';s.textContent='✦';s.style.left=Math.random()*100+'%';s.style.fontSize=15+Math.random()*24+'px';s.style.animationDelay=Math.random()*2+'s';$('rain').append(s);}clearTimeout(partyTimer);partyTimer=setTimeout(()=>$('rain').replaceChildren(),7500);
  }
  $('replay').onclick=celebrate;$('closeParty').onclick=()=>$('party').close();$('party').addEventListener('close',()=>{clearTimeout(partyTimer);$('rain').replaceChildren();});
  $('copyLink').hidden=!remote||!!configurationError;$('copyLink').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);toast('Team link copied. Anyone with it can view and update this board.');}catch(e){showError('Copy the complete address from your browser, including #board=.');}};
  $('modeNote').textContent=remote?'Everyone with the full team link can view and update this board. Names are self-reported. Updates refresh automatically every few seconds. Events must be booked by the team.':'Local demo: data is saved in this browser only. The team link and automatic updates across computers become available after database and hosting setup.';
  render();
  if(remote){if(configurationError){showError(configurationError);$('connection').textContent='● Setup needed';}else{await refresh(true);setInterval(()=>refresh(),Math.max(3000,Number(cfg.pollIntervalMs)||3000));document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});}}
  else {$('connection').textContent='● Local demo · not shared';window.addEventListener('storage',e=>{if(e.key===demoKey&&e.newValue){try{const s=JSON.parse(e.newValue);accept(s);}catch{showError('Saved demo data could not be read.');}}});}
})();
